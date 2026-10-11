import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";

/** A self-signed certificate for `*.<domain>`, written as PEM files in `dir`. */
export function selfSignedCertificate(dir: string, domain: string, name = "edge") {
  const certFile = join(dir, `${name}-cert.pem`);
  const keyFile = join(dir, `${name}-key.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      `/CN=*.${domain}`,
      "-addext",
      `subjectAltName=DNS:*.${domain}`,
    ],
    { stdio: "ignore" },
  );
  return { certFile, keyFile, cert: readFileSync(certFile, "utf8") };
}

export interface ControlAnswer {
  status: number;
  upstream?: string;
}

/** A stand-in for the control plane's `/internal/upstream/:id`: what it says of each workspace is set by the test. */
export async function fakeControl(token: string) {
  const answers = new Map<string, ControlAnswer>();
  const asked: string[] = [];
  const seenTokens: (string | undefined)[] = [];
  let broken: number | null = null;
  const server = createServer((req, res) => {
    const match = /^\/internal\/upstream\/([\w-]+)$/.exec(req.url ?? "");
    seenTokens.push(req.headers.authorization);
    if (broken !== null) return void res.writeHead(broken).end("{}");
    if (!match) return void res.writeHead(404).end("{}");
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end("{}");
    const id = match[1] as string;
    asked.push(id);
    const answer = answers.get(id) ?? { status: 404 };
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer.upstream ? { upstream: answer.upstream } : { error: "no" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    answers,
    asked,
    seenTokens,
    /** Answer everything with this status, as a control plane having a bad moment would. */
    break(status: number | null) {
      broken = status;
    },
    askedAbout: (id: string) => asked.filter((a) => a === id).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export { sha256 };

/** A workspace server as the edge sees it: it echoes, streams, takes uploads, and switches protocols. */
export async function fakeWorkspace() {
  /** Requests the visitor gave up on before they were answered. */
  const abandoned: string[] = [];
  const upgrades: IncomingHttpHeaders[] = [];
  const big = randomBytes(5 * 1024 * 1024);
  // Every connection, upgraded ones too, which the server no longer keeps track of for itself.
  const sockets = new Set<Socket>();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://workspace");
    res.on("close", () => {
      if (!res.writableFinished) abandoned.push(url.pathname);
    });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(chunk as Buffer);
    } catch {
      // The visitor left in the middle of sending it.
      return void abandoned.push(url.pathname);
    }
    const body = Buffer.concat(chunks);
    if (url.pathname === "/echo") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-From-Workspace": "yes",
        "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
        Connection: "close, x-private",
        "X-Private": "hop",
      });
      return void res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body.toString("utf8"),
          remote: req.socket.remoteAddress,
        }),
      );
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("data: one\n\n");
      const gap = Number(url.searchParams.get("gap") ?? 400);
      const second = setTimeout(() => {
        res.write("data: two\n\n");
        res.end();
      }, gap);
      res.on("close", () => clearTimeout(second));
      return;
    }
    if (url.pathname === "/upload") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ bytes: body.length, sha256: sha256(body) }));
    }
    if (url.pathname === "/big") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return void res.end(big);
    }
    if (url.pathname === "/slow-headers") {
      const late = setTimeout(
        () => res.writeHead(200).end("late"),
        Number(url.searchParams.get("ms") ?? 600),
      );
      res.on("close", () => clearTimeout(late));
      return;
    }
    if (url.pathname === "/hang") return; // never answers; the request closes when the visitor goes
    res.writeHead(404).end("no");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.headers);
    socket.on("error", () => {});
    if (req.url === "/declined") {
      // Refused, with the connection left open, as a server that keeps connections alive would.
      return void socket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n",
      );
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    big,
    abandoned,
    upgrades,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The fingerprint of the certificate it was served with. */
  fingerprint?: string;
}

/** A call through the edge as a browser would make it: to the edge's port, naming the workspace's host. */
export function through(
  edge: { port: number; ca: string },
  host: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    signal?: AbortSignal;
    /** The name the certificate is checked for, when it is not the host's. */
    servername?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: edge.port,
        servername: init.servername ?? host.replace(/:\d+$/, ""),
        method: init.method ?? "GET",
        path,
        headers: { Host: host, ...init.headers },
        ca: edge.ca,
        agent: false,
        signal: init.signal,
      },
      (res) => {
        // Taken as the answer begins: by its end the connection may be gone.
        const fingerprint = (
          res.socket as unknown as { getPeerCertificate(): { fingerprint256: string } }
        ).getPeerCertificate().fingerprint256;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            fingerprint,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** Where a streamed response's pieces arrived, and when. */
export function streamThrough(
  edge: { port: number; ca: string },
  host: string,
  path: string,
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  pieces: { at: number; text: string }[];
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const pieces: { at: number; text: string }[] = [];
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: edge.port,
        servername: host,
        path,
        headers: { Host: host },
        ca: edge.ca,
        agent: false,
      },
      (res: IncomingMessage) => {
        res.on("data", (chunk: Buffer) =>
          pieces.push({ at: Date.now() - started, text: chunk.toString() }),
        );
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, pieces }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
