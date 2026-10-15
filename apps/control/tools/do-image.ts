/**
 * Makes the image every workspace's Droplet is made from. It starts a Droplet of its own from
 * Ubuntu, has it set itself up with apps/workspace/vm/bake.sh (which takes the workspace out of the
 * container image you built and pushed), waits for it to switch itself off, takes a snapshot, and
 * deletes the Droplet. What it prints last is the snapshot's id, which is DO_IMAGE.
 *
 *   DO_API_TOKEN=… pnpm exec tsx apps/control/tools/do-image.ts --image ghcr.io/you/hive-workspace:2026-10
 *
 *   --image    the container image to take the workspace from (required)
 *   --region   where to make it (DO_REGION, or nyc3)
 *   --size     the size to make it on (the smallest disk with enough memory, when left out)
 *   --name     what the snapshot is called (hive-workspace-<date>)
 *
 * A registry that needs a login is given HIVE_REGISTRY_USER and HIVE_REGISTRY_TOKEN, which should
 * be able to pull and nothing else: they are on the Droplet while it is made, and it is deleted.
 * When something goes wrong the Droplet is left running, so that /var/log/hive-bake.log on it can
 * be read, and the message says how to remove it.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DigitalOceanApi, DigitalOceanError } from "../src/digitalocean-api.ts";
import { sleep } from "../src/http.ts";

const VM_DIR = new URL("../../workspace/vm/", import.meta.url);
/** Where the scripts are put on the Droplet; bake.sh looks for the rest next to itself. */
const BAKE_DIR = "/opt/hive-bake";

export interface BakeOptions {
  /** The container image the workspace is taken out of. */
  workspaceImage: string;
  registry?: { user: string; token: string };
  region: string;
  /** A size slug; without one, the smallest disk that has the memory. */
  size?: string;
  /** What the snapshot is called. */
  name: string;
  /** The distribution image the Droplet starts from. */
  base: string;
  /** SSH keys, by id or fingerprint, that can log in to the Droplet while it is made. */
  sshKeys: string[];
  /** How long the Droplet has to finish and switch itself off, and the snapshot to be taken (minutes). */
  bakeMinutes: number;
  snapshotMinutes: number;
  /** How often to look at the Droplet (milliseconds). */
  pollMs: number;
  log: (line: string) => void;
}

export interface BakedImage {
  id: number;
  name: string;
  regions: string[];
  /** The smallest disk, in GB, a Droplet made from it can have. */
  minDiskSize: number;
  sizeGigabytes: number;
}

/** The bake did not finish. The Droplet it ran on is left for someone to look at. */
export class BakeError extends Error {
  constructor(
    message: string,
    readonly dropletId?: number,
  ) {
    super(message);
    this.name = "BakeError";
  }
}

interface Droplet {
  id: number;
  status: string;
  networks?: { v4?: { ip_address: string; type: string }[] };
}
interface Size {
  slug: string;
  memory: number;
  disk: number;
  price_monthly: number;
  regions: string[];
  available: boolean;
}
interface Image {
  id: number;
  name: string;
  status: string;
  regions: string[];
  min_disk_size: number;
  size_gigabytes: number;
}
interface Action {
  id: number;
  status: string;
  type: string;
}

const base64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
/** A value as one word for a shell. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The cloud-config that puts the scripts on the Droplet and runs them. */
export function bakeCloudConfig(options: {
  workspaceImage: string;
  registry?: { user: string; token: string };
}): string {
  for (const [name, value] of Object.entries({
    image: options.workspaceImage,
    "registry user": options.registry?.user ?? "",
    "registry token": options.registry?.token ?? "",
  }))
    if (/[\r\n\0]/.test(value)) throw new Error(`The ${name} has a line break in it`);
  const file = (name: string) => readFileSync(new URL(name, VM_DIR));
  const env = [
    `HIVE_WORKSPACE_IMAGE=${shellQuote(options.workspaceImage)}`,
    ...(options.registry
      ? [
          `HIVE_REGISTRY_USER=${shellQuote(options.registry.user)}`,
          `HIVE_REGISTRY_TOKEN=${shellQuote(options.registry.token)}`,
        ]
      : []),
    "",
  ].join("\n");
  const entry = (name: string, mode: string, content: string) =>
    [
      `  - path: ${BAKE_DIR}/${name}`,
      "    owner: root:root",
      `    permissions: "${mode}"`,
      "    encoding: b64",
      `    content: ${content}`,
    ].join("\n");
  return [
    "#cloud-config",
    "write_files:",
    entry("bake.sh", "0755", base64(file("bake.sh"))),
    entry("hive-workspace.service", "0644", base64(file("hive-workspace.service"))),
    entry("hive-tunnel.service", "0644", base64(file("hive-tunnel.service"))),
    entry("nftables.conf", "0644", base64(file("nftables.conf"))),
    entry("bake.env", "0600", base64(env)),
    "runcmd:",
    `  - [bash, ${BAKE_DIR}/bake.sh]`,
    "",
  ].join("\n");
}

