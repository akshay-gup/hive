import assert from "node:assert/strict";
import { copyFileSync, utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { connect as tlsConnect } from "node:tls";
import { type EdgeConfig, readEdgeConfig } from "../apps/edge/src/config.ts";
import { type Edge, startEdge, workspaceIdFor } from "../apps/edge/src/proxy.ts";
import { Resolver } from "../apps/edge/src/resolver.ts";
import {
  fakeControl,
  fakeWorkspace,
  selfSignedCertificate,
  sha256,
  streamThrough,
  through,
} from "./helpers/edge-stack.ts";

const TOKEN = "t".repeat(40);
let dir: string;
let control: Awaited<ReturnType<typeof fakeControl>>;
let workspace: Awaited<ReturnType<typeof fakeWorkspace>>;
let certificate: ReturnType<typeof selfSignedCertificate>;
let edge: Edge | undefined;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-edge-"));
  certificate = selfSignedCertificate(dir, "ws.test");
  control = await fakeControl(TOKEN);
  workspace = await fakeWorkspace();
  logs = [];
});
afterEach(async () => {
  await edge?.close();
  edge = undefined;
  await control.close();
  await workspace.close();
  await rm(dir, { recursive: true, force: true });
});

const environment = (over: Record<string, string> = {}) => ({
  EDGE_DOMAIN: "ws.test",
  EDGE_CONTROL_URL: control.url,
  EDGE_TOKEN: TOKEN,
  EDGE_TLS_CERT: certificate.certFile,
  EDGE_TLS_KEY: certificate.keyFile,
  ...over,
});
/** An edge on ports of its own, allowed to connect to this machine. */
async function start(over: Partial<EdgeConfig> = {}, resolver?: Resolver) {
  const config: EdgeConfig = {
    ...readEdgeConfig(environment()),
    host: "127.0.0.1",
    httpsPort: 0,
    httpPort: 0,
    upstreamAllow: ["127.0.0.0/8"],
    ...over,
  };
  edge = await startEdge(config, { log: (line) => logs.push(line), resolver });
  return { port: edge.ports.main, ca: certificate.cert };
}
const running = (id = "w1", origin = workspace.origin) =>
  control.answers.set(id, { status: 200, upstream: origin });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a request goes to the workspace its host names, with who sent it, and comes back whole", async () => {
  running();
  const front = await start();
  const reply = await through(front, "w1.ws.test", "/echo?x=1&y=two", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // A visitor cannot say who they are, nor pass on a header meant for one hop.
      "X-Forwarded-For": "6.6.6.6",
      "X-Forwarded-Proto": "http",
      "X-Real-IP": "6.6.6.6",
      Connection: "keep-alive, x-secret",
      "X-Secret": "hop",
      "X-Custom": "kept",
    },
    body: '{"a":1}',
  });
  assert.equal(reply.status, 200);
  const seen = JSON.parse(reply.body.toString());
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/echo?x=1&y=two");
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.headers["x-custom"], "kept");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(seen.headers["x-forwarded-proto"], "https");
  assert.equal(seen.headers["x-forwarded-host"], "w1.ws.test");
  // The workspace is sent the name people used, so what it builds links from is its public one.
  assert.equal(seen.headers.host, "w1.ws.test");
  assert.equal("x-real-ip" in seen.headers, false);
  assert.equal("x-secret" in seen.headers, false);

  assert.equal(reply.headers["x-from-workspace"], "yes");
  assert.deepEqual(reply.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal("x-private" in reply.headers, false);
  assert.equal(reply.headers["strict-transport-security"], "max-age=31536000");
});

test("a stream is passed on as it arrives and not when it ends", async () => {
  running();
  const front = await start();
  const stream = await streamThrough(front, "w1.ws.test", "/events?gap=500");
  assert.equal(stream.status, 200);
  assert.equal(stream.headers["content-type"], "text/event-stream");
  assert.equal(stream.pieces[0]?.text, "data: one\n\n");
  assert.ok((stream.pieces[0]?.at ?? 9999) < 300, "the first event was held back");
  assert.equal(stream.pieces.at(-1)?.text, "data: two\n\n");
  assert.ok((stream.pieces.at(-1)?.at ?? 0) >= 450);
});

