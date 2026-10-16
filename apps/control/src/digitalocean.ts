import {
  type CloudflareTunnelConfig,
  CloudflareTunnels,
  cloudflareTunnelConfigFromEnv,
} from "./cloudflare-tunnels.ts";
import { DigitalOceanApi, DigitalOceanError } from "./digitalocean-api.ts";
import { sleep, waitUntilAnswering } from "./http.ts";
import type { Plan, PlanId } from "./plans.ts";
import {
  type MachineState,
  ProvisionError,
  type ProvisionedWorkspace,
  type Provisioner,
  type ProvisionProgress,
  type WorkspaceSpec,
} from "./provisioner.ts";
import { WORKSPACE_PORT, workspaceEnvFromEnv, workspaceSettings } from "./workspace-env.ts";

const STANDARD_HOURS = [0, 4, 8, 12, 16, 20];
/**
 * DigitalOcean's backup plans for a Droplet, by the names its API gives them (`GET
 * /droplets/backups/supported_policies`). `daily` and `weekly` cost a share of the Droplet's price
 * (30% and 20%); the others (`custom_*`, `intra_daily_*`) cost per GB of a backup's restorable size,
 * which is far less for a workspace that is mostly empty. A Droplet can only be *made* on the first
 * two; the others are switched to once it exists.
 */
const BACKUP_PLANS = {
  daily: { usage: false, weekly: false, hours: STANDARD_HOURS, days: 7 },
  weekly: { usage: false, weekly: true, hours: STANDARD_HOURS, days: 28 },
  custom_daily: { usage: true, weekly: false, hours: STANDARD_HOURS, days: 7 },
  custom_weekly: { usage: true, weekly: true, hours: STANDARD_HOURS, days: 28 },
  intra_daily_12h: { usage: true, weekly: false, hours: STANDARD_HOURS, days: 7 },
  intra_daily_6h: { usage: true, weekly: false, hours: [0, 3, 6, 9, 12, 15, 18, 21], days: 7 },
  intra_daily_4h: { usage: true, weekly: false, hours: STANDARD_HOURS, days: 7 },
} as const;
export type BackupPlan = keyof typeof BACKUP_PLANS;

export interface DigitalOceanConfig {
  /** A token that can create and delete Droplets and firewalls and read sizes and images. */
  token: string;
  /** The snapshot every workspace's Droplet is made from: its id (or a distribution's slug). */
  image: string;
  /** Where workspaces run when one does not say, as DigitalOcean names regions (`nyc3`). */
  region: string;
  /**
   * The regions a new workspace may go to, in the order they are tried: the first with a size for
   * it and the workspace image. The image is copied to the others by `maintain`. `[region]` when unset.
   */
  regions?: string[];
  /** A size slug for every plan; without one, the cheapest available size that fits the plan. */
  size?: string;
  /** A size slug for one plan, over `size`. */
  sizes: Partial<Record<PlanId, string>>;
  /** The private network (VPC) to put Droplets in; the region's default when unset. */
  vpcUuid?: string;
  /** SSH keys, by id or fingerprint, that can log in to a workspace's Droplet. None by default. */
  sshKeys: string[];
  /** Put in front of the workspace id to name its Droplet and its tags. */
  namePrefix: string;
  /** Environment given to every workspace, beyond what Hive sets (MODEL, provider keys, …). */
  workspaceEnv: Record<string, string>;
  apiUrl: string;
  /** Where a workspace answers; `{id}` stands for its id. */
  publicUrlTemplate: string;
  /**
   * Reach workspaces through a Cloudflare Tunnel each, and not through the edge: each Droplet runs
   * `cloudflared`, which connects out, so nothing is let in and the server listens on the Droplet
   * alone. Left out, workspaces are reached through the edge.
   */
  tunnel?: CloudflareTunnelConfig;
  /**
   * Have DigitalOcean back up each workspace's Droplet on this plan (`DO_BACKUPS`). Off when unset.
   * A backup belongs to its Droplet and goes with it.
   */
  backups?: BackupPlan;
  /** The hour (UTC) a backup window starts: 0, 4, 8, 12, 16 or 20 (0, 3, 6, … for `intra_daily_6h`). 8 when unset. */
  backupHour?: number;
  /** Make the firewall that lets only the edge (or, with `tunnel`, nothing) reach workspaces, if there is not one. */
  firewall: boolean;
  /** The tag the edge's Droplets carry: what the firewall lets reach a workspace. */
  edgeTag: string;
  /** Addresses (CIDR) the edge connects from, when it is not a Droplet carrying `edgeTag`. */
  edgeAddresses: string[];
  /** Which of a Droplet's addresses the edge connects to. */
  upstreamNetwork: "private" | "public";
  /**
   * Where a new or waking workspace is waited for: at its public address, through the edge, or
   * at the Droplet's own (the `upstreamNetwork` one), for a control plane that can reach it.
   * `public` when unset.
   */
  readyCheck?: "public" | "droplet";
  /** How long to wait for a new or waking workspace to answer before giving up. */
  waitSeconds: number;
  /** How long a Droplet gets to shut itself down before it is powered off (90 when unset). */
  shutdownSeconds?: number;
  /** How often to ask a starting workspace whether it answers (milliseconds; 2000 when unset). */
  pollMs?: number;
  /** The first pause before trying a refused call again, doubled each time (milliseconds; 500 when unset). */
  retryMs?: number;
}

