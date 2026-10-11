/**
 * Tries the DigitalOcean provisioner against a real account and a real workspace image, and reports
 * what it found: how long a workspace takes to make, to stop and to wake, whether it keeps its data
 * across a stop, how many calls to DigitalOcean that took, whether the firewall is on, and whether
 * everything is cleaned up. It makes one workspace of its own, under names of its own so that it
 * touches nothing else, and removes it.
 *
 *   DO_API_TOKEN=… DO_IMAGE=<the id do-image.ts printed> \
 *   DO_EDGE_ADDRESSES=$(curl -s https://api.ipify.org)/32 \
 *   pnpm exec tsx apps/control/tools/do-spike.ts
 *
 * It needs no control plane and no edge. It waits for the workspace at the Droplet's public address,
 * which the firewall it makes opens to this machine's address (DO_EDGE_ADDRESSES), and signs a
 * person in there with a key of its own. DO_REGION, DO_SIZE, DO_SSH_KEYS and DO_VPC_UUID are
 * read as they are by the control plane.
 */
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
} from "../../../packages/integrations/src/workspace-token.ts";
import { DigitalOceanProvisioner, digitalOceanConfigFromEnv } from "../src/digitalocean.ts";
import { DigitalOceanApi } from "../src/digitalocean-api.ts";
import { sleep } from "../src/http.ts";
import { plans } from "../src/plans.ts";
import { httpProbe, type WorkspaceProbe } from "./fly-spike.ts";
import { recorder, type SpikeReport } from "./spike-report.ts";

/** What the spike's names all start with, so that it finds its own firewall and Droplet and nobody else's. */
export const SPIKE_PREFIX = "hivespike";

/** Counts the calls made to DigitalOcean, and the least the hourly allowance has had left. */
export function countCalls(apiUrl: string) {
  const original = globalThis.fetch;
  let calls = 0;
  let remaining: number | undefined;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const response = await original(input, init);
    if (String(input).startsWith(apiUrl)) {
      calls++;
      const left = Number(response.headers.get("ratelimit-remaining"));
      if (response.headers.has("ratelimit-remaining") && Number.isFinite(left))
        remaining = remaining === undefined ? left : Math.min(remaining, left);
    }
    return response;
  }) as typeof fetch;
  return {
    calls: () => calls,
    remaining: () => remaining,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Whether nothing answers a connection to this address and port within the time. */
export function portIsClosed(host: string, port: number, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(ms, () => done(true));
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
  });
}

/** Removes the spike's own firewall, if there is one: left by a run that did not finish, it would not open to this machine. */
async function removeFirewall(api: DigitalOceanApi): Promise<number> {
  const name = `${SPIKE_PREFIX}-workspaces`;
  const firewalls = (await api.all<{ id: string; name: string }>("/firewalls", "firewalls")).filter(
    (firewall) => firewall.name === name,
  );
  for (const firewall of firewalls)
    await api.call("DELETE", `/firewalls/${firewall.id}`, undefined, [404]);
  return firewalls.length;
}

