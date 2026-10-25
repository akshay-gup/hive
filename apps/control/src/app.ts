import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { type Account, Accounts } from "./accounts.ts";
import type { ControlConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { type GatewaySettings, ModelGateway } from "./gateway.ts";
import { RateLimiter, type SignInLimiter } from "./limits.ts";
import { MachineConfigs } from "./machine-config.ts";
import { consoleMailer, type Mailer } from "./mailer.ts";
import type { Provisioner } from "./provisioner.ts";
import { Releases } from "./releases.ts";
import type { SigningKeys } from "./signing.ts";
import type { ControlStore } from "./store.ts";
import { WorkspaceService, type WorkspaceServiceOptions } from "./workspaces.ts";

export interface ControlDeps {
  provisioner: Provisioner;
  keys: SigningKeys;
  mailer?: Mailer;
  /** Signs people in with Google; without it only a sample control plane has a way to sign in. */
  google?: GoogleLogin;
  /** Counts sign-in attempts per visitor. Left out, each process counts for itself. */
  signInLimiter?: SignInLimiter;
  /** Lets workspaces use the model without holding its key; without it each workspace is given its own settings. */
  gateway?: GatewaySettings;
  /** See `WorkspaceServiceOptions`: where making a workspace is started, when not in this process. */
  startProvisioning?: WorkspaceServiceOptions["startProvisioning"];
  /** For tests: the `fetch` that tells a workspace a person's sessions are over. */
  fetch?: typeof fetch;
}

/** What the sign-in routes need of Google; src/google.ts is the real one. */
export interface GoogleLogin {
  /** Where to send the person, and remember `origin` for when they come back. */
  loginUrl(origin?: string): Promise<{ url: string }>;
  /** Finish a sign-in Google has redirected back from. */
  loginCallback(
    state: string,
    code: string,
  ): Promise<{ sub: string; email: string; name?: string; origin?: string }>;
}

const idParam = z.string().min(1).max(64);

/** Whether two secrets are the same, in a time that tells nothing of how much of one is right. */
const sameSecret = (given: string | undefined, expected: string) =>
  timingSafeEqual(
    createHash("sha256")
      .update(given ?? "")
      .digest(),
    createHash("sha256").update(expected).digest(),
  );

export function createControlApp(db: ControlStore, config: ControlConfig, deps: ControlDeps) {
  const accounts = new Accounts(db);
  // Where invite links open: the web app, which is a site of its own on Cloudflare.
  const appUrl = config.appUrl ?? config.publicUrl;
  const releases = new Releases(db);
  const gateway = deps.gateway
    ? new ModelGateway(
        db,
        config.publicUrl,
        deps.keys.privateKey,
        deps.gateway,
        deps.gateway.limiter ?? new RateLimiter(120),
      )
    : undefined;
  const machineConfigs = new MachineConfigs(
    db,
    gateway ? (id) => gateway.environmentFor(id) : undefined,
  );
  const workspaces = new WorkspaceService({
    db,
    accounts,
    provisioner: deps.provisioner,
    mailer: deps.mailer ?? consoleMailer,
    keys: deps.keys,
    publicUrl: config.publicUrl,
    appUrl,
    allowedOrigins: config.allowedOrigins,
    maxWorkspacesPerAccount: config.maxWorkspacesPerAccount,
    modelEnvironment: gateway ? (id) => gateway.environmentFor(id) : undefined,
    startProvisioning: deps.startProvisioning,
    chat: config.chatUrl
      ? { url: config.chatUrl, internalUrl: config.chatInternalUrl ?? config.chatUrl }
      : undefined,
    fetch: deps.fetch,
  });
  const origins = new Set([new URL(config.publicUrl).origin, ...config.allowedOrigins]);

  const app = new Hono<{ Variables: { account: Account } }>();
  // An invite link made before links pointed at the web app points here. Where the web app is a
  // site of its own, the link goes on to it; where this server is the web app, it is served as a page.
  if (appUrl !== config.publicUrl)
    app.get("/join/:token", (c) =>
      c.redirect(`${appUrl}/join/${encodeURIComponent(c.req.param("token"))}`, 302),
    );
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  const limitBody = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "Too large" }, 413),
  });
  // A model request carries the whole conversation, so it is not held to this size: the gateway passes it on (reading it only for the model it names).
  app.use("*", (c, next) => (c.req.path.startsWith("/v1/gateway/") ? next() : limitBody(c, next)));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    console.error(`[Hive control] ${error.name}: ${error.message}`);
    return c.json({ error: "Something went wrong. Try again." }, 500);
  });

  // What the app needs to know before anyone has signed in: which ways in there are.
  app.get("/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      google: Boolean(deps.google),
      provisioner: deps.provisioner.name,
    }),
  );

  // A workspace's way to the model. It is signed with the workspace's own key, not a person's session.
  if (gateway)
    app.all("/v1/gateway/:provider/*", (c) =>
      gateway.handle(c.req.raw, c.req.param("provider") ?? ""),
    );

  // The edge proxy asks where a workspace is. It is not for people: it takes the edge's own token.
  app.get("/internal/upstream/:id", async (c) => {
    if (!config.edgeToken) return c.json({ error: "Not found" }, 404);
    if (!sameSecret(c.req.header("authorization"), `Bearer ${config.edgeToken}`))
      return c.json({ error: "Unauthorized" }, 401);
    const found = await workspaces.upstream(idParam.parse(c.req.param("id")));
    if (!found.known) return c.json({ error: "No such workspace" }, 404);
    if (!found.upstream) return c.json({ error: "The workspace is not running" }, 503);
    return c.json({ upstream: found.upstream });
  });

  // Which build of the workspace a machine should run. A machine asks for its own workspace by id and
  // is told a public image's tag and digest (nothing secret), or nothing, which means stay as it is.
  const askers = new RateLimiter(120);
  app.get("/v1/release/:id", async (c) => {
    if (!(await askers.allow(visitorOf(c)))) return c.json({ error: "Too many requests" }, 429);
    const id = idParam.parse(c.req.param("id"));
    // Which revision of its settings it is to be on rides along (nothing secret: a short name), for
    // whoever watches a workspace; the workspace itself asks for its settings (below).
    return c.json({
      ...(await releases.wantedFor(id)),
      config: await machineConfigs.answerFor(id),
    });
  });
  // The workspace's settings, which it asks for when it starts and now and then after. They carry its
  // key to the model gateway, so only the workspace they are for may have them, and it proves it with
  // that key. `rev` changes whenever anything in them does.
  app.get("/v1/release/:id/config", async (c) => {
    if (!(await askers.allow(visitorOf(c)))) return c.json({ error: "Too many requests" }, 429);
    const id = idParam.parse(c.req.param("id"));
    const header = c.req.header("authorization");
    const given = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!gateway || gateway.workspaceOf(given) !== id)
      return c.json({ error: "Unauthorized" }, 401);
    return c.json(await machineConfigs.documentFor(id));
  });

  // The agent's machine asks for the token it connects to the chat service with. Like its settings, it is
  // for the workspace alone, which proves it with its key; the token names no person.
  app.post("/v1/release/:id/runner-token", async (c) => {
    if (!(await askers.allow(visitorOf(c)))) return c.json({ error: "Too many requests" }, 429);
    const id = idParam.parse(c.req.param("id"));
    const header = c.req.header("authorization");
    const given = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!gateway || gateway.workspaceOf(given) !== id)
      return c.json({ error: "Unauthorized" }, 401);
    return c.json(await workspaces.runnerToken(id));
  });

  // The chat service asks for a workspace's machine to be started, because the agent was mentioned while
  // it was stopped. It proves it is the chat service with a key only the two of them hold, over a time and
  // the workspace's id, so one request cannot be played again later or for another workspace.
  const wakers = new RateLimiter(6);
  app.post("/internal/chat/wake/:id", async (c) => {
    if (!config.chatWakeKey) return c.json({ error: "Not found" }, 404);
    const id = idParam.parse(c.req.param("id"));
    const at = Number(c.req.header("x-hive-at"));
    const mac = c.req.header("x-hive-mac") ?? "";
    const expected = createHmac("sha256", config.chatWakeKey)
      .update(`wake\n${id}\n${c.req.header("x-hive-at") ?? ""}`)
      .digest("hex");
    if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 60_000 || !sameSecret(mac, expected))
      return c.json({ error: "Unauthorized" }, 401);
    if (!(await wakers.allow(id))) return c.json({ error: "Too many requests" }, 429);
    return c.json(await workspaces.wakeForChat(id));
  });

  // Publishing a build, for CI and an operator. They show the release token; without one there is no
  // such route.
  const release = new Hono();
  release.use("*", async (c, next) => {
    if (!config.releaseToken) return c.json({ error: "Not found" }, 404);
    if (!sameSecret(c.req.header("authorization"), `Bearer ${config.releaseToken}`))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  release.get("/", async (c) => c.json(await releases.overview()));
  // What a push to main publishes: the build every workspace without one of its own should run.
  release.put("/", async (c) => c.json(await releases.publish(await c.req.json())));
  release.put("/paused", async (c) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(await c.req.json());
    return c.json(await releases.pause(paused));
  });
  release.put("/workspaces/:id", async (c) =>
    c.json(await releases.pin(idParam.parse(c.req.param("id")), await c.req.json())),
  );
  release.delete("/workspaces/:id", async (c) => {
    await releases.unpin(idParam.parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  // Settings: what to change in the settings workspaces were made with. What is set for everyone, and
  // for one workspace over that; a machine takes them up on its next check (see hive-update).
  release.get("/config", async (c) => c.json(await machineConfigs.overview()));
  release.put("/config", async (c) => c.json(await machineConfigs.setDefault(await c.req.json())));
  release.put("/config/workspaces/:id", async (c) =>
    c.json(await machineConfigs.setWorkspace(idParam.parse(c.req.param("id")), await c.req.json())),
  );
  release.delete("/config/workspaces/:id", async (c) => {
    await machineConfigs.clearWorkspace(idParam.parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  // What a workspace is told, without the values: its revision and the names of what it changes.
  release.get("/config/workspaces/:id", async (c) => {
    const doc = await machineConfigs.documentFor(idParam.parse(c.req.param("id")));
    return c.json({
      v: doc.v,
      rev: doc.rev,
      set: Object.keys(doc.env).filter((k) => doc.env[k] !== null),
      unset: Object.keys(doc.env).filter((k) => doc.env[k] === null),
    });
  });
  app.route("/internal/release", release);

  // Signing in. These are public: they are how a person gets a session.
  const signIns = deps.signInLimiter ?? new RateLimiter(20);
  const visitorOf = (c: Context): string => {
    const forwarded = config.clientIpHeader ? c.req.header(config.clientIpHeader)?.trim() : "";
    if (forwarded) return forwarded.slice(0, 64);
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  const limitSignIns = async (c: Context) => {
    if (!(await signIns.allow(visitorOf(c))))
      throw new HttpError("Too many sign-in attempts. Try again in a minute.", 429);
  };
  const sessionFor = async (account: Account) => ({
    token: await accounts.startSession(account.id),
    account: { id: account.id, email: account.email, name: account.name },
  });
  app.post("/v1/auth/dev", async (c) => {
    if (config.mode !== "sample") throw new HttpError("Sign in with Google", 404);
    await limitSignIns(c);
    const body = z
      .object({ email: z.string().max(320), name: z.string().max(100).optional() })
      .parse(await c.req.json());
    return c.json(await sessionFor(await accounts.upsert(body)));
  });
  app.post("/v1/auth/exchange", async (c) => {
    await limitSignIns(c);
    const { code } = z.object({ code: z.string().min(1).max(200) }).parse(await c.req.json());
    const { token, account } = await accounts.exchangeLoginCode(code);
    return c.json({ token, account: { id: account.id, email: account.email, name: account.name } });
  });
  app.get("/v1/auth/google/url", async (c) => {
    if (!deps.google) throw new HttpError("Google sign-in is not set up", 503);
    await limitSignIns(c);
    // The page that opened the sign-in is handed the result, so it has to be one of ours.
    const origin = c.req.query("origin") || undefined;
    if (origin && !origins.has(origin)) throw new HttpError("Origin is not allowed", 403);
    return c.json(await deps.google.loginUrl(origin));
  });
  app.get("/v1/auth/google/callback", async (c) => {
    if (!deps.google) throw new HttpError("Google sign-in is not set up", 503);
    await limitSignIns(c);
    if (c.req.query("error"))
      return c.html("<h1>Sign-in cancelled</h1><p>You can return to Hive.</p>", 400);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) throw new HttpError("Google sign-in is incomplete");
    const profile = await deps.google.loginCallback(state, code);
    const account = await accounts.upsert({
      email: profile.email,
      name: profile.name,
      googleSub: profile.sub,
    });
    const loginCode = await accounts.mintLoginCode(account.id);
    const target = profile.origin ? JSON.stringify(profile.origin) : "null";
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>Hive sign-in</title></head>` +
        `<body><h1>Signed in to Hive</h1><p>You can return to the app.</p><script>` +
        `(function(){var code=${JSON.stringify(loginCode)},target=${target};` +
        `if(window.opener&&target){window.opener.postMessage({hiveAuthCode:code},target);` +
        `setTimeout(function(){window.close();},400);}` +
        `else{window.location.replace("hive://auth?code="+encodeURIComponent(code));}})();` +
        `</script></body></html>`,
    );
  });
  /** Public: what an invitation link is for, so the page can say so before anyone signs in. */
  // The key workspaces and the chat service check this control plane's tokens with. It is public: it only verifies.
  app.get("/v1/public-key", (c) => c.json({ publicKey: deps.keys.publicKey }));
  app.get("/v1/invites/:token", async (c) =>
    c.json(await workspaces.previewInvite(idParam.parse(c.req.param("token")))),
  );

  // Everything else needs a session.
  const secure = new Hono<{ Variables: { account: Account } }>();
  secure.use("*", async (c, next) => {
    c.set("account", await accounts.accountFor(c.req.header("authorization")));
    await next();
  });
  secure.post("/auth/logout", async (c) => {
    await accounts.endSession(c.req.header("authorization"));
    return c.json({ ok: true });
  });
  secure.get("/me", async (c) => {
    const account = c.get("account");
    return c.json({
      account: { id: account.id, email: account.email, name: account.name },
      workspaces: await workspaces.list(account),
    });
  });
  // Deleting the account: out of every workspace first (an owner must delete theirs, which is a 409
  // here), then the account and its sessions.
  secure.delete("/account", async (c) => {
    const account = c.get("account");
    await workspaces.removePerson(account);
    await accounts.remove(account.id);
    return c.json({ ok: true });
  });
  secure.post("/workspaces", async (c) => {
    const { name } = z.object({ name: z.string().max(200) }).parse(await c.req.json());
    return c.json(await workspaces.create(c.get("account"), name), 201);
  });
  secure.get("/workspaces/:id", async (c) =>
    c.json(await workspaces.view(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  // The chat service: a token for it, which does not need the workspace's machine to be running.
  secure.post("/workspaces/:id/chat-token", async (c) =>
    c.json(await workspaces.chatToken(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  secure.post("/workspaces/:id/token", async (c) =>
    c.json(await workspaces.token(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  secure.post("/workspaces/:id/wake", async (c) =>
    c.json(await workspaces.wake(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  secure.post("/workspaces/:id/retry", async (c) =>
    c.json(await workspaces.retry(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  secure.delete("/workspaces/:id", async (c) => {
    await workspaces.remove(c.get("account"), idParam.parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  secure.get("/workspaces/:id/members", async (c) =>
    c.json(await workspaces.members(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  secure.patch("/workspaces/:id/members/:accountId", async (c) => {
    const { role } = z
      .object({ role: z.enum(["admin", "member", "guest"]) })
      .parse(await c.req.json());
    await workspaces.setRole(
      c.get("account"),
      idParam.parse(c.req.param("id")),
      idParam.parse(c.req.param("accountId")),
      role,
    );
    return c.json({ ok: true });
  });
  secure.delete("/workspaces/:id/members/:accountId", async (c) => {
    await workspaces.removeMember(
      c.get("account"),
      idParam.parse(c.req.param("id")),
      idParam.parse(c.req.param("accountId")),
    );
    return c.json({ ok: true });
  });
  secure.get("/workspaces/:id/invites", async (c) =>
    c.json(await workspaces.invites(c.get("account"), idParam.parse(c.req.param("id")))),
  );
  secure.post("/workspaces/:id/invites", async (c) => {
    const body = z
      .object({
        email: z.string().max(320).optional(),
        role: z.enum(["admin", "member", "guest"]).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      await workspaces.createInvite(c.get("account"), idParam.parse(c.req.param("id")), body),
      201,
    );
  });
  secure.delete("/workspaces/:id/invites/:inviteId", async (c) => {
    await workspaces.revokeInvite(
      c.get("account"),
      idParam.parse(c.req.param("id")),
      idParam.parse(c.req.param("inviteId")),
    );
    return c.json({ ok: true });
  });
  secure.post("/invites/:token/accept", async (c) =>
    c.json(await workspaces.acceptInvite(c.get("account"), idParam.parse(c.req.param("token")))),
  );
  app.route("/v1", secure);

  return { app, accounts, workspaces, gateway };
}