type Env = Record<string, string | undefined>;

/** The settings from the environment (DO_*), or an error naming what is missing. */
export function digitalOceanConfigFromEnv(env: Env = process.env): DigitalOceanConfig {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`The DigitalOcean provisioner needs ${name}`);
    return value;
  };
  const list = (name: string) =>
    (env[name] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  // In the order a person sets them up, so the first thing missing is the first thing named.
  const token = need("DO_API_TOKEN");
  const image = need("DO_IMAGE");
  const publicUrlTemplate = need("DO_PUBLIC_URL_TEMPLATE");
  if (!publicUrlTemplate.startsWith("https://") || !publicUrlTemplate.includes("{id}"))
    throw new Error(
      "DO_PUBLIC_URL_TEMPLATE must be an https address with {id} where the workspace's id goes",
    );
  const upstreamNetwork = env.DO_UPSTREAM_NETWORK?.trim() || "private";
  if (upstreamNetwork !== "private" && upstreamNetwork !== "public")
    throw new Error("DO_UPSTREAM_NETWORK must be private or public");
  const sizes: Partial<Record<PlanId, string>> = {};
  for (const plan of ["free", "team"] as const) {
    const slug = env[`DO_SIZE_${plan.toUpperCase()}`]?.trim();
    if (slug) sizes[plan] = slug;
  }
  const regions = list("DO_REGIONS").map((region) => region.toLowerCase());
  const region = regions[0] ?? (env.DO_REGION?.trim() || "nyc3");
  if (regions.length > 1 && env.DO_VPC_UUID?.trim())
    throw new Error(
      "DO_VPC_UUID is one region's network, so it cannot be used with several DO_REGIONS",
    );
  const backupsSetting = (env.DO_BACKUPS ?? "").trim().toLowerCase().replace(/-/g, "_");
  let backupPlan: BackupPlan | undefined;
  if (["on", "true", "1", "yes"].includes(backupsSetting)) backupPlan = "daily";
  else if (backupsSetting in BACKUP_PLANS) backupPlan = backupsSetting as BackupPlan;
  else if (!["", "off", "false", "0", "no"].includes(backupsSetting))
    // A typo must not quietly mean no backups.
    throw new Error(
      `DO_BACKUPS must be off, on, or one of ${Object.keys(BACKUP_PLANS).join(", ")}`,
    );
  const backupHour = env.DO_BACKUP_HOUR?.trim() ? Number(env.DO_BACKUP_HOUR) : undefined;
  const backupHours: readonly number[] = backupPlan
    ? BACKUP_PLANS[backupPlan].hours
    : STANDARD_HOURS;
  if (backupHour !== undefined && !backupHours.includes(backupHour))
    throw new Error(`DO_BACKUP_HOUR must be one of ${backupHours.join(", ")} (UTC)`);
  const readyCheck = env.DO_READY_CHECK?.trim() || "public";
  if (readyCheck !== "public" && readyCheck !== "droplet")
    throw new Error("DO_READY_CHECK must be public or droplet");
  const access = env.DO_ACCESS?.trim() || "edge";
  if (access !== "edge" && access !== "tunnel") throw new Error("DO_ACCESS must be edge or tunnel");
  if (access === "tunnel" && readyCheck === "droplet")
    throw new Error(
      "DO_READY_CHECK=droplet cannot be used with DO_ACCESS=tunnel: nothing listens on the Droplet's network",
    );
  const namePrefix = env.DO_NAME_PREFIX?.trim() || "hive";
  const edgeTag = env.DO_EDGE_TAG?.trim() || "hive-edge";
  return {
    token,
    image,
    region,
    regions: regions.length ? regions : [region],
    size: env.DO_SIZE?.trim() || undefined,
    sizes,
    vpcUuid: env.DO_VPC_UUID?.trim() || undefined,
    sshKeys: list("DO_SSH_KEYS"),
    namePrefix,
    workspaceEnv: workspaceEnvFromEnv(env),
    apiUrl: (env.DO_API_URL?.trim() || "https://api.digitalocean.com/v2").replace(/\/+$/, ""),
    publicUrlTemplate,
    tunnel:
      access === "tunnel"
        ? cloudflareTunnelConfigFromEnv(
            env,
            namePrefix.toLowerCase(),
            `http://localhost:${WORKSPACE_PORT}`,
          )
        : undefined,
    firewall: env.DO_FIREWALL?.trim().toLowerCase() !== "off",
    backups: backupPlan,
    backupHour,
    edgeTag,
    edgeAddresses: list("DO_EDGE_ADDRESSES"),
    upstreamNetwork,
    readyCheck,
    waitSeconds: Number(env.DO_WAIT_SECONDS ?? 300),
  };
}

