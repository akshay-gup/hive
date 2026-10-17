import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { randomBytes } from "node:crypto";
import { workspacePublicKeyOf } from "../../../packages/integrations/src/workspace-token.ts";
import { createControlApp } from "./app.ts";
import { readControlConfig } from "./config.ts";
import { type D1Database, D1Store } from "./d1-store.ts";
import { GoogleSignIn } from "./google.ts";
import { RateLimiter, type SignInLimiter } from "./limits.ts";
import { remoteProvisionerFromEnv } from "./provisioners-remote.ts";

/**
 * The control plane on Cloudflare: the same app as the Node server, with its records in D1, its
 * sign-in limit shared by every copy, and making a workspace done by a Workflow, since a request
 * cannot keep working after it has answered. A timer finds what a Workflow did not finish.
 *
 * Settings are the same variables as the Node server's (CONTROL_PUBLIC_URL, GOOGLE_CLIENT_ID,
 * PROVISIONER, DO_*, …), as `vars` and secrets. CONTROL_SIGNING_KEY is required: there is no disk
 * to keep one on, and every copy must sign alike.
 */
export interface Env {
  DB: D1Database;
  PROVISION: {
    create(options: { id: string; params: { workspaceId: string } }): Promise<unknown>;
  };
  /** A Cloudflare rate limit binding, for the sign-in limit. Without it each copy counts alone. */
  SIGNIN_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const settings = (env: Env) => env as unknown as Record<string, string | undefined>;

function build(env: Env) {
  const vars = settings(env);
  const config = readControlConfig(vars);
  const privateKey = vars.CONTROL_SIGNING_KEY?.trim();
  if (!privateKey) throw new Error("Set CONTROL_SIGNING_KEY: a Worker has nowhere to keep one");
  const provisioner = remoteProvisionerFromEnv(vars);
  if (!provisioner) throw new Error("Set PROVISIONER to fly or digitalocean");
  const db = new D1Store(env.DB);
  const google =
    config.googleClientId && config.googleClientSecret
      ? new GoogleSignIn(db, {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          redirectUri: config.googleRedirectUri,
        })
      : undefined;
  const shared = env.SIGNIN_LIMITER;
  const signInLimiter: SignInLimiter = shared
    ? { allow: async (key) => (await shared.limit({ key })).success }
    : new RateLimiter(20);
  return createControlApp(db, config, {
    provisioner,
    keys: { privateKey, publicKey: workspacePublicKeyOf(privateKey) },
    google,
    signInLimiter,
    // Not started in the request, which would end it: a Workflow instance makes the workspace.
    startProvisioning: async (workspaceId) => {
      await env.PROVISION.create({
        id: `${workspaceId}-${randomBytes(4).toString("hex")}`,
        params: { workspaceId },
      });
    },
  });
}

// One per copy of the Worker, made on first use and kept while it lives.
let control: ReturnType<typeof build> | undefined;
const runtime = (env: Env) => {
  control ??= build(env);
  return control;
};

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    return runtime(env).app.fetch(request, env, ctx as never);
  },
  /**
   * Every minute: start what no one is making, and finish removals that did not finish. Every
   * tenth minute, sweep away the sign-ins and sessions that have expired, which is no hurry.
   */
  async scheduled(
    event: { scheduledTime: number },
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const { workspaces, accounts } = runtime(env);
    ctx.waitUntil(workspaces.resume());
    if (new Date(event.scheduledTime).getUTCMinutes() % 10 === 0)
      ctx.waitUntil(
        accounts
          .sweep()
          .catch((error) =>
            console.error(`[Hive control] could not sweep expired sign-ins: ${error}`),
          ),
      );
  },
};

/**
 * Makes one workspace, however long the provider takes. Several may be started for the same one
 * (the request and the timer); only the one that gets the workspace's lease does the work.
 */
export class ProvisionWorkspace extends WorkflowEntrypoint<Env, { workspaceId: string }> {
  async run(event: WorkflowEvent<{ workspaceId: string }>, step: WorkflowStep) {
    const { workspaceId } = event.payload;
    await step.do(
      "make the workspace",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" },
      () => runtime(this.env).workspaces.provisionNow(workspaceId),
    );
  }
}
