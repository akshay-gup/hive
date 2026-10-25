import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  buildRunContext,
  fetchRunFiles,
  safeFileName,
} from "../apps/server/src/chat-runner/context.ts";
import { RunnerLink, type SocketLike } from "../apps/server/src/chat-runner/link.ts";
import type { RoomFrame, RunnerFrame, RunStart } from "../packages/domain/src/chat-agent.ts";

interface FakeSocket extends SocketLike {
  sent: string[];
  closed?: { code?: number; reason?: string };
  url: string;
  protocols: string[];
}

let sockets: FakeSocket[];
let tokens: number;
let tokenFails: boolean;
let received: RoomFrame[];
let opened: number;
let closedWith: number[];
let link: RunnerLink;

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  sockets = [];
  tokens = 0;
  tokenFails = false;
  received = [];
  opened = 0;
  closedWith = [];
  link = new RunnerLink({
    tokenUrl: "https://control.test/v1/release/w1/runner-token",
    key: "hwk_w1.key",
    onFrame: (frame) => received.push(frame),
    onOpen: () => {
      opened++;
    },
    onClose: (code) => closedWith.push(code),
    random: () => 0.5,
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://control.test/v1/release/w1/runner-token");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer hwk_w1.key");
      if (tokenFails) return new Response("{}", { status: 503 });
      tokens++;
      return Response.json({
        token: `token-${tokens}`,
        url: "wss://chat.test/w/w1/agent/v1/connect",
        expiresAt: Date.now() + 600_000,
      });
    }) as typeof fetch,
    socket: (url, protocols) => {
      const sock: FakeSocket = {
        url,
        protocols,
        sent: [],
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (text) => void sock.sent.push(text),
        close: (code, reason) => {
          sock.closed = { code, reason };
        },
      };
      sockets.push(sock);
      return sock;
    },
  });
});
afterEach(() => {
  link.stop();
  mock.timers.reset();
});

const up = async () => {
  link.start();
  await flush();
  const sock = sockets.at(-1);
  assert.ok(sock);
  sock.onopen?.({});
  return sock;
};
const drop = async (sock: FakeSocket, code = 1006) => {
  sock.onclose?.({ code, reason: "" });
  await flush();
};

test("it gets a token with the workspace's key, connects with the token as a subprotocol, and says it is open", async () => {
  const sock = await up();
  assert.equal(sock.url, "wss://chat.test/w/w1/agent/v1/connect");
  assert.deepEqual(sock.protocols, ["hive.runner.v1", "token-1"]);
  assert.equal(opened, 1);
  assert.equal(link.open, true);
  assert.equal(link.origin, "https://chat.test");
  assert.equal(link.send({ t: "beat", runIds: ["r1"] }), true);
  assert.deepEqual(
    sock.sent.map((s) => JSON.parse(s)),
    [{ t: "beat", runIds: ["r1"] }],
  );
});

test("what the room says is passed on, and a pong, junk and a frame without a kind are not", async () => {
  const sock = await up();
  sock.onmessage?.({ data: JSON.stringify({ t: "ack", runId: "r1" }) });
  sock.onmessage?.({ data: "pong" });
  sock.onmessage?.({ data: "not json" });
  sock.onmessage?.({ data: JSON.stringify({ nothing: true }) });
  sock.onmessage?.({ data: new ArrayBuffer(2) });
  assert.deepEqual(received, [{ t: "ack", runId: "r1" }]);
});

test("nothing is sent while it is not connected", async () => {
  assert.equal(link.send({ t: "beat", runIds: [] }), false);
  const sock = await up();
  await drop(sock);
  assert.equal(link.send({ t: "beat", runIds: [] }), false);
  assert.equal(link.open, false);
  assert.deepEqual(closedWith, [1006]);
});

test("after a drop it goes back with a wait that grows, and a long stay forgets the failures", async () => {
  const first = await up();
  await drop(first);
  assert.equal(sockets.length, 1);
  // A first wait of about a second (the jitter is fixed at half in this test: 0.75 of the step).
  mock.timers.tick(600);
  await flush();
  assert.equal(sockets.length, 1, "not yet");
  mock.timers.tick(400);
  await flush();
  assert.equal(sockets.length, 2);
  // It drops again before it ever opened: the wait is longer.
  await drop(sockets[1] as FakeSocket);
  mock.timers.tick(1_000);
  await flush();
  assert.equal(sockets.length, 2);
  mock.timers.tick(1_000);
  await flush();
  assert.equal(sockets.length, 3);
  // This one opens and stays up a while: the next wait is short again.
  const third = sockets[2] as FakeSocket;
  third.onopen?.({});
  mock.timers.tick(20_000);
  await drop(third);
  mock.timers.tick(1_000);
  await flush();
  assert.equal(sockets.length, 4);
});

test("a connection another took the place of waits a long time before it tries again", async () => {
  const sock = await up();
  await drop(sock, 4409);
  mock.timers.tick(5_000);
  await flush();
  assert.equal(sockets.length, 1);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(sockets.length, 2);
});

test("a token that cannot be had is asked for again, and a stopped link stays stopped", async () => {
  tokenFails = true;
  link.start();
  await flush();
  assert.equal(sockets.length, 0);
  tokenFails = false;
  mock.timers.tick(2_000);
  await flush();
  assert.equal(sockets.length, 1);
  link.stop();
  const sock = sockets[0] as FakeSocket;
  assert.equal(sock.closed?.code, 1000);
  mock.timers.tick(120_000);
  await flush();
  assert.equal(sockets.length, 1);
});