test("big bodies go both ways unchanged", async () => {
  running();
  const front = await start();
  const upload = Buffer.alloc(5 * 1024 * 1024, "abcdefgh");
  const sent = await through(front, "w1.ws.test", "/upload", { method: "POST", body: upload });
  assert.deepEqual(JSON.parse(sent.body.toString()), {
    bytes: upload.length,
    sha256: sha256(upload),
  });
  const got = await through(front, "w1.ws.test", "/big");
  assert.equal(got.body.length, workspace.big.length);
  assert.equal(sha256(got.body), sha256(workspace.big));
});

test("a name that is not a workspace is not found, and the control plane is not troubled with it", async () => {
  running();
  const front = await start();
  for (const host of [
    "w1.example.com",
    "ws.test",
    "a.w1.ws.test",
    "-bad.ws.test",
    "w1_x.ws.test",
    "127.0.0.1",
  ]) {
    const reply = await through(front, host, "/echo", { servername: "w1.ws.test" });
    assert.equal(reply.status, 404, host);
    assert.deepEqual(JSON.parse(reply.body.toString()), { error: "Unknown workspace" });
  }
  assert.deepEqual(control.asked, []);
  // Case and a port do not matter.
  assert.equal((await through(front, "W1.WS.TEST", "/echo")).status, 200);
  assert.equal((await through(front, "w1.ws.test:8443", "/echo")).status, 200);
});

test("a workspace the control plane does not know is not found, and one that is stopped is not running", async () => {
  const front = await start({ negativeMs: 100 });
  const unknown = await through(front, "wnope.ws.test", "/echo");
  assert.equal(unknown.status, 404);
  control.answers.set("wasleep", { status: 503 });
  const stopped = await through(front, "wasleep.ws.test", "/echo");
  assert.equal(stopped.status, 503);
  assert.equal(stopped.headers["retry-after"], "5");
  assert.match(JSON.parse(stopped.body.toString()).error, /not running/);
  // It starts, and once what was believed has run out, it is reached.
  running("wasleep");
  await sleep(150);
  assert.equal((await through(front, "wasleep.ws.test", "/echo")).status, 200);
});

test("where a workspace is, is asked once and remembered, and questions made together are one", async () => {
  running();
  const front = await start({ cacheMs: 300, negativeMs: 300 });
  await Promise.all(Array.from({ length: 10 }, () => through(front, "w1.ws.test", "/echo")));
  assert.equal(control.askedAbout("w1"), 1);
  for (let i = 0; i < 20; i++) await through(front, "w1.ws.test", "/echo");
  assert.equal(control.askedAbout("w1"), 1);
  // What a name is not is remembered too, for a shorter time.
  await through(front, "wnope.ws.test", "/echo");
  await through(front, "wnope.ws.test", "/echo");
  assert.equal(control.askedAbout("wnope"), 1);
  await sleep(350);
  await through(front, "w1.ws.test", "/echo");
  assert.equal(control.askedAbout("w1"), 2);
  // The token it asks with is the one it was given, and only that.
  assert.ok(control.seenTokens.every((seen) => seen === `Bearer ${TOKEN}`));
});

test("names made up in bulk are not a flood of questions to the control plane", async () => {
  let out = 0;
  let most = 0;
  const answers: (() => void)[] = [];
  const resolver = new Resolver({
    controlUrl: "http://control.invalid",
    token: TOKEN,
    cacheMs: 1000,
    negativeMs: 1000,
    maxLookups: 3,
    fetch: (() => {
      out++;
      most = Math.max(most, out);
      return new Promise<Response>((resolve) =>
        answers.push(() => {
          out--;
          resolve(new Response("{}", { status: 404 }));
        }),
      );
    }) as typeof fetch,
  });
  const asked = Array.from({ length: 10 }, (_, i) => resolver.resolve(`w${i}`));
  assert.equal(most, 3);
  // The rest were not asked about, and are told what is said when the control plane cannot be asked.
  const turnedAway = await Promise.all(asked.slice(3));
  assert.ok(turnedAway.every((one) => one.status === "unavailable"));
  for (const answer of answers) answer();
  const answered = await Promise.all(asked.slice(0, 3));
  assert.ok(answered.every((one) => one.status === "unknown"));
  // With those answered, there is room again.
  const later = resolver.resolve("w9");
  assert.equal(out, 1);
  answers.at(-1)?.();
  assert.equal((await later).status, "unknown");
});