interface DoDroplet {
  id: number;
  name: string;
  status: string;
  networks?: { v4?: { ip_address: string; type: string }[] };
  tags?: string[];
}
interface DoSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  price_monthly: number;
  regions: string[];
  available: boolean;
}
interface DoImage {
  id: number;
  status: string;
  regions: string[];
  min_disk_size: number;
}
interface DoAction {
  id: number;
  status: string;
  type: string;
}

/** Which sizes are the kind a plan asks for: shared CPUs are the Basic and v5 shared families. */
const SHARED_SIZE = /^s5?-/;
const DEDICATED_SIZE = /^(g|gd|g5|c|c2|c5)-/;

/** The cache lifetimes: sizes and the image change rarely, and a Droplet's address not at all while it lives. */
const SIZES_MS = 5 * 60_000;
const IMAGE_MS = 60_000;
/** After a refused copy of the workspace image to a region, how long before it is asked for again. */
const COPY_RETRY_MS = 10 * 60_000;
const UPSTREAM_MS = 5 * 60_000;
/** How long a Droplet gets to shut itself down cleanly before it is powered off. */
const SHUTDOWN_SECONDS = 90;

/**
 * The first-boot configuration (cloud-init): the workspace's settings, where only root can read
 * them, and the start of the workspace. With a `tunnelToken`, the token its tunnel runs with, in a
 * file of its own so that it is not among the settings the workspace's processes are given, and
 * the start of the tunnel.
 */
export function cloudConfig(
  settings: Record<string, string>,
  options: { tunnelToken?: string } = {},
): string {
  const file = (path: string, text: string) => [
    `  - path: ${path}`,
    "    owner: root:root",
    '    permissions: "0600"',
    "    encoding: b64",
    `    content: ${Buffer.from(text, "utf8").toString("base64")}`,
  ];
  return [
    "#cloud-config",
    "write_files:",
    ...file("/etc/hive/workspace.json", JSON.stringify(settings)),
    ...(options.tunnelToken ? file("/etc/hive/tunnel-token", options.tunnelToken) : []),
    "runcmd:",
    "  - [systemctl, start, --no-block, hive-workspace.service]",
    ...(options.tunnelToken ? ["  - [systemctl, start, --no-block, hive-tunnel.service]"] : []),
    "",
  ].join("\n");
}

/**
 * Workspaces on DigitalOcean Droplets: each is a machine of its own, made from one snapshot that
 * has the workspace installed on it, and its whole disk is the workspace's, so what the agent
 * installs stays. Nothing about the Droplet is public but what the edge may reach: a firewall lets
 * only the edge connect to the workspace's port, and the edge holds the certificate for the
 * workspace's address. Or, with a Cloudflare Tunnel for each workspace (`config.tunnel`), nothing
 * is let in at all: the Droplet connects out to Cloudflare, which holds the certificate and sends
 * the workspace's address down that connection.
 */
/** A region cannot take the workspace (no size, no image copy yet): another may. */
class RegionUnavailable extends ProvisionError {}