/** The size to make the image on: the smallest disk with the memory it needs, then the cheapest. */
export function chooseBakeSize(sizes: Size[], region: string, requested?: string): Size {
  if (requested) {
    const found = sizes.find((size) => size.slug === requested);
    if (!found) throw new Error(`DigitalOcean has no size ${requested}`);
    if (!found.available || !found.regions.includes(region))
      throw new Error(`Size ${requested} is not available in ${region}`);
    return found;
  }
  // A snapshot can only go on a disk at least as big as the one it was taken from, so the smallest
  // keeps every size open. It needs memory for the package upgrade and a workspace to start once.
  const [smallest] = sizes
    .filter(
      (size) =>
        size.available &&
        size.regions.includes(region) &&
        /^s5?-/.test(size.slug) &&
        size.memory >= 2048,
    )
    .sort(
      (a, b) =>
        a.disk - b.disk || a.price_monthly - b.price_monthly || a.slug.localeCompare(b.slug),
    );
  if (!smallest)
    throw new Error(`DigitalOcean has no shared size with 2 GB of memory available in ${region}`);
  return smallest;
}

/** Makes the image and gives it back. The Droplet it was made on is deleted once the snapshot exists. */
export async function bakeImage(api: DigitalOceanApi, options: BakeOptions): Promise<BakedImage> {
  const call = async <T>(method: string, path: string, body?: unknown, accept: number[] = []) =>
    (await api.call<T>(method, path, body, accept)) as T;
  const { log } = options;

  const sizes = await api.all<Size>("/sizes", "sizes");
  const size = chooseBakeSize(sizes, options.region, options.size);
  const userData = bakeCloudConfig(options);
  log(
    `Making a Droplet of ${size.slug} (${size.memory / 1024} GB, ${size.disk} GB disk) in ${options.region}`,
  );
  const made = await call<{ droplet: Droplet }>("POST", "/droplets", {
    name: `hive-bake-${Date.now().toString(36)}`,
    region: options.region,
    size: size.slug,
    image: options.base,
    ssh_keys: options.sshKeys.map((key) => (/^\d+$/.test(key) ? Number(key) : key)),
    backups: false,
    ipv6: false,
    monitoring: false,
    tags: ["hive-bake"],
    user_data: userData,
  });
  const dropletId = made.droplet.id;
  const left = (what: string) => {
    const address = made.droplet.networks?.v4?.find((n) => n.type === "public")?.ip_address;
    return new BakeError(
      `${what} The Droplet ${dropletId}${address ? ` (${address})` : ""} is left running so that ` +
        "/var/log/hive-bake.log on it can be read; remove it when you are done with " +
        `\`doctl compute droplet delete ${dropletId}\`.`,
      dropletId,
    );
  };

  let image: Image;
  try {
    // The Droplet sets itself up and then switches itself off, which is how it says it is done.
    const bakeUntil = Date.now() + options.bakeMinutes * 60_000;
    let status = "";
    for (let attempt = 0; ; attempt++) {
      const { droplet } = await call<{ droplet: Droplet }>("GET", `/droplets/${dropletId}`);
      made.droplet.networks = droplet.networks ?? made.droplet.networks;
      if (droplet.status !== status) {
        status = droplet.status;
        log(`The Droplet is ${status}`);
      }
      if (status === "off") break;
      if (status === "archive") throw left("The Droplet was archived.");
      if (Date.now() >= bakeUntil)
        throw left(
          `The Droplet did not switch itself off in ${options.bakeMinutes} minutes, so its setup did not finish.`,
        );
      if (attempt > 0 && attempt % Math.max(1, Math.round(60_000 / options.pollMs)) === 0)
        log("Still setting up…");
      await sleep(options.pollMs);
    }

    log(`Taking the snapshot ${options.name}`);
    const { action } = await call<{ action: Action }>("POST", `/droplets/${dropletId}/actions`, {
      type: "snapshot",
      name: options.name,
    });
    const snapshotUntil = Date.now() + options.snapshotMinutes * 60_000;
    for (;;) {
      const { action: now } = await call<{ action: Action }>(
        "GET",
        `/droplets/${dropletId}/actions/${action.id}`,
      );
      if (now.status === "completed") break;
      if (now.status === "errored") throw left("DigitalOcean could not take the snapshot.");
      if (Date.now() >= snapshotUntil)
        throw left(`The snapshot was not taken in ${options.snapshotMinutes} minutes.`);
      await sleep(options.pollMs);
    }

    const snapshots = await api.all<Image>(`/droplets/${dropletId}/snapshots`, "snapshots");
    const snapshot = snapshots
      .filter((image) => image.name === options.name)
      .sort((a, b) => b.id - a.id)[0];
    if (!snapshot) throw left(`The snapshot ${options.name} is not among the Droplet's snapshots.`);
    // The list does not say whether the snapshot is ready; the image does.
    image = (await call<{ image: Image }>("GET", `/images/${snapshot.id}`)).image;
    const availableUntil = Date.now() + options.snapshotMinutes * 60_000;
    while (image.status.toLowerCase() !== "available") {
      if (Date.now() >= availableUntil) throw left(`The snapshot is still ${image.status}.`);
      await sleep(options.pollMs);
      image = (await call<{ image: Image }>("GET", `/images/${snapshot.id}`)).image;
    }

    // The snapshot is the product; the Droplet it came from has done its work.
    log("Deleting the Droplet it was made on");
    try {
      await api.call("DELETE", `/droplets/${dropletId}`, undefined, [404]);
    } catch (error) {
      log(
        `The Droplet ${dropletId} could not be deleted (${error instanceof DigitalOceanError ? error.message : error}); delete it yourself.`,
      );
    }
  } catch (error) {
    // Whatever went wrong after the Droplet was made, it is the one place to look.
    if (error instanceof BakeError) throw error;
    throw left(`${error instanceof Error ? error.message : error}.`);
  }
  return {
    id: image.id,
    name: image.name,
    regions: image.regions,
    minDiskSize: image.min_disk_size,
    sizeGigabytes: image.size_gigabytes,
  };
}

