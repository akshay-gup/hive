import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDroplet {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  region: { slug: string };
  size_slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  image: { id: number; name: string };
  tags: string[];
  vpc_uuid: string;
  networks: { v4: { ip_address: string; type: "public" | "private" }[]; v6: never[] };
  created_at: string;
  /** What the request carried, kept for tests. */
  userData: string;
  sshKeys: unknown[];
  monitoring: boolean;
}
export interface FakeSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  price_monthly: number;
  price_hourly: number;
  regions: string[];
  available: boolean;
  transfer: number;
  description: string;
}
export interface FakeImage {
  id: number;
  name: string;
  /** What a distribution is asked for by. */
  slug?: string;
  type: "snapshot" | "base";
  regions: string[];
  min_disk_size: number;
  size_gigabytes: number;
  status: "available" | "new" | "deleted";
  tags: string[];
  created_at: string;
}
export interface FakeFirewall {
  id: string;
  name: string;
  status: "succeeded";
  inbound_rules: {
    protocol: string;
    ports?: string;
    sources: { addresses?: string[]; tags?: string[] };
  }[];
  outbound_rules: {
    protocol: string;
    ports?: string;
    destinations: { addresses?: string[]; tags?: string[] };
  }[];
  droplet_ids: number[];
  tags: string[];
}
interface FakeAction {
  id: number;
  status: "in-progress" | "completed" | "errored";
  type: string;
  started_at: string;
  completed_at: string | null;
  resource_id: number;
  resource_type: "droplet";
  region_slug: string;
  /** When it finishes, and what it does when it does. */
  doneAt: number;
  apply: () => void;
}
export interface DoCall {
  method: string;
  path: string;
  body?: unknown;
}

const REGIONS = ["nyc1", "nyc3", "sfo3", "fra1"];

/** Sizes as DigitalOcean lists them: the bundled Basic plans, a premium one, and the v5 families. */
export const defaultSizes = (): FakeSize[] => [
  size("s-1vcpu-1gb", 1024, 1, 25, 6),
  size("s-1vcpu-2gb", 2048, 1, 50, 12),
  size("s-2vcpu-2gb", 2048, 2, 60, 18),
  size("s-2vcpu-4gb", 4096, 2, 80, 24),
  size("s-2vcpu-4gb-amd", 4096, 2, 80, 21),
  size("g-2vcpu-8gb", 8192, 2, 25, 63),
  size("s5-1vcpu-1gb-30gb", 1024, 1, 30, 17.52, ["atl1", "mem1"]),
  size("s5-2vcpu-4gb-30gb", 4096, 2, 30, 37.96, ["atl1", "mem1"]),
  { ...size("s-4vcpu-8gb", 8192, 4, 160, 48), available: false },
  size("gpu-h100x1-80gb", 245760, 20, 720, 2000),
];
function size(
  slug: string,
  memory: number,
  vcpus: number,
  disk: number,
  price: number,
  regions = REGIONS,
): FakeSize {
  return {
    slug,
    memory,
    vcpus,
    disk,
    price_monthly: price,
    price_hourly: Number((price / 730).toFixed(5)),
    regions,
    available: true,
    transfer: 2,
    description: slug,
  };
}

/**
 * A stand-in for the parts of DigitalOcean the provisioner talks to: Droplets and their actions,
 * sizes, snapshots, firewalls, and the workspace's own health check as its public address would
 * answer it. It keeps them in memory, refuses requests that are not what DigitalOcean's own client
 * sends (field names are the ones its Go client uses), and fails or lags when told to, so the
 * provisioner can be tested without an account.
 */