export class DigitalOceanProvisioner implements Provisioner {
  readonly name = "digitalocean";
  private sizeCache?: { until: number; sizes: DoSize[] };
  private imageCache?: { until: number; image: DoImage };
  private firewallReady = false;
  private readonly copyRefused = new Map<string, number>();
  private readonly upstreams = new Map<string, { until: number; value: string }>();

  private readonly client: DigitalOceanApi;
  private readonly tunnels?: CloudflareTunnels;

  constructor(private readonly config: DigitalOceanConfig) {
    this.client = new DigitalOceanApi({
      token: config.token,
      apiUrl: config.apiUrl,
      retryMs: config.retryMs,
    });
    if (config.tunnel)
      this.tunnels = new CloudflareTunnels({
        ...config.tunnel,
        retryMs: config.tunnel.retryMs ?? config.retryMs,
      });
  }

  /** The regions a new workspace is tried in, most wanted first. */
  private get regionOrder(): string[] {
    return this.config.regions?.length ? this.config.regions : [this.config.region];
  }

  /** `hive-<id>`: a Droplet's name is a hostname, so lowercase letters, digits and dashes. */
  dropletName(workspaceId: string): string {
    return `${this.config.namePrefix}-${workspaceId}`.toLowerCase();
  }

  /** The tag that finds a workspace's Droplet again, and nobody else's. */
  tagFor(workspaceId: string): string {
    return `${this.config.namePrefix}-ws-${workspaceId}`.toLowerCase();
  }

  /** The tag every workspace's Droplet carries, which the firewall is applied by. */
  private get allTag() {
    return `${this.config.namePrefix}-workspace`.toLowerCase();
  }

  async create(
    spec: WorkspaceSpec,
    progress: ProvisionProgress = () => {},
  ): Promise<ProvisionedWorkspace> {
    const url = this.publicUrl(spec.workspaceId);
    try {
      let droplet = await this.droplet(spec.workspaceId);
      // The tunnel comes first: the Droplet is given its token when it is made.
      if (this.tunnels) progress("address");
      const tunnel = await this.tunnels?.ensure(spec.workspaceId, new URL(url).hostname);
      progress("machine");
      if (!droplet) droplet = await this.makeDroplet(spec, url, tunnel?.token);
      progress("starting");
      if (droplet.status === "off") await this.powerOn(droplet.id);
      await this.waitActive(droplet.id);
      await this.settleBackups(droplet.id);
      progress("checking");
      await this.untilAnswering(spec.workspaceId, url);
    } catch (error) {
      if (error instanceof ProvisionError) throw error;
      throw new ProvisionError(`DigitalOcean: ${error instanceof Error ? error.message : error}`);
    }
    this.upstreams.delete(spec.workspaceId);
    return { url };
  }

  async wake(workspaceId: string): Promise<void> {
    const droplet = await this.droplet(workspaceId);
    if (!droplet)
      throw new ProvisionError(
        `DigitalOcean: ${this.dropletName(workspaceId)} has no Droplet to start`,
      );
    if (droplet.status === "off") await this.powerOn(droplet.id);
    await this.waitActive(droplet.id);
    await this.untilAnswering(workspaceId, this.publicUrl(workspaceId));
  }

  async state(workspaceId: string): Promise<MachineState> {
    const droplet = await this.droplet(workspaceId);
    if (!droplet) return "missing";
    switch (droplet.status) {
      case "active":
        return "running";
      case "new":
        return "starting";
      default:
        return "stopped";
    }
  }

  /**
   * Shut the Droplet down the way a machine is, and power it off if it will not. Its disk keeps
   * the workspace, and `wake` starts it again. DigitalOcean bills a Droplet that is off just as it
   * does one that is on, so this saves nothing; it is for the times a workspace has to be still.
   */
  async stop(workspaceId: string): Promise<void> {
    const droplet = await this.droplet(workspaceId);
    if (!droplet || droplet.status === "off") return;
    this.upstreams.delete(workspaceId);
    const shutdown = await this.act(droplet.id, "shutdown");
    if (
      !(await this.waitAction(
        droplet.id,
        shutdown.id,
        this.config.shutdownSeconds ?? SHUTDOWN_SECONDS,
      ))
    ) {
      const off = await this.act(droplet.id, "power_off");
      if (!(await this.waitAction(droplet.id, off.id, this.config.waitSeconds)))
        throw new ProvisionError(`DigitalOcean: Droplet ${droplet.id} did not power off`);
    }
  }