test("a workspace that has moved is found again after one failed request", async () => {
  const front = await start();
  running("w3", "http://127.0.0.1:1");
  const failed = await through(front, "w3.ws.test", "/echo");
  assert.equal(failed.status, 502);
  assert.equal(failed.headers["retry-after"], "2");
  assert.deepEqual(JSON.parse(failed.body.toString()), { error: "The workspace is not reachable" });
  running("w3");
  assert.equal((await through(front, "w3.ws.test", "/echo")).status, 200);
  assert.equal(control.askedAbout("w3"), 2);
});

test("a workspace that is slow to begin its answer is given up on", async () => {
  running();
  const front = await start({ headersTimeoutMs: 200 });
  const reply = await through(front, "w1.ws.test", "/slow-headers?ms=900");
  assert.equal(reply.status, 504);
  assert.equal(reply.headers["retry-after"], "2");
});

test("when the control plane cannot be asked, a workspace that was running is taken to still be, for a while", async () => {
  running();
  const resolver = new Resolver({
    controlUrl: control.url,
    token: TOKEN,
    cacheMs: 100,
    negativeMs: 100,
    staleMs: 500,
    coolOffMs: 50,
    log: (line) => logs.push(line),
  });
  const front = await start({}, resolver);
  assert.equal((await through(front, "w1.ws.test", "/echo")).status, 200);
  control.break(500);
  await sleep(150);
  assert.equal((await through(front, "w1.ws.test", "/echo")).status, 200);
  assert.ok(
    logs.some((line) => /could not ask the control plane about w1: it answered 500/.test(line)),
  );
  // One it never knew of cannot be guessed at.
  const stranger = await through(front, "wnever.ws.test", "/echo");
  assert.equal(stranger.status, 503);
  assert.equal(stranger.headers["retry-after"], "2");
  // And the belief runs out.
  await sleep(600);
  assert.equal((await through(front, "w1.ws.test", "/echo")).status, 503);
  // The control plane returns and so does the workspace.
  control.break(null);
  await sleep(100);
  assert.equal((await through(front, "w1.ws.test", "/echo")).status, 200);
});

test("a control plane that turns the edge away is reported without showing the token", async () => {
  running();
  const wrong = new Resolver({
    controlUrl: control.url,
    token: "w".repeat(40),
    cacheMs: 1000,
    negativeMs: 1000,
    log: (line) => logs.push(line),
  });
  const front = await start({ token: "w".repeat(40) }, wrong);
  assert.equal((await through(front, "w1.ws.test", "/echo")).status, 503);
  assert.ok(logs.some((line) => /it answered 401/.test(line)));
  assert.equal(logs.join("\n").includes("w".repeat(40)), false);
  assert.equal(logs.join("\n").includes(TOKEN), false);
});

test("the edge connects only to the address ranges it was told, whatever the control plane says", async () => {
  const front = await start({ upstreamAllow: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] });
  // The metadata service, the machine the edge is on, and a name: none is a workspace.
  for (const upstream of ["http://169.254.169.254:80", workspace.origin, "http://localhost:80"]) {
    control.answers.set("w1", { status: 200, upstream });
    const reply = await through(front, "w1.ws.test", "/echo");
    assert.equal(reply.status, 502, upstream);
    edge?.resolver.forget("w1");
  }
  assert.ok(logs.some((line) => /outside the ranges it may connect to/.test(line)));
  assert.deepEqual(workspace.abandoned, []);
});

test("an address that is not a plain http one is not believed", async () => {
  const front = await start();
  for (const upstream of [
    "https://127.0.0.1:1",
    "ftp://127.0.0.1",
    "not an address",
    "http://u:p@127.0.0.1",
  ]) {
    control.answers.set("w1", { status: 200, upstream });
    assert.equal((await through(front, "w1.ws.test", "/echo")).status, 503, upstream);
    edge?.resolver.forget("w1");
  }
});

test("a visitor who goes away takes the request to the workspace with them", async () => {
  running();
  const front = await start();
  const controller = new AbortController();
  const gone = through(front, "w1.ws.test", "/hang", { signal: controller.signal }).catch(() => {});
  await sleep(200);
  controller.abort();
  await gone;
  for (let i = 0; i < 40 && !workspace.abandoned.includes("/hang"); i++) await sleep(25);
  assert.ok(workspace.abandoned.includes("/hang"));
});

