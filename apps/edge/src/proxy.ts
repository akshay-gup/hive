import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type ClientRequest,
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import { createSecureContext } from "node:tls";
import { allowedAddress, type EdgeConfig } from "./config.ts";
import { Resolver } from "./resolver.ts";

/** Headers that describe one hop of a connection and are not the proxy's to pass on. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Headers a visitor must not be able to set for the workspace: the edge says who they are. */
const FORWARDING = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "forwarded",
  "x-real-ip",
]);

/** The workspace id a hostname names (`<id>.<domain>`), or null when it names none. */
export function workspaceIdFor(hostHeader: string | undefined, domain: string): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(label) ? label : null;
}

const named = (headers: IncomingHttpHeaders) =>
  new Set(
    String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

/** Where a request goes, or why it goes nowhere and what to tell the visitor. */
type Route =
  | { ok: true; id: string; host: string; port: number }
  | { ok: false; status: number; message: string; headers?: Record<string, string> };
const refusal = (status: number, message: string, headers?: Record<string, string>): Route => ({
  ok: false,
  status,
  message,
  headers,
});

export interface Edge {
  /** The ports it listens on; useful when it was told to pick them. */
  ports: { main: number; redirect: number | null };
  /** Read the certificate files again if they changed. True when a new certificate is now being served. */
  reloadCertificate(): Promise<boolean>;
  resolver: Resolver;
  close(): Promise<void>;
}

export interface EdgeOptions {
  resolver?: Resolver;
  log?: (line: string) => void;
}

/**
 * The public face of workspaces on machines of their own: ends TLS with one certificate for every
 * workspace's name, works out which machine a name is for by asking the control plane, and passes
 * the request on, streams and upgrades included. It adds what the workspace needs to know of the
 * visitor and takes away what a visitor must not be able to say. It connects only to addresses in
 * the ranges it was told, whatever it is told by the control plane.
 */
export async function startEdge(config: EdgeConfig, options: EdgeOptions = {}): Promise<Edge> {
  const log = options.log ?? ((line: string) => console.log(`[Hive edge] ${line}`));
  const resolver =
    options.resolver ??
    new Resolver({
      controlUrl: config.controlUrl,
      token: config.token,
      cacheMs: config.cacheMs,
      negativeMs: config.negativeMs,
      log,
    });
  const secure = config.tls !== null;

  const send = (
    res: ServerResponse,
    status: number,
    error: string,
    headers: Record<string, string> = {},
  ) => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
      ...headers,
    });
    res.end(JSON.stringify({ error }));
  };

  /** What the workspace is sent of a request: the visitor's headers, less what is for one hop, plus who they are. */
  const forwarded = (req: IncomingMessage, upgrade: boolean) => {
    const out: Record<string, string | string[]> = {};
    const hops = named(req.headers);
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase();
      if (value === undefined || HOP_BY_HOP.has(key) || hops.has(key)) continue;
      if (FORWARDING.has(key) && secure) continue;
      out[name] = value;
    }
    const remote = req.socket.remoteAddress ?? "";
    // Behind another proxy the chain it started is carried on; facing visitors, it starts here.
    const before = secure ? "" : String(req.headers["x-forwarded-for"] ?? "");
    out["x-forwarded-for"] = before ? `${before}, ${remote}` : remote;
    out["x-forwarded-proto"] = secure
      ? "https"
      : String(req.headers["x-forwarded-proto"] ?? "https");
    out["x-forwarded-host"] = String(req.headers.host ?? "");
    if (upgrade) {
      out.connection = "Upgrade";
      out.upgrade = String(req.headers.upgrade ?? "");
    }
    return out;
  };

  /** Where a request is going, or the reason it is going nowhere. */
  const route = async (req: IncomingMessage): Promise<Route> => {
    const id = workspaceIdFor(req.headers.host, config.domain);
    if (!id) return refusal(404, "Unknown workspace");
    const found = await resolver.resolve(id);
    if (found.status === "unknown") return refusal(404, "Unknown workspace");
    if (found.status === "stopped")
      return refusal(503, "The workspace is not running", { "Retry-After": "5" });
    if (found.status === "unavailable")
      return refusal(503, "The workspace cannot be found right now", { "Retry-After": "2" });
    if (!allowedAddress(found.host, config.upstreamAllow)) {
      log(`${id} is at ${found.host}, which is outside the ranges it may connect to`);
      resolver.forget(id);
      return refusal(502, "The workspace is not reachable", { "Retry-After": "5" });
    }
    return { ok: true, id, host: found.host, port: found.port };
  };

  /** A request to the workspace, made to the machine `where` names, on a connection of its own. */
  const requestTo = (
    req: IncomingMessage,
    where: { host: string; port: number },
    upgrade: boolean,
  ) =>
    httpRequest({
      host: where.host,
      port: where.port,
      method: req.method,
      path: req.url,
      headers: forwarded(req, upgrade),
      // The workspace is sent the visitor's Host, so what it builds links from is its public name.
      setHost: false,
      // A new connection to the workspace for each request: they are on a private network, and a
      // pooled one the workspace has just closed would be a request that fails for no reason.
      agent: false,
    });

  /**
   * Gives up on a request to a workspace that is slow to accept the connection, or to begin its
   * answer once it has the whole request. Returns what to call when it has answered.
   */
  const impatient = (upstream: ClientRequest) => {
    let waiting: ReturnType<typeof setTimeout> | undefined;
    upstream.on("socket", (socket) => {
      if (!socket.connecting) return;
      const late = setTimeout(
        () => upstream.destroy(new Error("connect timeout")),
        config.connectTimeoutMs,
      );
      socket.once("connect", () => clearTimeout(late));
      socket.once("close", () => clearTimeout(late));
    });
    upstream.on("finish", () => {
      waiting = setTimeout(
        () => upstream.destroy(new Error("headers timeout")),
        config.headersTimeoutMs,
      );
    });
    return () => clearTimeout(waiting);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/__edge/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return void res.end(JSON.stringify({ ok: true }));
    }
    // Only a path is passed on: not an address for the workspace to go and fetch from.
    if (!req.url?.startsWith("/")) return send(res, 400, "Bad request");
    const where = await route(req);
    if (!where.ok) return send(res, where.status, where.message, where.headers);

    const upstream = requestTo(req, where, false);
    const answeredBy = impatient(upstream);
    let answered = false;
    upstream.on("response", (answer) => {
      answered = true;
      answeredBy();
      const headers: Record<string, string | string[]> = {};
      const hops = named(answer.headers);
      for (const [name, value] of Object.entries(answer.headers)) {
        const key = name.toLowerCase();
        if (value !== undefined && !HOP_BY_HOP.has(key) && !hops.has(key)) headers[name] = value;
      }
      if (
        secure &&
        !Object.keys(headers).some((n) => n.toLowerCase() === "strict-transport-security")
      )
        headers["Strict-Transport-Security"] = "max-age=31536000";
      res.writeHead(answer.statusCode ?? 502, headers);
      // Streams (server-sent events) are not held back until they have filled a buffer.
      res.flushHeaders();
      pipeline(answer, res, () => {});
    });
    upstream.on("error", (error) => {
      answeredBy();
      if (answered) return void res.destroy();
      // A visitor who left is no news of the workspace.
      if (res.destroyed || req.socket.destroyed) return;
      resolver.forget(where.id);
      const slow = /timeout/.test(error.message);
      log(`${where.id}: ${error.message}`);
      send(res, slow ? 504 : 502, "The workspace is not reachable", { "Retry-After": "2" });
    });
    // A visitor who goes away takes the request to the workspace with them.
    res.on("close", () => {
      answeredBy();
      if (!res.writableEnded) upstream.destroy();
    });
    pipeline(req, upstream, () => {});
  };

  // Connections that have been switched to another protocol, which the server no longer keeps track of.
  const tunnels = new Set<Duplex>();

  /**
   * A websocket: once the workspace has agreed to switch, the connection is passed through, byte
   * for byte. Nothing else is switched to, since what follows a switch the edge cannot see.
   */
  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const refuse = (status: number) =>
      void socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    if (String(req.headers.upgrade).toLowerCase() !== "websocket" || !req.url?.startsWith("/"))
      return refuse(400);
    const where = await route(req).catch(() => null);
    if (!where) return refuse(502);
    if (!where.ok) return refuse(where.status);

    const upstream = requestTo(req, where, true);
    const answeredBy = impatient(upstream);
    upstream.on("upgrade", (answer, workspace, ahead) => {
      answeredBy();
      workspace.on("error", () => workspace.destroy());
      workspace.on("close", () => socket.destroy());
      socket.on("close", () => workspace.destroy());
      tunnels.add(socket);
      socket.once("close", () => tunnels.delete(socket));
      let text = `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n`;
      for (let i = 0; i + 1 < answer.rawHeaders.length; i += 2)
        text += `${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`;
      socket.write(`${text}\r\n`);
      if (ahead.length) socket.write(ahead);
      if (head.length) workspace.write(head);
      socket.pipe(workspace);
      workspace.pipe(socket);
    });
    // The workspace did not agree to switch: its status is passed on, and the connection ends there.
    upstream.on("response", (answer) => {
      answeredBy();
      answer.resume();
      refuse(answer.statusCode ?? 502);
    });
    upstream.on("error", (error) => {
      answeredBy();
      if (socket.destroyed) return;
      resolver.forget(where.id);
      log(`${where.id}: ${error.message}`);
      refuse(/timeout/.test(error.message) ? 504 : 502);
    });
    socket.on("close", () => upstream.destroy());
    upstream.end();
  };

  // The certificate, and the servers.
  let served = { cert: "", key: "", mtimes: "" };
  const mtimes = () =>
    config.tls
      ? `${statSync(config.tls.certFile).mtimeMs}:${statSync(config.tls.keyFile).mtimeMs}`
      : "";
  const readTls = async () => {
    if (!config.tls) return null;
    const [cert, key] = await Promise.all([
      readFile(config.tls.certFile, "utf8"),
      readFile(config.tls.keyFile, "utf8"),
    ]);
    return { cert, key, mtimes: mtimes() };
  };
  const first = await readTls();
  if (first) served = first;

  const main: Server | HttpsServer = first
    ? createHttpsServer({ cert: first.cert, key: first.key, minVersion: "TLSv1.2" })
    : createHttpServer();
  main.on("request", (req, res) => {
    handle(req, res).catch((error) => {
      log(`request failed: ${error instanceof Error ? error.message : error}`);
      send(res, 500, "Something went wrong");
    });
  });
  main.on("upgrade", (req, socket, head) => {
    upgrade(req, socket, head).catch(() => socket.destroy());
  });
  main.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  // Time to send the headers, and to send the whole request; a stream that is being read has no limit.
  main.headersTimeout = 30_000;
  main.requestTimeout = 600_000;
  main.keepAliveTimeout = 65_000;

  const redirect: Server | null =
    secure && config.httpPort !== null
      ? createHttpServer((req, res) => {
          const id = workspaceIdFor(req.headers.host, config.domain);
          if (!id) return send(res, 404, "Unknown workspace");
          const host = String(req.headers.host).replace(/:\d+$/, "");
          const port = (main.address() as { port: number } | null)?.port ?? config.httpsPort;
          const path = req.url?.startsWith("/") ? req.url : "/";
          res.writeHead(308, {
            Location: `https://${host}${port === 443 ? "" : `:${port}`}${path}`,
          });
          res.end();
        })
      : null;

  const listen = (server: Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, config.host, () => {
        server.off("error", reject);
        resolve((server.address() as { port: number }).port);
      });
    });
  const mainPort = await listen(main, config.httpsPort);
  const redirectPort = redirect ? await listen(redirect, config.httpPort as number) : null;
  log(
    `${secure ? "https" : "http"} on ${mainPort}${redirectPort ? `, http on ${redirectPort}` : ""} for *.${config.domain}`,
  );

  const reloadCertificate = async () => {
    if (!config.tls || !("setSecureContext" in main)) return false;
    try {
      if (mtimes() === served.mtimes) return false;
      const next = await readTls();
      if (!next || (next.cert === served.cert && next.key === served.key)) {
        if (next) served.mtimes = next.mtimes;
        return false;
      }
      // A pair that does not belong together is refused here, and the old one is kept.
      createSecureContext({ cert: next.cert, key: next.key });
      (main as HttpsServer).setSecureContext({ cert: next.cert, key: next.key });
      served = next;
      log("serving a renewed certificate");
      return true;
    } catch (error) {
      log(`kept the certificate it has: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  };
  const timer = config.tls
    ? setInterval(() => void reloadCertificate(), Math.max(1000, config.reloadMs))
    : null;
  timer?.unref();

  return {
    ports: { main: mainPort, redirect: redirectPort },
    reloadCertificate,
    resolver,
    close: async () => {
      if (timer) clearInterval(timer);
      const closing = [main, redirect]
        .filter((s): s is Server => s !== null)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
      // Streams that are still open get a moment, and then they are ended.
      const forced = setTimeout(() => {
        for (const server of [main, redirect]) server?.closeAllConnections();
        for (const tunnel of tunnels) tunnel.destroy();
      }, 5000);
      for (const server of [main, redirect]) server?.closeIdleConnections();
      await Promise.all(closing);
      clearTimeout(forced);
    },
  };
}
