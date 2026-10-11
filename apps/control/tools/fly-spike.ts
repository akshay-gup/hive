/**
 * Tries the Fly provisioner against a real Fly account, with a real workspace image, and reports
 * what it found: how long a workspace takes to make, to wake, whether it keeps its data across
 * a stop, and whether everything is cleaned up. It makes one workspace of its own and removes it.
 *
 *   FLY_API_TOKEN=… FLY_ORG=… FLY_IMAGE=registry.fly.io/…:tag pnpm exec tsx apps/control/tools/fly-spike.ts
 *
 * It needs no control plane: it signs a person in to the workspace with a key of its own.
 */
import { pathToFileURL } from "node:url";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
} from "../../../packages/integrations/src/workspace-token.ts";
import { FlyProvisioner as Fly, type FlyProvisioner, flyConfigFromEnv } from "../src/fly.ts";
import { plans } from "../src/plans.ts";
import { recorder, type SpikeReport, type SpikeStep } from "./spike-report.ts";

export type { SpikeReport, SpikeStep };

/** What the spike does inside the workspace, apart from Fly: sign in, leave something, look for it again. */
export interface WorkspaceProbe {
  /** Sign in with a token the spike signed, and keep something in the workspace. */
  write(url: string, token: string): Promise<void>;
  /** Sign in again, and say whether what was kept is still there. */
  read(url: string, token: string): Promise<boolean>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A probe against a real workspace server: it keeps a channel, and looks for it. */
export function httpProbe(fetcher: typeof fetch = fetch): WorkspaceProbe {
  const signIn = async (url: string, token: string) => {
    const response = await fetcher(`${url}/api/auth/managed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error(`sign-in answered ${response.status}`);
    return ((await response.json()) as { token: string }).token;
  };
  return {
    async write(url, token) {
      const session = await signIn(url, token);
      const made = await fetcher(`${url}/api/agent/channels`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "kept-by-the-spike" }),
      });
      if (made.status !== 201) throw new Error(`making a channel answered ${made.status}`);
    },
    async read(url, token) {
      const session = await signIn(url, token);
      const listed = await fetcher(`${url}/api/agent/channels`, {
        headers: { Authorization: `Bearer ${session}` },
      });
      if (!listed.ok) throw new Error(`listing channels answered ${listed.status}`);
      const channels = (await listed.json()) as { name: string }[];
      return channels.some((channel) => channel.name === "kept-by-the-spike");
    },
  };
}

export async function runSpike(options: {
  provisioner: FlyProvisioner;
  probe: WorkspaceProbe;
  workspaceId?: string;
  /** Leave the workspace running afterwards, to look at it. */
  keep?: boolean;
  log?: (line: string) => void;
  fetcher?: typeof fetch;
}): Promise<SpikeReport> {
  const { provisioner, probe, log = () => {} } = options;
  const fetcher = options.fetcher ?? fetch;
  const workspaceId =
    options.workspaceId ??
    `wspike${Math.random()
      .toString(36)
      .slice(2, 7)
      .replace(/[^a-z0-9]/g, "x")}`;
  const keys = generateWorkspaceKeys();
  const token = () =>
    signWorkspaceToken(keys.privateKey, {
      workspaceId,
      sub: "acct_spike",
      email: "spike@example.invalid",
      name: "Spike",
      role: "owner",
    });
  const { report, step } = recorder(workspaceId, log);

  try {
    const spec = {
      workspaceId,
      name: "Spike",
      plan: plans.free,
      controlPublicKey: keys.publicKey,
      allowedOrigins: ["https://spike.invalid"],
    };
    const { url } = await step("create: app, addresses, volume, machine, first answer", () =>
      provisioner.create(spec),
    );
    report.url = url;
    await step("create again: comes back with the same address", async () => {
      const again = await provisioner.create(spec);
      if (again.url !== url) throw new Error(`it answered at ${again.url}, not ${url}`);
    });
    await step(
      "state after create",
      () => provisioner.state(workspaceId),
      (state) => state,
    );
    await step("sign in and keep a channel", () => probe.write(url, token()));

    await step("stop the machine", () => provisioner.stop(workspaceId));
    await step(
      "state after stop",
      async () => provisioner.state(workspaceId),
      (state) => state,
    );
    // What a person's first request meets when the machine was stopped to save money: Fly's proxy starts it.
    await step("the address wakes it by itself (autostart)", async () => {
      const until = Date.now() + 120_000;
      for (;;) {
        const response = await fetcher(`${url}/api/health`).catch(() => null);
        if (response?.ok) return;
        if (Date.now() > until) throw new Error("it did not answer in 120s");
        await sleep(500);
      }
    });

    await step("stop it again", () => provisioner.stop(workspaceId));
    await step("wake it, as the control plane does, and wait for its first answer", () =>
      provisioner.wake(workspaceId),
    );
    await step("what was kept is still there after the stop and start", async () => {
      if (!(await probe.read(url, token()))) throw new Error("the channel was not there");
    });
  } catch {
    // Reported above; the rest is cleaning up.
  } finally {
    if (!options.keep)
      await step("destroy: machine, volume and app", () => provisioner.destroy(workspaceId)).catch(
        () => {},
      );
    if (!options.keep)
      await step("nothing is left", async () => {
        const state = await provisioner.state(workspaceId);
        if (state !== "missing") throw new Error(`the workspace is still there (${state})`);
      }).catch(() => {});
  }
  return report;
}

async function main() {
  const provisioner = new Fly(flyConfigFromEnv());
  const keep = process.argv.includes("--keep");
  console.log(`Trying Fly with ${provisioner.name}; this makes one workspace and removes it.`);
  const report = await runSpike({
    provisioner,
    probe: httpProbe(),
    keep,
    log: (line) => console.log(line),
  });
  console.log(report.ok ? "\nAll steps passed." : "\nSome steps failed; see above.");
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
