import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTunnel {
  id: string;
  name: string;
  account_tag: string;
  config_src: string;
  created_at: string;
  deleted_at: string | null;
  /** What the tunnel's token is made of; not shown by the API. */
  secret: string;
}
export interface FakeDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string;
}
export interface CloudflareCall {
  method: string;
  path: string;
  body?: unknown;
}
type Ingress = { hostname?: string; service: string }[];
/** The fields of a request body the stand-in looks at. */
interface RequestBody {
  name?: string;
  config_src?: string;
  config?: { ingress?: Ingress };
  type?: string;
  content?: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string;
}

/**
 * A stand-in for the parts of Cloudflare the tunnel code talks to: tunnels, their routes and
 * tokens, and DNS records, answered in Cloudflare's envelope. It refuses what Cloudflare's own
 * documentation says it would (a tunnel made without a name, a route list without a catch-all, a
 * tunnel deleted while it has a connection, a second record for a name that has one, a request
 * without the account's token) and fails or lags when told to.
 */
export async function fakeCloudflare(
  options: { token?: string; accountId?: string; zoneId?: string; pageSize?: number } = {},
) {
  const token = options.token ?? "cf-test-token";
  const accountId = options.accountId ?? "acct0123456789";
  const zoneId = options.zoneId ?? "zone0123456789";
  const tunnels = new Map<string, FakeTunnel>();
  const configs = new Map<string, Ingress>();
  const records = new Map<string, FakeDnsRecord>();
  /** Tunnels a connector is connected to, as if a machine were running `cloudflared` with their token. */
  const connected = new Set<string>();
  const calls: CloudflareCall[] = [];
  const failures: { match: RegExp; status: number; times: number }[] = [];

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const ok = (res: ServerResponse, result: unknown, extra: Record<string, unknown> = {}) =>
    send(res, 200, { success: true, errors: [], messages: [], result, ...extra });
  const refuse = (res: ServerResponse, status: number, code: number, message: string) =>
    send(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const page = <T>(all: T[], url: URL) => {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 20), options.pageSize ?? 1000);
    const at = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    return {
      slice: all.slice((at - 1) * per, at * per),
      info: {
        page: at,
        per_page: per,
        count: Math.min(per, Math.max(0, all.length - (at - 1) * per)),
        total_count: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / per)),
      },
    };
  };
  const shown = ({ secret: _secret, ...tunnel }: FakeTunnel) => tunnel;
  const active = (id: string) => {
    const tunnel = tunnels.get(id);
    return tunnel && !tunnel.deleted_at ? tunnel : undefined;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const raw = await read(req);
    let body: RequestBody | undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return refuse(res, 400, 9207, "Invalid JSON");
    }
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    if (req.headers.authorization !== `Bearer ${token}`)
      return refuse(res, 403, 10000, "Authentication error");
    const failure = failures.find((f) => f.times > 0 && f.match.test(`${method} ${url.pathname}`));
    if (failure) {
      failure.times--;
      return refuse(res, failure.status, 1000, "injected");
    }

    const tunnelRoute = new RegExp(
      `^/accounts/${accountId}/cfd_tunnel(?:/([\\w-]+))?(?:/(\\w+))?$`,
    ).exec(url.pathname);
    if (tunnelRoute) {
      const [, id, sub] = tunnelRoute;
      if (!id && method === "POST") {
        if (typeof body?.name !== "string" || !body.name)
          return refuse(res, 400, 1001, "Tunnel name is required");
        if (body.config_src !== "cloudflare" && body.config_src !== "local")
          return refuse(res, 400, 1001, "config_src must be local or cloudflare");
        if ([...tunnels.values()].some((t) => t.name === body.name && !t.deleted_at))
          return refuse(res, 409, 1013, "You already have a tunnel with this name");
        const tunnel: FakeTunnel = {
          id: randomUUID(),
          name: body.name,
          account_tag: accountId,
          config_src: body.config_src,
          created_at: new Date().toISOString(),
          deleted_at: null,
          secret: randomBytes(32).toString("base64"),
        };
        tunnels.set(tunnel.id, tunnel);
        return ok(res, shown(tunnel));
      }
      if (!id && method === "GET") {
        const name = url.searchParams.get("name");
        const deleted = url.searchParams.get("is_deleted");
        const found = [...tunnels.values()].filter(
          (t) =>
            (name === null || t.name === name) &&
            (deleted === null || deleted === "" || (deleted === "true") === Boolean(t.deleted_at)),
        );
        const { slice, info } = page(found.map(shown), url);
        return ok(res, slice, { result_info: info });
      }
      const tunnel = id ? active(id) : undefined;
      if (id && !tunnel) return refuse(res, 404, 1003, "Tunnel not found");
      if (tunnel && sub === "configurations" && method === "PUT") {
        const ingress = body?.config?.ingress as Ingress | undefined;
        if (!Array.isArray(ingress) || ingress.length === 0)
          return refuse(res, 400, 1015, "At least one ingress rule is required");
        const last = ingress[ingress.length - 1];
        if (!last || last.hostname || !last.service)
          return refuse(res, 400, 1015, "The last ingress rule must be a catch-all");
        if (ingress.slice(0, -1).some((rule) => !rule.hostname || !rule.service))
          return refuse(res, 400, 1015, "Every rule but the last needs a hostname and a service");
        configs.set(tunnel.id, ingress);
        return ok(res, { tunnel_id: tunnel.id, version: 1, config: body?.config });
      }
      if (tunnel && sub === "token" && method === "GET") {
        return ok(
          res,
          Buffer.from(JSON.stringify({ a: accountId, t: tunnel.id, s: tunnel.secret })).toString(
            "base64",
          ),
        );
      }
      if (tunnel && sub === "connections" && method === "DELETE") {
        connected.delete(tunnel.id);
        return ok(res, "");
      }
      if (tunnel && !sub && method === "DELETE") {
        if (connected.has(tunnel.id))
          return refuse(res, 400, 1022, "Cannot delete a tunnel that has active connections");
        tunnel.deleted_at = new Date().toISOString();
        configs.delete(tunnel.id);
        return ok(res, shown(tunnel));
      }
    }

    const dns = new RegExp(`^/zones/${zoneId}/dns_records(?:/([\\w-]+))?$`).exec(url.pathname);
    if (dns) {
      const id = dns[1];
      if (!id && method === "POST") {
        if (body?.type !== "CNAME" || !body.name || !body.content)
          return refuse(res, 400, 9005, "A CNAME record needs a name and content");
        if ([...records.values()].some((r) => r.name === body.name))
          return refuse(res, 400, 81053, "A record with that host already exists");
        const record: FakeDnsRecord = {
          id: randomUUID(),
          type: "CNAME",
          name: body.name,
          content: body.content,
          proxied: Boolean(body.proxied),
          ttl: body.ttl ?? 1,
          comment: body.comment,
        };
        records.set(record.id, record);
        return ok(res, record);
      }
      if (!id && method === "GET") {
        const name = url.searchParams.get("name");
        const found = [...records.values()].filter((r) => name === null || r.name === name);
        const { slice, info } = page(found, url);
        return ok(res, slice, { result_info: info });
      }
      const record = id ? records.get(id) : undefined;
      if (id && !record) return refuse(res, 404, 81044, "Record does not exist");
      if (record && method === "PATCH") {
        Object.assign(record, body);
        return ok(res, record);
      }
      if (record && method === "DELETE") {
        records.delete(record.id);
        return ok(res, { id: record.id });
      }
    }
    return refuse(res, 404, 7003, `No route for ${method} ${url.pathname}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** The token `cloudflared` is run with for a tunnel, as Cloudflare makes it. */
  const tokenOf = (tunnelId: string) => {
    const tunnel = tunnels.get(tunnelId);
    return tunnel
      ? Buffer.from(JSON.stringify({ a: accountId, t: tunnel.id, s: tunnel.secret })).toString(
          "base64",
        )
      : undefined;
  };

  return {
    token,
    accountId,
    zoneId,
    apiUrl: origin,
    tunnels,
    configs,
    records,
    calls,
    tokenOf,
    /** Answer the next `times` requests that match `METHOD /path` with `status`. */
    failNext(match: RegExp, status: number, times = 1) {
      failures.push({ match, status, times });
    },
    /** A machine runs `cloudflared` with this token: connected only if it is a live tunnel's. */
    connect(tunnelToken: string) {
      try {
        const claims = JSON.parse(Buffer.from(tunnelToken, "base64").toString("utf8"));
        const tunnel = active(claims.t);
        if (tunnel && tunnel.secret === claims.s && claims.a === accountId) {
          connected.add(tunnel.id);
          return true;
        }
      } catch {}
      return false;
    },
    disconnect(tunnelToken: string) {
      try {
        connected.delete(JSON.parse(Buffer.from(tunnelToken, "base64").toString("utf8")).t);
      } catch {}
    },
    isConnected: (tunnelId: string) => connected.has(tunnelId),
    /**
     * Whether a visitor to `hostname` would reach a connector: the name is a proxied CNAME to a live
     * tunnel that routes it, and that tunnel has a connection.
     */
    reaches(hostname: string): boolean {
      const record = [...records.values()].find((r) => r.name === hostname);
      if (!record?.proxied || !record.content.endsWith(".cfargotunnel.com")) return false;
      const id = record.content.slice(0, -".cfargotunnel.com".length);
      return (
        Boolean(active(id)) &&
        connected.has(id) &&
        (configs.get(id) ?? []).some((rule) => rule.hostname === hostname)
      );
    },
    liveTunnels: () => [...tunnels.values()].filter((t) => !t.deleted_at),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
