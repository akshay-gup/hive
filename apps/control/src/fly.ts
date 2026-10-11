import { retryingFetch, waitUntilAnswering } from "./http.ts";
import type { Plan } from "./plans.ts";
import {
  type MachineState,
  ProvisionError,
  type ProvisionedWorkspace,
  type Provisioner,
  type WorkspaceSpec,
} from "./provisioner.ts";
import { WORKSPACE_PORT, workspaceEnvFromEnv, workspaceSettings } from "./workspace-env.ts";

export interface FlyConfig {
  /** An org-scoped token that can create apps, volumes and machines. */
  token: string;
  /** The org workspaces are made in, as Fly names it in URLs (its slug). */
  org: string;
  /** What each workspace's machine runs: an image Fly can pull, tag included. */
  image: string;
  /** Where to run them when a workspace does not say, as Fly names regions (`iad`). */
  region: string;
  /** Put in front of the workspace id to name its app, so workspaces are easy to tell apart. */
  appPrefix: string;
  /** Environment given to every workspace, beyond what Hive sets (MODEL, provider keys, …). */
  workspaceEnv: Record<string, string>;
  apiUrl: string;
  /** Where a workspace answers once it runs; `{app}` stands for its app name. */
  publicUrlTemplate: string;
  /** How long to wait for a new or waking workspace to answer before giving up. */
  waitSeconds: number;
  /** How often to ask a starting workspace whether it answers (milliseconds; 2000 when unset). */
  pollMs?: number;
  /** The first pause before trying a refused call again, doubled each time (milliseconds; 500 when unset). */
  retryMs?: number;
}

type Env = Record<string, string | undefined>;

/** The settings from the environment (FLY_*), or an error naming what is missing. */
export function flyConfigFromEnv(env: Env = process.env): FlyConfig {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`The Fly provisioner needs ${name}`);
    return value;
  };
  return {
    token: need("FLY_API_TOKEN"),
    org: need("FLY_ORG"),
    image: need("FLY_IMAGE"),
    region: env.FLY_REGION?.trim() || "iad",
    appPrefix: env.FLY_APP_PREFIX?.trim() || "hive",
    workspaceEnv: workspaceEnvFromEnv(env),
    apiUrl: (env.FLY_API_URL?.trim() || "https://api.machines.dev/v1").replace(/\/+$/, ""),
    publicUrlTemplate: env.FLY_PUBLIC_URL_TEMPLATE?.trim() || "https://{app}.fly.dev",
    waitSeconds: Number(env.FLY_WAIT_SECONDS ?? 180),
  };
}

interface FlyMachine {
  id: string;
  state: string;
  region?: string;
}
interface FlyVolume {
  id: string;
  name: string;
  state?: string;
}
interface FlyAddress {
  ip: string;
  shared?: boolean;
  egress?: boolean;
}

/** Volumes Fly is on its way to removing: they are listed for a while, and are not ones to use. */
const REMOVED_VOLUME_STATES = [
  "scheduling_destroy",
  "fork_cleanup",
  "waiting_for_detach",
  "pending_destroy",
  "destroying",
];
const stillThere = (volume: FlyVolume) => !REMOVED_VOLUME_STATES.includes(volume.state ?? "");

/** Which kind of address Fly has given: the same way its own client tells them apart. */
function addressType(address: FlyAddress): string {
  if (address.egress) return "egress";
  if (address.ip.startsWith("fdaa:")) return "private_v6";
  if (address.shared) return "shared_v4";
  return address.ip.includes(":") ? "v6" : "v4";
}

const INTERNAL_PORT = WORKSPACE_PORT;
const VOLUME_NAME = "data";
const DATA_MOUNT = "/data";

/** A call to Fly that did not go through, with Fly's own words, for the logs and not for people. */
class FlyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FlyError";
  }
}

/**
 * Workspaces on Fly Machines: each is an app of its own, on a private network of its own, so a
 * workspace's agent cannot reach another workspace's machine, with one machine and one volume.
 * The app has a public address (`<app>.fly.dev`), and Fly's proxy stops the machine when nobody
 * is using it and starts it on the next request, on plans that allow it.
 */
export class FlyProvisioner implements Provisioner {
  readonly name = "fly";
  constructor(private readonly config: FlyConfig) {}