function parseArguments(argv: string[]): Record<string, string> {
  const given: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new Error(`${flag} is not an option with a value; see the top of this file`);
    given[flag.slice(2)] = value;
    i++;
  }
  return given;
}

export async function main(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  tuning: Partial<BakeOptions> = {},
) {
  const given = parseArguments(argv);
  for (const name of Object.keys(given))
    if (!["image", "region", "size", "name", "base"].includes(name))
      throw new Error(`No option --${name}; see the top of this file`);
  const token = env.DO_API_TOKEN?.trim();
  if (!token) throw new Error("DO_API_TOKEN is needed");
  if (!given.image) throw new Error("--image names the container image to take the workspace from");
  const user = env.HIVE_REGISTRY_USER?.trim();
  const secret = env.HIVE_REGISTRY_TOKEN?.trim();
  if (Boolean(user) !== Boolean(secret))
    throw new Error("HIVE_REGISTRY_USER and HIVE_REGISTRY_TOKEN go together");
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const api = new DigitalOceanApi({
    token,
    apiUrl: (env.DO_API_URL?.trim() || "https://api.digitalocean.com/v2").replace(/\/+$/, ""),
  });
  const baked = await bakeImage(api, {
    workspaceImage: given.image,
    registry: user && secret ? { user, token: secret } : undefined,
    region: given.region ?? env.DO_REGION?.trim() ?? "nyc3",
    size: given.size,
    name: given.name ?? `hive-workspace-${stamp}`,
    base: given.base ?? "ubuntu-24-04-x64",
    sshKeys: (env.DO_SSH_KEYS ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
    bakeMinutes: 40,
    snapshotMinutes: 40,
    pollMs: 15_000,
    log: (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
    ...tuning,
  });
  console.log(
    `\nThe image ${baked.name} is ready in ${baked.regions.join(", ")}: ${baked.sizeGigabytes.toFixed(1)} GB, for Droplets with a disk of at least ${baked.minDiskSize} GB.`,
  );
  console.log();
  console.log(`DO_IMAGE=${baked.id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