  async destroy(workspaceId: string): Promise<void> {
    this.upstreams.delete(workspaceId);
    // Everything that carries the workspace's tag, in one call; nothing carrying it is a Droplet gone already.
    await this.api(
      "DELETE",
      `/droplets?tag_name=${encodeURIComponent(this.tagFor(workspaceId))}`,
      undefined,
      [404],
    );
    // After the Droplet, whose connection to the tunnel goes with it.
    await this.tunnels?.remove(workspaceId, new URL(this.publicUrl(workspaceId)).hostname);
  }

  /** Where the edge connects to reach a workspace, or null when its Droplet is not running (or listens for no one but itself). */
  async upstream(workspaceId: string): Promise<string | null> {
    if (this.tunnels) return null;
    const cached = this.upstreams.get(workspaceId);
    if (cached && cached.until > Date.now()) return cached.value;
    const droplet = await this.droplet(workspaceId);
    if (droplet?.status !== "active") return null;
    const address = droplet.networks?.v4?.find(
      (network) => network.type === this.config.upstreamNetwork,
    )?.ip_address;
    if (!address) return null;
    const value = `http://${address}:${WORKSPACE_PORT}`;
    this.upstreams.set(workspaceId, { until: Date.now() + UPSTREAM_MS, value });
    return value;
  }

  // The steps of `create`, each safe to repeat.

  private async makeDroplet(
    spec: WorkspaceSpec,
    url: string,
    tunnelToken?: string,
  ): Promise<DoDroplet> {
    if (this.config.firewall) await this.ensureFirewall();
    const { region, size } = await this.place(spec);
    const made = await this.api<{ droplet: DoDroplet }>("POST", "/droplets", {
      name: this.dropletName(spec.workspaceId),
      region,
      size: size.slug,
      image: /^\d+$/.test(this.config.image) ? Number(this.config.image) : this.config.image,
      ssh_keys: this.config.sshKeys.map((key) => (/^\d+$/.test(key) ? Number(key) : key)),
      backups: Boolean(this.config.backups),
      // The plan is said outright: left to DigitalOcean it is whatever its default is.
      ...(this.config.backups
        ? {
            // Made on a plan DigitalOcean takes at creation; `settleBackups` moves it to a usage-based one.
            backup_policy: this.backupPolicy(
              BACKUP_PLANS[this.config.backups].weekly ? "weekly" : "daily",
            ),
          }
        : {}),
      ipv6: false,
      monitoring: true,
      ...(this.config.vpcUuid ? { vpc_uuid: this.config.vpcUuid } : {}),
      tags: [this.config.namePrefix.toLowerCase(), this.allTag, this.tagFor(spec.workspaceId)],
      user_data: cloudConfig(
        workspaceSettings(spec, url, this.config.workspaceEnv, {
          // Only the tunnel's connector, on the machine itself, connects to the server.
          host: this.tunnels ? "127.0.0.1" : undefined,
        }),
        { tunnelToken },
      ),
    });
    return (made as { droplet: DoDroplet }).droplet;
  }

  /**
   * The firewall every workspace's Droplet is under, which lets the edge reach the workspace's port
   * and nothing else in (or, with tunnels, lets nothing in). It is made once; one that exists is
   * left as an administrator set it.
   */
  private async ensureFirewall() {
    if (this.firewallReady) return;
    const name = `${this.config.namePrefix}-workspaces`.toLowerCase();
    const exists = async () =>
      (await this.all<{ name: string }>("/firewalls", "firewalls")).some(
        (firewall) => firewall.name === name,
      );
    if (!(await exists())) {
      const everywhere = ["0.0.0.0/0", "::/0"];
      try {
        await this.api("POST", "/firewalls", {
          name,
          inbound_rules: this.tunnels
            ? []
            : [
                {
                  protocol: "tcp",
                  ports: String(WORKSPACE_PORT),
                  sources: {
                    tags: [this.config.edgeTag.toLowerCase()],
                    ...(this.config.edgeAddresses.length
                      ? { addresses: this.config.edgeAddresses }
                      : {}),
                  },
                },
              ],
          // Once a firewall has any rule, what it does not allow is blocked: workspaces reach out freely.
          outbound_rules: [
            { protocol: "tcp", ports: "0", destinations: { addresses: everywhere } },
            { protocol: "udp", ports: "0", destinations: { addresses: everywhere } },
            { protocol: "icmp", destinations: { addresses: everywhere } },
          ],
          tags: [this.allTag],
        });
      } catch (error) {
        if (!(error instanceof DigitalOceanError && error.status === 422)) throw error;
        // A refusal is not always a failure: another create may have made it a moment ago.
        if (!(await exists())) {
          const said = `the firewall ${name} could not be made: ${error.message}`;
          // Otherwise a workspace would run with no firewall at all and no one the wiser. With a
          // tunnel nothing listens on the Droplet's network and its own packet filter drops what
          // arrives, so the workspace is safe without the cloud's firewall and the logs say so.
          if (!this.tunnels) throw new ProvisionError(`DigitalOcean: ${said}`);
          console.error(`[Hive control] ${said}; carrying on without it, as nothing listens`);
          return;
        }
      }
    }
    this.firewallReady = true;
  }