/** A connection to the edge that is spoken on by hand: what arrives is collected, and `ended` says when it was closed. */
async function raw(front: { port: number; ca: string }, servername: string) {
  const socket = tlsConnect({ host: "127.0.0.1", port: front.port, servername, ca: front.ca });
  let text = "";
  let ended = false;
  socket.on("data", (data) => {
    text += data.toString();
  });
  socket.on("close", () => {
    ended = true;
  });
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    get text() {
      return text;
    },
    get ended() {
      return ended;
    },
    /** Waits until what has arrived satisfies `done`, for up to a second. */
    async until(done: (text: string, ended: boolean) => boolean) {
      for (let i = 0; i < 40 && !done(text, ended); i++) await sleep(25);
      return text;
    },
  };
}
const handshake = (host: string, path = "/socket", extra = "") =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extra}Sec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`;

test("a visitor who leaves in the middle of an upload does not make the edge lose the workspace", async () => {
  running();
  const front = await start();
  await through(front, "w1.ws.test", "/echo");
  assert.equal(control.askedAbout("w1"), 1);
  const upload = httpsRequest({
    host: "127.0.0.1",
    port: front.port,
    servername: "w1.ws.test",
    method: "POST",
    path: "/upload",
    headers: { Host: "w1.ws.test", "Content-Length": "1000000" },
    ca: front.ca,
    agent: false,
  });
  upload.on("error", () => {});
  upload.write("only the start of it");
  await sleep(150);
  upload.destroy();
  for (let i = 0; i < 40 && !workspace.abandoned.includes("/upload"); i++) await sleep(25);
  assert.ok(workspace.abandoned.includes("/upload"));
  assert.equal((await through(front, "w1.ws.test", "/echo")).status, 200);
  assert.equal(control.askedAbout("w1"), 1);
});

test("a websocket is passed through byte for byte, with who asked", async () => {
  running();
  const front = await start();
  const conn = await raw(front, "w1.ws.test");
  conn.socket.write(handshake("w1.ws.test", "/socket", "X-Forwarded-For: 6.6.6.6\r\n"));
  await conn.until((text) => text.includes("\r\n\r\n"));
  assert.match(conn.text, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(conn.text, /\r\nUpgrade: websocket\r\n/);
  conn.socket.write("ping");
  await conn.until((text) => text.includes("echo:ping"));
  assert.ok(conn.text.endsWith("echo:ping"));
  conn.socket.destroy();
  assert.equal(workspace.upgrades[0]?.["x-forwarded-for"], "127.0.0.1");
  assert.equal(workspace.upgrades[0]?.["x-forwarded-host"], "w1.ws.test");
  assert.equal(workspace.upgrades[0]?.upgrade, "websocket");
  assert.equal(workspace.upgrades[0]?.["sec-websocket-key"], "dGVzdA==");
});

test("a websocket to a workspace that is not there is turned away", async () => {
  const front = await start();
  const conn = await raw(front, "wnope.ws.test");
  conn.socket.write(handshake("wnope.ws.test"));
  await conn.until((_, ended) => ended);
  assert.match(conn.text, /^HTTP\/1\.1 404 Not Found/);
  assert.ok(conn.ended);
});

test("a workspace that will not switch to a websocket has its answer passed on, and the connection ends", async () => {
  running();
  const front = await start();
  const conn = await raw(front, "w1.ws.test");
  // The workspace answers and keeps its end open, as a server that keeps connections alive would.
  conn.socket.write(handshake("w1.ws.test", "/declined"));
  await conn.until((_, ended) => ended);
  assert.match(conn.text, /^HTTP\/1\.1 403 Forbidden/);
  assert.ok(conn.ended, "the visitor's connection was left open to the workspace");
});

test("only websockets are switched to, so nothing else is left talking to a workspace unseen", async () => {
  running();
  const front = await start();
  const conn = await raw(front, "w1.ws.test");
  conn.socket.write(
    "GET / HTTP/1.1\r\nHost: w1.ws.test\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
  );
  await conn.until((_, ended) => ended);
  assert.match(conn.text, /^HTTP\/1\.1 400 Bad Request/);
  assert.deepEqual(workspace.upgrades, []);
});

test("a request for an address and not a path is not passed on", async () => {
  running();
  const front = await start();
  const conn = await raw(front, "w1.ws.test");
  conn.socket.write("GET http://169.254.169.254/latest HTTP/1.1\r\nHost: w1.ws.test\r\n\r\n");
  await conn.until((text) => text.includes("\r\n\r\n"));
  assert.match(conn.text, /^HTTP\/1\.1 400 Bad Request/);
  conn.socket.destroy();
  assert.deepEqual(workspace.abandoned, []);
});

test("http requests are sent to https, and only for workspace names", async () => {
  running();
  const front = await start();
  const ask = (host: string, path: string) =>
    new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: edge?.ports.redirect as number,
          path,
          headers: { Host: host },
          agent: false,
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, location: res.headers.location });
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.deepEqual(await ask("w1.ws.test", "/a?b=1"), {
    status: 308,
    location: `https://w1.ws.test:${front.port}/a?b=1`,
  });
  assert.equal((await ask("evil.example.com", "/")).status, 404);
});