export async function runDigitalOceanSpike(options: {
  provisioner: DigitalOceanProvisioner;
  probe: WorkspaceProbe;
  api: DigitalOceanApi;
  workspaceId?: string;
  /** Leave the workspace running afterwards, to look at it. */
  keep?: boolean;
  log?: (line: string) => void;
  /** The number of calls made to DigitalOcean so far, to say what each step cost. */
  calls?: () => number;
  /** Whether a port on an address is closed to this machine; the real check connects. */
  closed?: (host: string, port: number) => Promise<boolean>;
  /** How long a removed Droplet may still be listed before it counts as left behind (90 when unset). */
  leftoverSeconds?: number;
}): Promise<SpikeReport> {
  const { provisioner, probe, api, log = () => {} } = options;
  const calls = options.calls ?? (() => 0);
  const closed = options.closed ?? portIsClosed;
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
  /** What a step cost in calls to DigitalOcean, for the note. */
  const costing = async <T>(run: () => Promise<T>) => {
    const before = calls();
    const value = await run();
    return { value, cost: calls() - before };
  };

  try {
    const stale = await removeFirewall(api);
    if (stale) log(`  (removed a firewall an earlier run left)`);
    const spec = {
      workspaceId,
      name: "Spike",
      plan: plans.free,
      controlPublicKey: keys.publicKey,
      allowedOrigins: ["https://spike.invalid"],
    };
    const made = await step(
      "create: firewall, Droplet from the image, first boot, first answer",
      () => costing(() => provisioner.create(spec)),
      ({ cost }) => `${cost} calls to DigitalOcean`,
    );
    report.url = made.value.url;
    await step("create again: comes back with the same address", async () => {
      const again = await provisioner.create(spec);
      if (again.url !== made.value.url)
        throw new Error(`it answered at ${again.url}, not ${made.value.url}`);
    });
    await step(
      "state after create",
      async () => {
        const state = await provisioner.state(workspaceId);
        if (state !== "running") throw new Error(`it is ${state}`);
        return state;
      },
      (state) => state,
    );
    const address = await provisioner.upstream(workspaceId);
    if (!address) throw new Error("the Droplet has no address to reach it at");
    const host = new URL(address).hostname;

    await step(
      "the firewall is on: ssh is closed to this machine, though the workspace is open",
      async () => {
        if (!(await closed(host, 22))) throw new Error(`port 22 on ${host} answers`);
      },
    );
    await step("sign in and keep a channel", () => probe.write(address, token()));

    await step(
      "stop: shut the Droplet down",
      () => costing(() => provisioner.stop(workspaceId)),
      ({ cost }) => `${cost} calls`,
    );
    await step(
      "state after stop",
      async () => {
        const state = await provisioner.state(workspaceId);
        if (state !== "stopped") throw new Error(`it is ${state}`);
        return state;
      },
      (state) => state,
    );
    await step(
      "wake: power on and wait for the first answer",
      () => costing(() => provisioner.wake(workspaceId)),
      ({ cost }) => `${cost} calls`,
    );
    const awake = await provisioner.upstream(workspaceId);
    await step("what was kept is still there after the stop and start", async () => {
      if (!awake) throw new Error("the Droplet has no address after waking");
      if (!(await probe.read(awake, token()))) throw new Error("the channel was not there");
    });
  } catch {
    // Reported above; the rest is cleaning up.
  } finally {
    if (!options.keep) {
      await step("destroy: the Droplet", () => provisioner.destroy(workspaceId)).catch(() => {});
      await step("nothing is left", async () => {
        // DigitalOcean may take a Droplet away a little after it says it has.
        const until = Date.now() + (options.leftoverSeconds ?? 90) * 1000;
        for (;;) {
          const state = await provisioner.state(workspaceId);
          if (state === "missing") return;
          if (Date.now() > until) throw new Error(`the workspace is still there (${state})`);
          await sleep(2000);
        }
      }).catch(() => {});
      // The firewall is the spike's own, under its own name, and it made it.
      await step("the spike's firewall is removed", async () => {
        await removeFirewall(api);
      }).catch(() => {});
    }
  }
  return report;
}

export async function main(env: Record<string, string | undefined> = process.env) {
  // Its own names, so that nothing of a deployment's is touched; the firewall opens to this machine.
  const config = {
    ...digitalOceanConfigFromEnv({
      ...env,
      DO_NAME_PREFIX: SPIKE_PREFIX,
      // Not used: nothing is asked of the public address.
      DO_PUBLIC_URL_TEMPLATE: env.DO_PUBLIC_URL_TEMPLATE || "https://{id}.spike.invalid",
    }),
    readyCheck: "droplet" as const,
    upstreamNetwork: "public" as const,
  };
  if (config.edgeAddresses.length === 0)
    throw new Error(
      "DO_EDGE_ADDRESSES is needed: this machine's address, such as $(curl -s https://api.ipify.org)/32, " +
        "which the spike's firewall opens the workspace's port to",
    );
  const provisioner = new DigitalOceanProvisioner(config);
  const counter = countCalls(config.apiUrl);
  console.log(
    `Trying DigitalOcean with ${provisioner.name}; this makes one Droplet and removes it.`,
  );
  try {
    const report = await runDigitalOceanSpike({
      provisioner,
      probe: httpProbe(),
      api: new DigitalOceanApi({ token: config.token, apiUrl: config.apiUrl }),
      keep: process.argv.includes("--keep"),
      log: (line) => console.log(line),
      calls: counter.calls,
    });
    console.log(
      `\n${counter.calls()} calls were made to DigitalOcean${counter.remaining() === undefined ? "" : `; its allowance had ${counter.remaining()} of the hour's left at the least`}.`,
    );
    console.log(report.ok ? "All steps passed." : "Some steps failed; see above.");
    console.log(JSON.stringify(report));
    return report.ok;
  } finally {
    counter.restore();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