  /** The size a plan runs on: the one named for it, or the cheapest available that is big enough. */
  /**
   * Where a new workspace goes: the first region, in order, that has a size for it and the workspace
   * image. When none does, the provider has no room right now, which is worth trying again for.
   */
  private async place(spec: WorkspaceSpec): Promise<{ region: string; size: DoSize }> {
    const refused: string[] = [];
    for (const region of spec.region ? [spec.region] : this.regionOrder) {
      try {
        const size = await this.chooseSize(spec.plan, region);
        await this.checkImage(region, size);
        return { region, size };
      } catch (error) {
        if (!(error instanceof RegionUnavailable)) throw error;
        refused.push(error.message);
      }
    }
    throw new ProvisionError(
      `DigitalOcean could not place the workspace: ${refused.join("; ")}`,
      "We are out of room right now. Please try again in a little while.",
      true,
    );
  }

  /**
   * Copies the workspace image to the regions a workspace may fall back to, which takes DigitalOcean
   * a few minutes each, so that a region at capacity does not stop new workspaces. Called every
   * minute; with the image everywhere (or one region) it is a single read.
   */
  async maintain(): Promise<void> {
    const id = this.config.image;
    if (this.regionOrder.length < 2 || !/^\d+$/.test(id)) return;
    const found = await this.api<{ image: DoImage }>("GET", `/images/${id}`, undefined, [404]);
    if (!found) return;
    const missing = this.regionOrder.filter((region) => !found.image.regions.includes(region));
    if (!missing.length) return;
    const actions = await this.api<{ actions?: { type: string; status: string }[] }>(
      "GET",
      `/images/${id}/actions?per_page=200`,
    );
    // DigitalOcean does not say where a copy is going (the action's region is empty), so while any
    // is under way none is started: the next minute looks again.
    if ((actions?.actions ?? []).some((a) => a.type === "transfer" && a.status === "in-progress"))
      return;
    for (const region of missing) {
      if ((this.copyRefused.get(region) ?? 0) > Date.now()) continue;
      try {
        await this.api("POST", `/images/${id}/actions`, { type: "transfer", region });
      } catch (error) {
        this.copyRefused.set(region, Date.now() + COPY_RETRY_MS);
        console.error(
          `[Hive control] could not copy the workspace image to ${region}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  private async chooseSize(plan: Plan, region: string): Promise<DoSize> {
    const sizes = await this.sizes();
    const named = this.config.sizes[plan.id] ?? this.config.size;
    if (named) {
      const found = sizes.find((size) => size.slug === named);
      if (!found) throw new ProvisionError(`DigitalOcean has no size ${named}`);
      if (!found.available || !found.regions.includes(region))
        throw new RegionUnavailable(`DigitalOcean: size ${named} is not available in ${region}`);
      return found;
    }
    const kind = plan.guest.cpuKind === "shared" ? SHARED_SIZE : DEDICATED_SIZE;
    const fits = sizes
      .filter(
        (size) =>
          size.available &&
          size.regions.includes(region) &&
          kind.test(size.slug) &&
          size.memory >= plan.guest.memoryMb &&
          size.vcpus >= plan.guest.cpus &&
          size.disk >= plan.volumeGb,
      )
      .sort(
        (a, b) =>
          a.price_monthly - b.price_monthly || a.vcpus - b.vcpus || a.slug.localeCompare(b.slug),
      );
    const [cheapest] = fits;
    if (!cheapest) {
      // A region at capacity lists no sizes at all, and naming a size will not help there.
      if (!sizes.some((size) => size.available && size.regions.includes(region)))
        throw new RegionUnavailable(
          `DigitalOcean offers no sizes in ${region} right now (it may be out of capacity); use a region that has the workspace image (DO_REGIONS)`,
        );
      throw new RegionUnavailable(
        `DigitalOcean has no available size in ${region} with ${plan.guest.cpus} vCPUs, ${plan.guest.memoryMb} MB and ${plan.volumeGb} GB; set DO_SIZE`,
      );
    }
    return cheapest;
  }

  private async sizes(): Promise<DoSize[]> {
    if (this.sizeCache && this.sizeCache.until > Date.now()) return this.sizeCache.sizes;
    const sizes = await this.all<DoSize>("/sizes", "sizes");
    this.sizeCache = { until: Date.now() + SIZES_MS, sizes };
    return sizes;
  }

  /** The workspace image is where the Droplet is going to be, and fits on the size chosen. */
  private async checkImage(region: string, size: DoSize) {
    if (!/^\d+$/.test(this.config.image)) return;
    let image = await this.imageInfo();
    // Copied to this region since it was last looked at, perhaps.
    if (!image.regions.includes(region)) image = await this.imageInfo(true);
    if (image.status.toLowerCase() !== "available")
      throw new ProvisionError(`DigitalOcean: image ${image.id} is ${image.status}, not available`);
    if (!image.regions.includes(region))
      throw new RegionUnavailable(
        `DigitalOcean: image ${image.id} is not in ${region} yet (it is in ${image.regions.join(", ")})`,
      );
    if (size.disk < image.min_disk_size)
      throw new RegionUnavailable(
        `DigitalOcean: size ${size.slug} has ${size.disk} GB and image ${image.id} needs ${image.min_disk_size} GB`,
      );
  }

  private async imageInfo(fresh = false): Promise<DoImage> {
    if (fresh || !this.imageCache || this.imageCache.until <= Date.now()) {
      const found = await this.api<{ image: DoImage }>(
        "GET",
        `/images/${this.config.image}`,
        undefined,
        [404],
      );
      if (!found) throw new ProvisionError(`DigitalOcean has no image ${this.config.image}`);
      this.imageCache = { until: Date.now() + IMAGE_MS, image: found.image };
    }
    return this.imageCache.image;
  }

  // Droplets.

  /** The workspace's Droplet, found by the tag only it has; the oldest if a repeated call made two. */
  private async droplet(workspaceId: string): Promise<DoDroplet | null> {
    const found = await this.api<{ droplets?: DoDroplet[] }>(
      "GET",
      `/droplets?tag_name=${encodeURIComponent(this.tagFor(workspaceId))}&per_page=200`,
    );
    const droplets = [...(found?.droplets ?? [])].sort((a, b) => a.id - b.id);
    return droplets[0] ?? null;
  }

  private async powerOn(dropletId: number) {
    try {
      const action = await this.act(dropletId, "power_on");
      await this.waitAction(dropletId, action.id, this.config.waitSeconds);
    } catch (error) {
      // Started by someone else a moment ago: it only has to be waited for.
      if (
        !(
          error instanceof DigitalOceanError &&
          error.status === 422 &&
          /already/i.test(error.message)
        )
      )
        throw error;
    }
  }

  private async act(dropletId: number, type: string): Promise<DoAction> {
    const result = await this.api<{ action: DoAction }>("POST", `/droplets/${dropletId}/actions`, {
      type,
    });
    return (result as { action: DoAction }).action;
  }

  // Backups.

  /** The hour a backup window starts, on the plan asked for: the one set if it fits, else 8 (or 6, where 8 is not one). */
  private backupHourFor(plan: BackupPlan): number {
    const hours: readonly number[] = BACKUP_PLANS[plan].hours;
    const set = this.config.backupHour;
    return set !== undefined && hours.includes(set) ? set : hours.includes(8) ? 8 : 6;
  }

  /** A backup policy as DigitalOcean takes it: the plan, when its window starts, and the weekday for a weekly one. */
  private backupPolicy(plan: BackupPlan): { plan: string; hour: number; weekday?: string } {
    // A plan a Droplet is made on has the standard hours; the real hour is set when it is switched.
    const hour = this.backupHourFor(plan);
    return {
      plan,
      hour: (STANDARD_HOURS as readonly number[]).includes(hour) ? hour : 8,
      ...(BACKUP_PLANS[plan].weekly ? { weekday: "SUN" } : {}),
    };
  }

  /**
   * Moves a new Droplet from the plan it was made on to the usage-based one asked for. A Droplet
   * cannot be made on those, so this follows creation; if DigitalOcean refuses, the Droplet keeps
   * the plan it was made on (still backed up, at the flat price) and the logs say why. It never
   * stops a workspace from starting.
   */
  private async settleBackups(dropletId: number) {
    const wanted = this.config.backups;
    if (!wanted || !BACKUP_PLANS[wanted].usage) return;
    try {
      const now = await this.api<{ policy?: { backup_policy?: { plan?: string; hour?: number } } }>(
        "GET",
        `/droplets/${dropletId}/backups/policy`,
      );
      const have = now?.policy?.backup_policy;
      const hour = this.backupHourFor(wanted);
      if (have?.plan === wanted && have.hour === hour) return;
      const result = await this.api<{ action: DoAction }>(
        "POST",
        `/droplets/${dropletId}/actions`,
        {
          type: "change_backup_policy",
          backup_policy: {
            plan: wanted,
            hour,
            // DigitalOcean refuses a switch without it ("retention_period_days is invalid"): each plan's own default.
            retention_period_days: BACKUP_PLANS[wanted].days,
            ...(BACKUP_PLANS[wanted].weekly ? { weekday: "SUN" } : {}),
          },
        },
      );
      // The change is an action DigitalOcean carries out; one that fails is an error, caught below.
      if (result) await this.waitAction(dropletId, result.action.id, 60);
    } catch (error) {
      console.error(
        `[Hive control] could not switch Droplet ${dropletId}'s backups to ${wanted}; it keeps the plan it was made on: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * How long to wait before asking again, which grows to five times `pollMs`: a Droplet takes a
   * minute or more to come up, and the API allows only so many calls an hour.
   */
  private pause(attempt: number): Promise<void> {
    const first = this.config.pollMs ?? 2000;
    return sleep(Math.min(first * 1.5 ** attempt, first * 5));
  }

  /** True when the action completes, false when its time is up; an action that fails is an error. */
  private async waitAction(dropletId: number, actionId: number, seconds: number): Promise<boolean> {
    const until = Date.now() + seconds * 1000;
    for (let attempt = 0; Date.now() < until; attempt++) {
      const result = await this.api<{ action: DoAction }>(
        "GET",
        `/droplets/${dropletId}/actions/${actionId}`,
      );
      const action = (result as { action: DoAction }).action;
      if (action.status === "completed") return true;
      if (action.status === "errored")
        throw new ProvisionError(`DigitalOcean: ${action.type} of Droplet ${dropletId} failed`);
      await this.pause(attempt);
    }
    return false;
  }

  private async waitActive(dropletId: number) {
    const until = Date.now() + this.config.waitSeconds * 1000;
    let status = "unknown";
    for (let attempt = 0; Date.now() < until; attempt++) {
      const result = await this.api<{ droplet: DoDroplet }>("GET", `/droplets/${dropletId}`);
      status = (result as { droplet: DoDroplet }).droplet.status;
      if (status === "active") return;
      if (status === "archive")
        throw new ProvisionError(`DigitalOcean: Droplet ${dropletId} is archived`);
      await this.pause(attempt);
    }
    throw new ProvisionError(
      `DigitalOcean: Droplet ${dropletId} did not become active in ${this.config.waitSeconds}s (it is ${status})`,
    );
  }

  /** Waits for the workspace to answer, at its public address or at its Droplet's, as `readyCheck` says. */
  private async untilAnswering(workspaceId: string, publicUrl: string) {
    let where = publicUrl;
    if (this.config.readyCheck === "droplet") {
      let origin: string | null = null;
      for (let attempt = 0; !origin && attempt < 10; attempt++) {
        origin = await this.upstream(workspaceId);
        if (!origin) await this.pause(attempt);
      }
      if (!origin)
        throw new ProvisionError(
          `DigitalOcean: the ${this.config.upstreamNetwork} address of the Droplet is not known`,
        );
      where = origin;
    }
    await waitUntilAnswering(where, workspaceId, this.config);
  }

  private publicUrl(workspaceId: string) {
    return this.config.publicUrlTemplate.replace("{id}", workspaceId).replace(/\/+$/, "");
  }

  // Calls to DigitalOcean.

  private all<T>(path: string, key: string): Promise<T[]> {
    return this.client.all<T>(path, key);
  }

  private api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    accept: number[] = [],
  ): Promise<T | null> {
    return this.client.call<T>(method, path, body, accept);
  }
}