test("a renewed certificate is served without a restart, and one that does not belong is refused", async () => {
  running();
  const front = await start();
  const first = (await through(front, "w1.ws.test", "/echo")).fingerprint;
  assert.equal(await edge?.reloadCertificate(), false);

  const renewed = selfSignedCertificate(dir, "ws.test", "renewed");
  const later = Date.now() / 1000 + 10;
  copyFileSync(renewed.certFile, certificate.certFile);
  copyFileSync(renewed.keyFile, certificate.keyFile);
  utimesSync(certificate.certFile, later, later);
  utimesSync(certificate.keyFile, later, later);
  assert.equal(await edge?.reloadCertificate(), true);
  const second = await through({ port: front.port, ca: renewed.cert }, "w1.ws.test", "/echo");
  assert.notEqual(second.fingerprint, first);
  assert.equal(second.status, 200);

  // A certificate with another one's key is no use: what is served stays.
  const other = selfSignedCertificate(dir, "ws.test", "other");
  copyFileSync(other.certFile, certificate.certFile);
  utimesSync(certificate.certFile, later + 10, later + 10);
  assert.equal(await edge?.reloadCertificate(), false);
  assert.ok(logs.some((line) => /kept the certificate it has/.test(line)));
  const still = await through({ port: front.port, ca: renewed.cert }, "w1.ws.test", "/echo");
  assert.equal(still.fingerprint, second.fingerprint);
});

test("behind something that ends TLS, it speaks plain http and carries the chain of addresses on", async () => {
  running();
  const config = readEdgeConfig(environment({ EDGE_TLS: "off" }));
  assert.equal(config.tls, null);
  assert.equal(config.httpPort, null);
  edge = await startEdge(
    { ...config, host: "127.0.0.1", httpsPort: 0, upstreamAllow: ["127.0.0.0/8"] },
    { log: (line) => logs.push(line) },
  );
  assert.equal(edge.ports.redirect, null);
  const seen = await new Promise<{ headers: Record<string, string>; status: number }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: edge?.ports.main,
          path: "/echo",
          headers: {
            Host: "w1.ws.test",
            "X-Forwarded-For": "203.0.113.9",
            "X-Forwarded-Proto": "https",
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: JSON.parse(Buffer.concat(chunks).toString()).headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(seen.status, 200);
  assert.equal(seen.headers["x-forwarded-for"], "203.0.113.9, 127.0.0.1");
  assert.equal(seen.headers["x-forwarded-proto"], "https");
});

test("it answers its own health check whoever asks and for whatever name", async () => {
  const front = await start();
  // A monitor reaches it by address, so the host it names is no workspace's; the certificate is
  // checked against a name it does cover.
  for (const host of ["127.0.0.1", "example.org", "ws.test"]) {
    const reply = await through(front, host, "/__edge/health", { servername: "probe.ws.test" });
    assert.equal(reply.status, 200, host);
    assert.deepEqual(JSON.parse(reply.body.toString()), { ok: true });
  }
});

test("the workspace a host names is read from the host and nothing else", () => {
  assert.equal(workspaceIdFor("w4k9t2mx7a.ws.example.com", "ws.example.com"), "w4k9t2mx7a");
  assert.equal(workspaceIdFor("W4K9.WS.EXAMPLE.COM.:443", "ws.example.com"), "w4k9");
  assert.equal(workspaceIdFor("ws.example.com", "ws.example.com"), null);
  assert.equal(workspaceIdFor("a.b.ws.example.com", "ws.example.com"), null);
  assert.equal(workspaceIdFor("x.ws.example.com.evil.test", "ws.example.com"), null);
  assert.equal(workspaceIdFor("evilws.example.com", "ws.example.com"), null);
  assert.equal(workspaceIdFor("[::1]:443", "ws.example.com"), null);
  assert.equal(workspaceIdFor(undefined, "ws.example.com"), null);
  assert.equal(workspaceIdFor(`${"a".repeat(64)}.ws.example.com`, "ws.example.com"), null);
});
