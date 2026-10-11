import { DigitalOceanApi, DigitalOceanError } from "./digitalocean-api.ts";
import { sleep, waitUntilAnswering } from "./http.ts";
import type { Plan, PlanId } from "./plans.ts";
import {
  type MachineState,
  ProvisionError,
  type ProvisionedWorkspace,
  type Provisioner,
  type WorkspaceSpec,
} from "./provisioner.ts";
import { WORKSPACE_PORT, workspaceEnvFromEnv, workspaceSettings } from "./workspace-env.ts";

export interface DigitalOceanConfig {
  /** A token that can create and delete Droplets and firewalls and read sizes and images. */
  token: string;
  /** The snapshot every workspace's Droplet is made from: its id (or a distribution's slug). */
  image: string;
  /** Where workspaces run when one does not say, as DigitalOcean names regions (`nyc3`). */
  region: string;
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
  /** Make the firewall that lets only the edge reach workspaces, if there is not one. */
  firewall: boolean;
  /** The tag the edge's Droplets carry: what the firewall lets reach a workspace. */
  edgeTag: string;
  /** Addresses (CIDR) the edge connects from, when it is not a Droplet carrying `edgeTag`. */
  edgeAddresses: string[];
  /** Which of a Droplet's addresses the edge connects to. */
  upstreamNetwork: "private" | "public";
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
  const edgeTag = env.DO_EDGE_TAG?.trim() || "hive-edge";
  return {
    token,
    image,
    region: env.DO_REGION?.trim() || "nyc3",
    size: env.DO_SIZE?.trim() || undefined,
    sizes,
    vpcUuid: env.DO_VPC_UUID?.trim() || undefined,
    sshKeys: list("DO_SSH_KEYS"),
    namePrefix: env.DO_NAME_PREFIX?.trim() || "hive",
    workspaceEnv: workspaceEnvFromEnv(env),
    apiUrl: (env.DO_API_URL?.trim() || "https://api.digitalocean.com/v2").replace(/\/+$/, ""),
    publicUrlTemplate,
    firewall: env.DO_FIREWALL?.trim().toLowerCase() !== "off",
    edgeTag,
    edgeAddresses: list("DO_EDGE_ADDRESSES"),
    upstreamNetwork,
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
const UPSTREAM_MS = 5 * 60_000;
/** How long a Droplet gets to shut itself down cleanly before it is powered off. */
const SHUTDOWN_SECONDS = 90;

/** The first-boot configuration (cloud-init): the workspace's settings, where only root can read them, and the start of the workspace. */
export function cloudConfig(settings: Record<string, string>): string {
  const content = Buffer.from(JSON.stringify(settings), "utf8").toString("base64");
  return [
    "#cloud-config",
    "write_files:",
    "  - path: /etc/hive/workspace.json",
    "    owner: root:root",
    '    permissions: "0600"',
    "    encoding: b64",
    `    content: ${content}`,
    "runcmd:",
    "  - [systemctl, start, --no-block, hive-workspace.service]",
    "",
  ].join("\n");
}

/**
 * Workspaces on DigitalOcean Droplets: each is a machine of its own, made from one snapshot that
 * has the workspace installed on it, and its whole disk is the workspace's, so what the agent
 * installs stays. Nothing about the Droplet is public but what the edge may reach: a firewall lets
 * only the edge connect to the workspace's port, and the edge holds the certificate for the
 * workspace's address.
 */
export class DigitalOceanProvisioner implements Provisioner {
  readonly name = "digitalocean";
  private sizeCache?: { until: number; sizes: DoSize[] };
  private imageCache?: { until: number; image: DoImage };
  private firewallReady = false;
  private readonly upstreams = new Map<string, { until: number; value: string }>();

  private readonly client: DigitalOceanApi;

  constructor(private readonly config: DigitalOceanConfig) {
    this.client = new DigitalOceanApi({
      token: config.token,
      apiUrl: config.apiUrl,
      retryMs: config.retryMs,
    });
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

  async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    const url = this.publicUrl(spec.workspaceId);
    try {
      let droplet = await this.droplet(spec.workspaceId);
      if (!droplet) droplet = await this.makeDroplet(spec, url);
      if (droplet.status === "off") await this.powerOn(droplet.id);
      await this.waitActive(droplet.id);
      await waitUntilAnswering(url, spec.workspaceId, this.config);
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
    await waitUntilAnswering(this.publicUrl(workspaceId), workspaceId, this.config);
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
  }

  /** Where the edge connects to reach a workspace, or null when its Droplet is not running. */
  async upstream(workspaceId: string): Promise<string | null> {
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

  private async makeDroplet(spec: WorkspaceSpec, url: string): Promise<DoDroplet> {
    const region = spec.region ?? this.config.region;
    if (this.config.firewall) await this.ensureFirewall();
    const size = await this.chooseSize(spec.plan, region);
    await this.checkImage(region, size);
    const made = await this.api<{ droplet: DoDroplet }>("POST", "/droplets", {
      name: this.dropletName(spec.workspaceId),
      region,
      size: size.slug,
      image: /^\d+$/.test(this.config.image) ? Number(this.config.image) : this.config.image,
      ssh_keys: this.config.sshKeys.map((key) => (/^\d+$/.test(key) ? Number(key) : key)),
      backups: false,
      ipv6: false,
      monitoring: true,
      ...(this.config.vpcUuid ? { vpc_uuid: this.config.vpcUuid } : {}),
      tags: [this.config.namePrefix.toLowerCase(), this.allTag, this.tagFor(spec.workspaceId)],
      user_data: cloudConfig(workspaceSettings(spec, url, this.config.workspaceEnv)),
    });
    return (made as { droplet: DoDroplet }).droplet;
  }

  /**
   * The firewall every workspace's Droplet is under, which lets the edge reach the workspace's port
   * and nothing else in. It is made once; one that exists is left as an administrator set it.
   */
  private async ensureFirewall() {
    if (this.firewallReady) return;
    const name = `${this.config.namePrefix}-workspaces`.toLowerCase();
    const existing = await this.all<{ name: string }>("/firewalls", "firewalls");
    if (!existing.some((firewall) => firewall.name === name)) {
      const everywhere = ["0.0.0.0/0", "::/0"];
      await this.api(
        "POST",
        "/firewalls",
        {
          name,
          inbound_rules: [
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
        },
        // Another create made it a moment ago.
        [422],
      );
    }
    this.firewallReady = true;
  }

  /** The size a plan runs on: the one named for it, or the cheapest available that is big enough. */
  private async chooseSize(plan: Plan, region: string): Promise<DoSize> {
    const sizes = await this.sizes();
    const named = this.config.sizes[plan.id] ?? this.config.size;
    if (named) {
      const found = sizes.find((size) => size.slug === named);
      if (!found) throw new ProvisionError(`DigitalOcean has no size ${named}`);
      if (!found.available || !found.regions.includes(region))
        throw new ProvisionError(`DigitalOcean: size ${named} is not available in ${region}`);
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
    if (!cheapest)
      throw new ProvisionError(
        `DigitalOcean has no available size in ${region} with ${plan.guest.cpus} vCPUs, ${plan.guest.memoryMb} MB and ${plan.volumeGb} GB; set DO_SIZE`,
      );
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
    if (!this.imageCache || this.imageCache.until <= Date.now()) {
      const found = await this.api<{ image: DoImage }>(
        "GET",
        `/images/${this.config.image}`,
        undefined,
        [404],
      );
      if (!found) throw new ProvisionError(`DigitalOcean has no image ${this.config.image}`);
      this.imageCache = { until: Date.now() + IMAGE_MS, image: found.image };
    }
    const { image } = this.imageCache;
    if (image.status.toLowerCase() !== "available")
      throw new ProvisionError(`DigitalOcean: image ${image.id} is ${image.status}, not available`);
    if (!image.regions.includes(region))
      throw new ProvisionError(
        `DigitalOcean: image ${image.id} is not in ${region} (it is in ${image.regions.join(", ")}); transfer it there or change DO_REGION`,
      );
    if (size.disk < image.min_disk_size)
      throw new ProvisionError(
        `DigitalOcean: size ${size.slug} has ${size.disk} GB and image ${image.id} needs ${image.min_disk_size} GB`,
      );
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