  /** `hive-<id>`: Fly app names are lowercase letters, digits and dashes, up to 30 characters. */
  appName(workspaceId: string): string {
    return `${this.config.appPrefix}-${workspaceId}`.toLowerCase();
  }

  async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    const app = this.appName(spec.workspaceId);
    const url = this.publicUrl(app);
    try {
      await this.ensureApp(app);
      await this.ensureAddresses(app);
      const volume = await this.ensureVolume(app, spec);
      const machine = await this.ensureMachine(app, volume, spec, url);
      await this.waitStarted(app, machine.id);
      await this.waitAnswering(url, spec.workspaceId);
    } catch (error) {
      if (error instanceof ProvisionError) throw error;
      throw new ProvisionError(`Fly: ${error instanceof Error ? error.message : error}`);
    }
    return { url };
  }

  async wake(workspaceId: string): Promise<void> {
    const app = this.appName(workspaceId);
    const machine = await this.machine(app);
    if (!machine) throw new ProvisionError(`Fly: ${app} has no machine to start`);
    if (machine.state !== "started") {
      if (machine.state === "stopping" || machine.state === "suspending")
        await this.waitState(app, machine.id, "stopped");
      await this.fly("POST", `/apps/${app}/machines/${machine.id}/start`);
    }
    await this.waitStarted(app, machine.id);
    await this.waitAnswering(this.publicUrl(app), workspaceId);
  }

  async state(workspaceId: string): Promise<MachineState> {
    const machine = await this.machine(this.appName(workspaceId));
    if (!machine) return "missing";
    switch (machine.state) {
      case "started":
        return "running";
      case "created":
      case "starting":
      case "replacing":
        return "starting";
      default:
        return "stopped";
    }
  }

  /** Stop the machine and nothing else: its volume keeps the workspace, and `wake`, or a request to its address, starts it again. */
  async stop(workspaceId: string): Promise<void> {
    const app = this.appName(workspaceId);
    const machine = await this.machine(app);
    if (!machine || machine.state === "stopped") return;
    await this.fly("POST", `/apps/${app}/machines/${machine.id}/stop`, {
      signal: "SIGTERM",
      timeout: "30s",
    });
    await this.waitState(app, machine.id, "stopped");
  }

  async destroy(workspaceId: string): Promise<void> {
    const app = this.appName(workspaceId);
    // Machines first, then the volumes they held, then the app; a missing app is already done.
    const machines = await this.fly<FlyMachine[]>("GET", `/apps/${app}/machines`, undefined, [404]);
    if (!machines) return;
    for (const machine of machines)
      await this.fly(
        "DELETE",
        `/apps/${app}/machines/${machine.id}?force=true&kill=true`,
        undefined,
        [404],
      );
    const volumes =
      (await this.fly<FlyVolume[]>("GET", `/apps/${app}/volumes`, undefined, [404])) ?? [];
    for (const volume of volumes.filter(stillThere))
      await this.fly("DELETE", `/apps/${app}/volumes/${volume.id}`, undefined, [404]);
    await this.fly("DELETE", `/apps/${app}`, undefined, [404]);
  }

  // The steps of `create`, each safe to repeat.

  private async ensureApp(app: string) {
    const existing = await this.fly("GET", `/apps/${app}`, undefined, [404]);
    if (existing) return;
    await this.fly(
      "POST",
      "/apps?wait=true",
      // The network is the app's own: apps on separate networks cannot reach each other. The name
      // goes under both keys the API has been documented and used with.
      { app_name: app, name: app, org_slug: this.config.org, network: app },
      [422],
    );
  }

  /** A public address for the app, or its `fly.dev` name has nothing to point at: a dedicated IPv6 and a shared IPv4. */
  private async ensureAddresses(app: string) {
    const listed = await this.fly<{ ips?: FlyAddress[] }>("GET", `/apps/${app}/ip_assignments`);
    const have = new Set((listed?.ips ?? []).map(addressType));
    for (const type of ["v6", "shared_v4"])
      if (!have.has(type)) await this.fly("POST", `/apps/${app}/ip_assignments`, { type });
  }

  private async ensureVolume(app: string, spec: WorkspaceSpec): Promise<FlyVolume> {
    const volumes = (await this.fly<FlyVolume[]>("GET", `/apps/${app}/volumes`)) ?? [];
    const existing = volumes.find((volume) => volume.name === VOLUME_NAME && stillThere(volume));
    if (existing) return existing;
    return (await this.fly<FlyVolume>("POST", `/apps/${app}/volumes`, {
      name: VOLUME_NAME,
      region: spec.region ?? this.config.region,
      size_gb: spec.plan.volumeGb,
      encrypted: true,
      // Fly keeps a snapshot a day; how long it keeps them is the only protection a volume has
      // against losing its host, so keep them as long as Fly allows.
      snapshot_retention: 60,
    })) as FlyVolume;
  }

  private async ensureMachine(
    app: string,
    volume: FlyVolume,
    spec: WorkspaceSpec,
    url: string,
  ): Promise<FlyMachine> {
    const existing = await this.machine(app);
    if (existing) return existing;
    return (await this.fly<FlyMachine>("POST", `/apps/${app}/machines`, {
      name: `${app}-1`,
      region: spec.region ?? this.config.region,
      config: this.machineConfig(spec, volume, url),
    })) as FlyMachine;
  }

  /** What the machine is: the image, what it is told about its workspace, its size, disk and address. */
  machineConfig(spec: WorkspaceSpec, volume: FlyVolume, url: string) {
    const plan: Plan = spec.plan;
    return {
      image: this.config.image,
      // The workspace makes its own secrets on the volume at first start, so none pass through here.
      env: workspaceSettings(spec, url, this.config.workspaceEnv),
      guest: {
        cpu_kind: plan.guest.cpuKind,
        cpus: plan.guest.cpus,
        memory_mb: plan.guest.memoryMb,
      },
      mounts: [{ volume: volume.id, path: DATA_MOUNT }],
      services: [
        {
          protocol: "tcp",
          internal_port: INTERNAL_PORT,
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"], force_https: true },
          ],
          // Fly's proxy stops an idle machine and starts it on the next request.
          autostop: plan.stopsWhenIdle ? "stop" : "off",
          autostart: true,
          min_machines_running: 0,
          checks: [
            {
              type: "http",
              port: INTERNAL_PORT,
              method: "GET",
              path: "/api/health",
              interval: "15s",
              timeout: "5s",
              grace_period: "60s",
            },
          ],
        },
      ],
      restart: { policy: "on-failure", max_retries: 5 },
      // Time to end its runs and close its database before Fly kills it.
      stop_config: { signal: "SIGTERM", timeout: "30s" },
      metadata: { hive_workspace: spec.workspaceId },
    };
  }

  private async machine(app: string): Promise<FlyMachine | null> {
    const machines = await this.fly<FlyMachine[]>("GET", `/apps/${app}/machines`, undefined, [404]);
    return machines?.[0] ?? null;
  }

  private async waitStarted(app: string, machineId: string) {
    await this.waitState(app, machineId, "started");
  }

  /** Fly answers a wait with the state reached, or 408 when its own time is up: ask again until ours is. */
  private async waitState(app: string, machineId: string, state: string) {
    const until = Date.now() + this.config.waitSeconds * 1000;
    while (Date.now() < until) {
      const seconds = Math.max(1, Math.min(30, Math.ceil((until - Date.now()) / 1000)));
      try {
        await this.fly(
          "GET",
          `/apps/${app}/machines/${machineId}/wait?state=${state}&timeout=${seconds}`,
        );
        return;
      } catch (error) {
        if (!(error instanceof FlyError && (error.status === 408 || error.status === 504)))
          throw error;
      }
    }
    throw new ProvisionError(`Fly: ${app} did not reach ${state} in ${this.config.waitSeconds}s`);
  }

  /** The workspace's own health check, through the public address: the machine is up and it is the right workspace. */
  private waitAnswering(url: string, workspaceId: string) {
    return waitUntilAnswering(url, workspaceId, this.config);
  }

  private publicUrl(app: string) {
    return this.config.publicUrlTemplate.replace("{app}", app).replace(/\/+$/, "");
  }

  // Calls to Fly.

  /** A call to the Machines API. Statuses in `accept` come back as `null`; anything else not ok is an error. */
  private async fly<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    accept: number[] = [],
  ): Promise<T | null> {
    const response = await retryingFetch(
      `${this.config.apiUrl}${path}`,
      {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.config.retryMs,
    );
    if (accept.includes(response.status)) return null;
    const text = await response.text();
    if (!response.ok)
      throw new FlyError(
        `${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }
}