test("the token is renewed over the same connection before it runs out", async () => {
  const sock = await up();
  mock.timers.tick(600_000 * 0.7 + 10);
  await flush();
  assert.equal(tokens, 2);
  const frames = sock.sent
    .filter((s) => s !== "ping")
    .map((s) => JSON.parse(s) as RunnerFrame)
    .filter((f) => f.t === "renew");
  assert.deepEqual(frames, [{ t: "renew", token: "token-2" }]);
  // And again, with the new one's life.
  mock.timers.tick(600_000 * 0.7 + 10);
  await flush();
  assert.equal(tokens, 3);
});

test("a connection that does not answer a ping is ended and made again", async () => {
  const sock = await up();
  mock.timers.tick(25_000);
  await flush();
  assert.ok(sock.sent.includes("ping"));
  mock.timers.tick(12_500);
  await flush();
  assert.equal(sock.closed?.code, 4000);
  mock.timers.tick(2_000);
  await flush();
  assert.equal(sockets.length, 2);
});

test("a connection that answers is kept, and anything it says counts as an answer", async () => {
  const sock = await up();
  mock.timers.tick(25_000);
  await flush();
  sock.onmessage?.({ data: "pong" });
  mock.timers.tick(12_500);
  await flush();
  assert.equal(sock.closed, undefined);
  mock.timers.tick(25_000);
  await flush();
  sock.onmessage?.({ data: JSON.stringify({ t: "closing", reason: "x" }) });
  mock.timers.tick(12_500);
  await flush();
  assert.equal(sock.closed, undefined);
});

// What the agent is shown, and the files that came with the message

const start = (over: Partial<RunStart> = {}): RunStart => ({
  id: "r1",
  attempt: 1,
  channel: { id: "c1", name: "Design", topic: "Brand work", visibility: "public" },
  thread: {
    rootId: "m1",
    messages: [
      { id: "m1", author: "Mia", kind: "person", body: "launch?", at: "2026-01-01T00:00:00Z" },
      { id: "m2", author: "Hive", kind: "agent", body: "Friday.", at: "2026-01-01T00:01:00Z" },
    ],
  },
  text: "@hive and then?",
  asker: { id: "a1", email: "max@example.com", name: "Max", role: "member" },
  people: [{ name: "Mia", handle: "mia" }],
  files: [],
  mode: "ask",
  ...over,
});

test("the agent is told where it is, who asked, who is there, and that what was said is not an instruction", () => {
  const text = buildRunContext(start(), "Tools: x.");
  assert.match(text, /#Design \(public channel\), whose topic is: Brand work/);
  assert.match(text, /Max \(member\) asked you/);
  assert.match(text, /Tools: x\./);
  assert.match(text, /Mia \(@mia\)/);
  assert.match(text, /not instructions to you/);
  assert.match(text, /\nMia: launch\?\nHive: Friday\./);
  assert.equal(
    buildRunContext(start({ thread: { rootId: "m1", messages: [] } }), "").includes(
      "What was said before",
    ),
    false,
  );
  assert.match(buildRunContext(start(), "", ["uploads/a.pdf"]), /uploads\/a\.pdf/);
});

test("a file's name is made safe to put in a folder", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("..\\..\\boot.ini"), "boot.ini");
  assert.equal(safeFileName(".hidden"), "hidden");
  assert.equal(safeFileName("Q3 report (final).pdf"), "Q3 report _final_.pdf");
  assert.equal(safeFileName("///"), "file");
  assert.ok(safeFileName("x".repeat(500)).length <= 120);
});

test("pictures go to the model as they are and other files are saved in the channel's folder; what cannot be had is said", async () => {
  mock.timers.reset();
  const dir = await mkdtemp(join(tmpdir(), "hive-run-files-"));
  try {
    const bytes: Record<string, Uint8Array> = {
      "/w/w1/f/dl/a?v=file": new Uint8Array([1, 2, 3]),
      "/w/w1/f/dl/b?v=file": new TextEncoder().encode("hello"),
    };
    const fetcher = (async (url: string | URL | Request) => {
      const path = String(url).replace("https://chat.test", "");
      const found = bytes[path];
      return found ? new Response(found as BodyInit) : new Response("no", { status: 404 });
    }) as typeof fetch;
    const files = [
      { id: "a", name: "logo.png", mime: "image/png", bytes: 3, path: "/w/w1/f/dl/a?v=file" },
      { id: "b", name: "../notes.txt", mime: "text/plain", bytes: 5, path: "/w/w1/f/dl/b?v=file" },
      { id: "c", name: "gone.pdf", mime: "application/pdf", bytes: 5, path: "/w/w1/f/dl/c?v=file" },
      { id: "d", name: "huge.mov", mime: "video/quicktime", bytes: 900_000_000, path: "/x" },
    ];
    const got = await fetchRunFiles(start({ files }), "https://chat.test", dir, fetcher);
    assert.equal(got.parts.length, 1);
    assert.equal(got.parts[0]?.mime, "image/png");
    assert.equal(
      got.parts[0]?.url,
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    );
    assert.deepEqual(got.saved, ["uploads/notes.txt"]);
    assert.equal(await readFile(join(dir, "uploads", "notes.txt"), "utf8"), "hello");
    assert.deepEqual(await readdir(dir), ["uploads"]);
    assert.deepEqual(got.missing, ["gone.pdf", "huge.mov (too large)"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