export async function fakeDigitalOcean(
  options: {
    token?: string;
    /** How long a new Droplet is `new`, and how long an action runs (milliseconds). */
    activeDelayMs?: number;
    actionDelayMs?: number;
    /** How long after a Droplet is active before the workspace on it answers. */
    bootDelayMs?: number;
    /**
     * A Droplet whose user data has the workspace image's bake script in it sets itself up and
     * switches itself off this long after it is active; left out, it never does.
     */
    bakeMs?: number;
    /** Copies of an image to another region start but do not finish until `finishTransfers`. */
    holdTransfers?: boolean;
    /**
     * What stands in front of the public address: asked about a workspace before it is let through,
     * as the edge asks the control plane. Without it the address reaches the Droplet directly.
     */
    resolve?: (workspaceId: string) => Promise<{ known: boolean; upstream: string | null }>;
    /** The most results one page holds, to test paging. */
    pageSize?: number;
    sizes?: FakeSize[];
  } = {},
) {
  const token = options.token ?? "do-test-token";
  const droplets = new Map<number, FakeDroplet>();
  const actions = new Map<number, FakeAction>();
  const images = new Map<number, FakeImage>();
  const firewalls = new Map<string, FakeFirewall>();
  const sizes = options.sizes ?? defaultSizes();
  const calls: DoCall[] = [];
  let ids = 1000;
  const activeAt = new Map<number, number>();
  /** When a Droplet that is baking an image is done and switches itself off. */
  const bakedAt = new Map<number, number>();
  /** The snapshots taken of each Droplet, by image id. */
  const snapshots = new Map<number, number[]>();
  /** When the workspace on a Droplet starts answering. */
  const answersAt = new Map<number, number>();
  const failures: {
    match: RegExp;
    status: number;
    times: number;
    headers?: Record<string, string>;
    message: string;
    /** Run as the failure is sent, for what happened elsewhere meanwhile. */
    effect?: () => void;
  }[] = [];
  /** Action types that will start and never finish, for as many times as they are asked for. */
  const hanging = new Map<string, number>();
  /** Copies of images to other regions, as DigitalOcean lists them under the image. */
  const imageActions: {
    id: number;
    type: "transfer";
    status: "in-progress" | "completed";
    resource_type: "image";
    resource_id: number;
    /** Where it is going; not shown, as DigitalOcean does not show it either. */
    target: string;
  }[] = [];
  /** An image action as DigitalOcean lists it: a transfer does not say where it is going. */
  const imageActionView = (action: (typeof imageActions)[number]) => ({
    id: action.id,
    type: action.type,
    status: action.status,
    resource_type: action.resource_type,
    resource_id: action.resource_id,
    region: null,
    region_slug: "",
  });
  const completeTransfer = (action: (typeof imageActions)[number]) => {
    const image = images.get(action.resource_id);
    if (image && !image.regions.includes(action.target)) image.regions.push(action.target);
    action.status = "completed";
  };

  images.set(1234567, {
    id: 1234567,
    name: "hive-workspace-test",
    type: "snapshot",
    regions: ["nyc3", "sfo3"],
    min_disk_size: 25,
    size_gigabytes: 3.2,
    status: "available",
    tags: [],
    created_at: new Date().toISOString(),
  });

  images.set(99001, {
    id: 99001,
    name: "24.04 (LTS) x64",
    slug: "ubuntu-24-04-x64",
    type: "base",
    regions: REGIONS,
    min_disk_size: 7,
    size_gigabytes: 0.9,
    status: "available",
    tags: [],
    created_at: new Date().toISOString(),
  });

  const send = (
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "RateLimit-Limit": "5000",
      "RateLimit-Remaining": "4990",
      "RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 600),
      ...headers,
    });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const problem = (res: ServerResponse, status: number, id: string, message: string) =>
    send(res, status, { id, message, request_id: "fake-request" });
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.on("end", () => resolve(text));
    });

  const settleDroplet = (droplet: FakeDroplet) => {
    const at = activeAt.get(droplet.id);
    if (droplet.status === "new" && (at === undefined || Date.now() >= at)) {
      droplet.status = "active";
      answersAt.set(droplet.id, Date.now() + (options.bootDelayMs ?? 0));
      if (options.bakeMs !== undefined && droplet.userData.includes("/opt/hive-bake/bake.sh"))
        bakedAt.set(droplet.id, Date.now() + options.bakeMs);
    }
    const done = bakedAt.get(droplet.id);
    if (droplet.status === "active" && done !== undefined && Date.now() >= done)
      droplet.status = "off";
  };
  const settleAction = (action: FakeAction) => {
    if (action.status === "in-progress" && Date.now() >= action.doneAt) {
      action.apply();
      action.status = "completed";
      action.completed_at = new Date().toISOString();
    }
  };
  const view = (action: FakeAction) => {
    const { doneAt: _d, apply: _a, ...visible } = action;
    return visible;
  };
  const page = <T>(all: T[], url: URL) => {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 20), options.pageSize ?? 200);
    const at = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = all.slice((at - 1) * per, at * per);
    const more = at * per < all.length;
    return {
      slice,
      links: more ? { pages: { next: `${url.origin}${url.pathname}?page=${at + 1}` } } : {},
      meta: { total: all.length },
    };
  };
  const queueAction = (droplet: FakeDroplet, type: string, apply: () => void) => {
    const action: FakeAction = {
      id: ++ids,
      status: "in-progress",
      type,
      started_at: new Date().toISOString(),
      completed_at: null,
      resource_id: droplet.id,
      resource_type: "droplet",
      region_slug: droplet.region.slug,
      doneAt: Date.now() + (options.actionDelayMs ?? 0),
      apply,
    };
    const hung = hanging.get(type) ?? 0;
    if (hung > 0) {
      hanging.set(type, hung - 1);
      action.doneAt = Number.POSITIVE_INFINITY;
    }
    actions.set(action.id, action);
    return action;
  };
  /** The workspace's settings, as the first boot's cloud-init would write them from the Droplet's user data. */
  const settingsOf = (droplet: FakeDroplet): Record<string, string> | undefined => {
    if (!droplet.userData.startsWith("#cloud-config\n")) return undefined;
    const content = /path: \/etc\/hive\/workspace\.json[\s\S]*?content: ([A-Za-z0-9+/=]+)/.exec(
      droplet.userData,
    );
    if (!content) return undefined;
    return JSON.parse(Buffer.from(content[1] as string, "base64").toString("utf8"));
  };

  /** The token the Droplet's first boot writes for its Cloudflare tunnel, if it is given one. */
  const tunnelTokenOf = (droplet: FakeDroplet): string | undefined => {
    const content = /path: \/etc\/hive\/tunnel-token[\s\S]*?content: ([A-Za-z0-9+/=]+)/.exec(
      droplet.userData,
    );
    return content ? Buffer.from(content[1] as string, "base64").toString("utf8") : undefined;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const raw = await read(req);
    const method = req.method ?? "GET";

    // The workspace's own health check, as the public address would answer it.
    const publicHealth = /^\/public\/([\w-]+)\/api\/health$/.exec(path);
    if (publicHealth) {
      const where = await options.resolve?.(publicHealth[1] as string);
      if (where && !where.known) return send(res, 404, { error: "Unknown workspace" });
      if (where && !where.upstream)
        return send(res, 503, { error: "The workspace is not running" });
      for (const droplet of droplets.values()) {
        settleDroplet(droplet);
        if (
          droplet.status === "active" &&
          Date.now() >= (answersAt.get(droplet.id) ?? 0) &&
          droplet.tags.some((tag) => tag.endsWith(`-ws-${publicHealth[1]}`))
        )
          return send(res, 200, {
            ok: true,
            managed: true,
            workspace: settingsOf(droplet)?.WORKSPACE_ID,
          });
      }
      return send(res, 502, { error: "no workspace is answering" });
    }

    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });
    if (req.headers.authorization !== `Bearer ${token}`)
      return problem(res, 401, "unauthorized", "Unable to authenticate you");
    const failure = failures.find((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    if (failure) {
      failure.times--;
      failure.effect?.();
      return send(
        res,
        failure.status,
        { id: "injected", message: failure.message },
        failure.headers,
      );
    }

    const m = /^\/v2\/([a-z_]+)(?:\/([\w.-]+))?(?:\/([a-z_]+)(?:\/([\w.-]+))?)?$/.exec(path);
    if (!m) return problem(res, 404, "not_found", `no route ${path}`);
    const [, collection, id, sub, subId] = m;

    if (collection === "sizes" && !id && method === "GET") {
      const { slice, links, meta } = page(sizes, url);
      return send(res, 200, { sizes: slice, links, meta });
    }

    if (collection === "images" && id && sub === "actions" && !subId) {
      const image = images.get(Number(id));
      if (!image)
        return problem(res, 404, "not_found", "The resource you requested could not be found.");
      if (method === "GET") {
        const { slice, links, meta } = page(
          imageActions.filter((action) => action.resource_id === image.id).map(imageActionView),
          url,
        );
        return send(res, 200, { actions: slice, links, meta });
      }
      if (method === "POST") {
        const input = body as { type?: string; region?: string };
        if (input.type !== "transfer")
          return problem(res, 422, "unprocessable_entity", `Unknown action ${input.type}`);
        if (!input.region || !REGIONS.includes(input.region))
          return problem(res, 422, "unprocessable_entity", "Region is not available");
        if (image.regions.includes(input.region))
          return problem(res, 422, "unprocessable_entity", "Image already exists in that region");
        if (
          imageActions.some(
            (action) =>
              action.resource_id === image.id &&
              action.target === input.region &&
              action.status === "in-progress",
          )
        )
          return problem(
            res,
            422,
            "unprocessable_entity",
            "A transfer to that region is under way",
          );
        const action: (typeof imageActions)[number] = {
          id: ++ids,
          type: "transfer",
          status: "in-progress",
          resource_type: "image",
          resource_id: image.id,
          target: input.region,
        };
        imageActions.push(action);
        if (!options.holdTransfers) completeTransfer(action);
        return send(res, 201, { action: imageActionView(action) });
      }
    }

    if (collection === "images" && id && method === "GET") {
      const image = images.get(Number(id));
      if (!image)
        return problem(res, 404, "not_found", "The resource you requested could not be found.");
      return send(res, 200, { image });
    }

    if (collection === "firewalls" && id && !sub && method === "DELETE") {
      if (!firewalls.delete(id))
        return problem(res, 404, "not_found", "The resource you requested could not be found.");
      return send(res, 204);
    }

    if (collection === "firewalls" && !id) {
      if (method === "GET") {
        const { slice, links, meta } = page([...firewalls.values()], url);
        return send(res, 200, { firewalls: slice, links, meta });
      }
      if (method === "POST") {
        const input = body as Partial<FakeFirewall>;
        if (
          !input.name ||
          !Array.isArray(input.inbound_rules) ||
          !Array.isArray(input.outbound_rules)
        )
          return problem(res, 422, "unprocessable_entity", "A name and rules are required");
        for (const rule of input.inbound_rules) {
          const sources = rule.sources;
          if (!sources || (!sources.addresses?.length && !sources.tags?.length))
            return problem(res, 422, "unprocessable_entity", "A rule needs a source");
        }
        if ([...firewalls.values()].some((f) => f.name === input.name))
          return problem(res, 422, "unprocessable_entity", "Name has already been taken");
        const firewall: FakeFirewall = {
          id: `fw-${++ids}`,
          name: input.name,
          status: "succeeded",
          inbound_rules: input.inbound_rules,
          outbound_rules: input.outbound_rules,
          droplet_ids: input.droplet_ids ?? [],
          tags: input.tags ?? [],
        };
        firewalls.set(firewall.id, firewall);
        return send(res, 202, { firewall });
      }
    }

    if (collection === "actions" && id && !sub && method === "GET") {
      const action = actions.get(Number(id));
      if (!action)
        return problem(res, 404, "not_found", "The resource you requested could not be found.");
      settleAction(action);
      return send(res, 200, { action: view(action) });
    }

    if (collection === "droplets") {
      if (!id) {
        if (method === "GET") {
          for (const droplet of droplets.values()) settleDroplet(droplet);
          const name = url.searchParams.get("name");
          const tag = url.searchParams.get("tag_name");
          const matching = [...droplets.values()].filter(
            (d) =>
              (!name || d.name.toLowerCase() === name.toLowerCase()) &&
              (!tag || d.tags.includes(tag)),
          );
          const { slice, links, meta } = page(matching, url);
          return send(res, 200, { droplets: slice, links, meta });
        }
        if (method === "DELETE") {
          const tag = url.searchParams.get("tag_name");
          if (!tag) return problem(res, 422, "unprocessable_entity", "tag_name is required");
          for (const droplet of [...droplets.values()])
            if (droplet.tags.includes(tag)) droplets.delete(droplet.id);
          return send(res, 204);
        }
        if (method === "POST") {
          const input = body as {
            name?: string;
            region?: string;
            size?: string;
            image?: number | string;
            tags?: string[];
            user_data?: string;
            ssh_keys?: unknown[];
            vpc_uuid?: string;
            monitoring?: boolean;
            backups?: boolean;
            backup_policy?: { plan?: string; hour?: number; weekday?: string };
          };
          if (!input.name || !/^[a-zA-Z0-9.-]+$/.test(input.name))
            return problem(
              res,
              422,
              "unprocessable_entity",
              "Name can only contain letters, digits, dots and dashes",
            );
          if (!input.region || !REGIONS.includes(input.region))
            return problem(res, 422, "unprocessable_entity", "Region is not available");
          const chosen = sizes.find((s) => s.slug === input.size);
          if (!chosen) return problem(res, 422, "unprocessable_entity", "Size is not available");
          if (!chosen.available || !chosen.regions.includes(input.region))
            return problem(
              res,
              422,
              "unprocessable_entity",
              "Size is not available in this region",
            );
          const image =
            typeof input.image === "number"
              ? images.get(input.image)
              : [...images.values()].find((one) => one.slug === input.image);
          if (!image)
            return problem(
              res,
              422,
              "unprocessable_entity",
              "You specified an invalid image for Droplet creation.",
            );
          if (!image.regions.includes(input.region) || image.status !== "available")
            return problem(
              res,
              422,
              "unprocessable_entity",
              "The image is not available in this region",
            );
          if (chosen.disk < image.min_disk_size)
            return problem(
              res,
              422,
              "unprocessable_entity",
              "Size disk is smaller than the image's minimum",
            );
          if (
            !Array.isArray(input.tags) ||
            input.tags.some((tag) => !/^[a-zA-Z0-9:_-]{1,255}$/.test(tag))
          )
            return problem(
              res,
              422,
              "unprocessable_entity",
              "Tags may only contain letters, digits, colons, dashes and underscores",
            );
          const policy = input.backup_policy;
          if (
            policy &&
            (!["daily", "weekly"].includes(policy.plan ?? "") ||
              ![0, 4, 8, 12, 16, 20].includes(policy.hour ?? -1) ||
              (policy.weekday !== undefined &&
                !["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].includes(policy.weekday)))
          )
            return problem(res, 422, "unprocessable_entity", "The backup policy is not valid");
          if ((input.user_data ?? "").length > 65536)
            return problem(res, 422, "unprocessable_entity", "user_data is too large");
          const n = ++ids;
          const droplet: FakeDroplet = {
            id: n,
            name: input.name,
            status: "new",
            region: { slug: input.region },
            size_slug: chosen.slug,
            memory: chosen.memory,
            vcpus: chosen.vcpus,
            disk: chosen.disk,
            image: { id: image.id, name: image.name },
            tags: input.tags,
            vpc_uuid: input.vpc_uuid ?? "default-vpc",
            networks: {
              v4: [
                { ip_address: `10.116.0.${n % 250}`, type: "private" },
                { ip_address: `203.0.113.${n % 250}`, type: "public" },
              ],
              v6: [],
            },
            created_at: new Date().toISOString(),
            userData: input.user_data ?? "",
            sshKeys: input.ssh_keys ?? [],
            monitoring: Boolean(input.monitoring),
          };
          droplets.set(n, droplet);
          activeAt.set(n, Date.now() + (options.activeDelayMs ?? 0));
          return send(res, 202, { droplet, links: {} });
        }
      }

      const droplet = id ? droplets.get(Number(id)) : undefined;
      if (!droplet)
        return problem(res, 404, "not_found", "The resource you requested could not be found.");
      settleDroplet(droplet);
      if (!sub && method === "GET") return send(res, 200, { droplet });
      if (!sub && method === "DELETE") {
        droplets.delete(droplet.id);
        return send(res, 204);
      }
      if (sub === "snapshots" && !subId && method === "GET") {
        const mine = (snapshots.get(droplet.id) ?? [])
          .map((imageId) => images.get(imageId))
          .filter((image): image is FakeImage => image !== undefined);
        const { slice, links, meta } = page(mine, url);
        // DigitalOcean's list of a Droplet's snapshots leaves out each one's status; the image itself has it.
        return send(res, 200, {
          snapshots: slice.map(({ status: _status, ...image }) => image),
          links,
          meta,
        });
      }
      if (sub === "actions" && subId && method === "GET") {
        const action = actions.get(Number(subId));
        if (!action || action.resource_id !== droplet.id)
          return problem(res, 404, "not_found", "The resource you requested could not be found.");
        settleAction(action);
        return send(res, 200, { action: view(action) });
      }
      if (sub === "actions" && !subId && method === "POST") {
        const type = (body as { type?: string }).type;
        if (type === "power_on") {
          if (droplet.status === "active")
            return problem(res, 422, "unprocessable_entity", "Droplet is already powered on.");
          const action = queueAction(droplet, type, () => {
            droplet.status = "active";
            answersAt.set(droplet.id, Date.now() + (options.bootDelayMs ?? 0));
          });
          return send(res, 201, { action: view(action) });
        }
        if (type === "snapshot") {
          const name = (body as { name?: string }).name;
          if (!name) return problem(res, 422, "unprocessable_entity", "A name is required");
          const action = queueAction(droplet, type, () => {
            const image: FakeImage = {
              id: ++ids,
              name,
              type: "snapshot",
              regions: [droplet.region.slug],
              min_disk_size: droplet.disk,
              size_gigabytes: 4.2,
              status: "available",
              tags: [],
              created_at: new Date().toISOString(),
            };
            images.set(image.id, image);
            snapshots.set(droplet.id, [...(snapshots.get(droplet.id) ?? []), image.id]);
          });
          return send(res, 201, { action: view(action) });
        }
        if (type === "power_off" || type === "shutdown") {
          if (droplet.status === "off")
            return problem(res, 422, "unprocessable_entity", "Droplet is already powered off.");
          const action = queueAction(droplet, type, () => {
            droplet.status = "off";
          });
          return send(res, 201, { action: view(action) });
        }
        return problem(res, 422, "unprocessable_entity", `Unknown action ${type}`);
      }
    }
    return problem(res, 404, "not_found", `no route ${method} ${path}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    token,
    apiUrl: `${origin}/v2`,
    publicUrlTemplate: `${origin}/public/{id}`,
    droplets,
    images,
    firewalls,
    sizes,
    calls,
    imageActions,
    /** Finish every copy of an image that `holdTransfers` kept waiting. */
    finishTransfers() {
      for (const action of imageActions)
        if (action.status === "in-progress") completeTransfer(action);
    },
    /** Answer the next `times` requests that match `method path` with `status`. */
    failNext(
      match: RegExp,
      status: number,
      times = 1,
      headers?: Record<string, string>,
      message = "injected",
      effect?: () => void,
    ) {
      failures.push({ match, status, times, headers, message, effect });
    },
    /** The next `times` actions of this type are accepted and never complete. */
    hang(type: string, times = 1) {
      hanging.set(type, times);
    },
    /** The Droplet of a workspace, by the tag the provisioner gives it. */
    dropletOf(workspaceId: string) {
      return [...droplets.values()].find((d) =>
        d.tags.some((tag) => tag.endsWith(`-ws-${workspaceId}`)),
      );
    },
    /** What the Droplet's first boot writes as the workspace's settings. */
    settingsOf,
    tunnelTokenOf,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
