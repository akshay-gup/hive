import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ChatCore } from "../apps/chat/src/core.ts";
import { CLOSE_EXPIRED, type Peer, Realtime } from "../apps/chat/src/realtime.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import type { ChatFrame } from "../packages/domain/src/chat.ts";
import { memorySql } from "./helpers/do-shim.ts";

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

interface FakePeer extends Peer {
  frames: ChatFrame[];
  closed?: { code: number; reason: string };
}

let core: ChatCore;
let realtime: Realtime;
let connected: FakePeer[];
let clock: number;

const connect = (who: Who, exp = clock + 600_000): FakePeer => {
  const peer: FakePeer = {
    id: people[who].id,
    exp,
    frames: [],
    send: (text) => peer.frames.push(JSON.parse(text) as ChatFrame),
    close: (code, reason) => {
      peer.closed = { code, reason };
    },
  };
  connected.push(peer);
  return peer;
};
const call = (who: Who, method: string, path: string, body?: unknown) =>
  core.handle(
    new Request(`http://chat${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      sub: people[who].id,
      email: people[who].email,
      name: people[who].name,
      role: people[who].role,
      issuedAt: Date.now(),
    },
  );
const make = async (who: Who, name: string, visibility?: "public" | "private") =>
  (await (await call(who, "POST", "/v1/channels", { name, visibility })).json()) as Channel;
const join = (who: Who, id: string) =>
  call(who, "POST", `/v1/channels/${id}/members`, { add: [people[who].email] });
const say = async (who: Who, channel: string, body: string) => {
  const response = await call(who, "POST", `/v1/channels/${channel}/messages`, { body });
  assert.equal(response.status, 201);
};
/** Events delivered to the person, by type. */
const heard = (peer: FakePeer) =>
  peer.frames.filter((f) => f.t === "event").map((f) => (f as { type: string }).type);
const settle = () =>
  realtime.publish({ id: 0, channelId: null, userId: "nobody", type: "settle", data: null, at: 0 });

beforeEach(async () => {
  clock = Date.now();
  connected = [];
  core = new ChatCore(memorySql(), {
    clock: () => clock,
    publish: (event) => void realtime.publish(event),
  });
  realtime = new Realtime(
    core,
    () => connected,
    () => clock,
  );
  await core.syncPeople(
    Object.values(people).map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );
});

test("a message goes to the people who may see the channel, as it is written", async () => {
  const room = await make("max", "Design");
  await join("mia", room.id);
  const [max, mia, olive, gus] = [connect("max"), connect("mia"), connect("olive"), connect("gus")];
  await say("max", room.id, "hello");
  await settle();
  assert.ok(heard(max).includes("message.new"));
  assert.ok(heard(mia).includes("message.new"));
  // The owner can open a public channel, so she hears it; a guest who is not in it does not.
  assert.ok(heard(olive).includes("message.new"));
  assert.equal(heard(gus).includes("message.new"), false);
  const frame = mia.frames.find((f) => f.t === "event" && f.type === "message.new") as {
    channelId: string;
    data: { body: string; author: { name: string } };
  };
  assert.deepEqual(
    [frame.channelId, frame.data.body, frame.data.author.name],
    [room.id, "hello", "Max"],
  );
});

test("a private channel is heard only by the people in it", async () => {
  const room = await make("max", "Payroll", "private");
  await call("max", "POST", `/v1/channels/${room.id}/members`, {
    add: ["mia@example.com", "gus@example.com"],
  });
  const [max, mia, ada, olive, gus] = ["max", "mia", "ada", "olive", "gus"].map((w) =>
    connect(w as Who),
  ) as FakePeer[];
  await say("max", room.id, "salaries");
  await settle();
  for (const peer of [max, mia, gus]) assert.ok(heard(peer).includes("message.new"));
  for (const peer of [ada, olive]) assert.equal(heard(peer).includes("message.new"), false);
});

test("what is only a person's own goes only to them", async () => {
  const room = await make("max", "Mentions");
  await join("mia", room.id);
  const [max, mia] = [connect("max"), connect("mia")];
  await say("max", room.id, "@mia take a look");
  await settle();
  assert.ok(heard(mia).includes("notification.new"));
  assert.equal(heard(max).includes("notification.new"), false);
  // Their own reading is told to their own screens, not to anyone else's.
  await call("mia", "POST", `/v1/channels/${room.id}/read`, {});
  await settle();
  assert.ok(heard(mia).includes("read.updated"));
  assert.equal(
    max.frames.some(
      (f) => f.t === "event" && f.type === "read.updated" && (f.data as { seq: number }).seq === 0,
    ),
    false,
  );
});

test("someone taken out of a private channel is told it is gone and hears no more of it", async () => {
  const room = await make("max", "Hiring", "private");
  await call("max", "POST", `/v1/channels/${room.id}/members`, { add: ["mia@example.com"] });
  const mia = connect("mia");
  await say("max", room.id, "before");
  await call("max", "POST", `/v1/channels/${room.id}/members`, { remove: ["mia@example.com"] });
  await say("max", room.id, "after");
  await settle();
  const types = heard(mia);
  assert.ok(types.includes("channel.removed"));
  const messages = mia.frames
    .filter((f) => f.t === "event" && f.type === "message.new")
    .map((f) => (f as { data: { body: string } }).data.body);
  assert.deepEqual(messages, ["before"]);
});

test("events arrive in the order they happened", async () => {
  const room = await make("max", "Order");
  const max = connect("max");
  for (let i = 1; i <= 5; i++) await say("max", room.id, `m${i}`);
  await settle();
  const ids = max.frames.filter((f) => f.t === "event").map((f) => (f as { id: number }).id);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => a - b),
  );
  const bodies = max.frames
    .filter((f) => f.t === "event" && f.type === "message.new")
    .map((f) => (f as { data: { body: string } }).data.body);
  assert.deepEqual(bodies, ["m1", "m2", "m3", "m4", "m5"]);
});

test("a connection whose token has run out is closed and told nothing more", async () => {
  const room = await make("max", "Expiry");
  const old = connect("max", clock - 1);
  const fresh = connect("mia");
  await join("mia", room.id);
  await say("mia", room.id, "hi");
  await settle();
  assert.equal(old.closed?.code, CLOSE_EXPIRED);
  assert.deepEqual(heard(old), []);
  assert.ok(heard(fresh).includes("message.new"));
});

test("someone who comes back is sent what they missed, only of what they may see", async () => {
  const open = await make("max", "Open");
  const secret = await make("max", "Secret", "private");
  await join("mia", open.id);
  const cursor = core.events.latest();
  await say("max", open.id, "public news");
  await say("max", secret.id, "private news");
  const mia = connect("mia");
  await realtime.receive(mia, JSON.stringify({ t: "hello", cursor }));
  const bodies = mia.frames
    .filter((f) => f.t === "event" && f.type === "message.new")
    .map((f) => (f as { data: { body: string } }).data.body);
  assert.deepEqual(bodies, ["public news"]);
  const last = mia.frames.at(-1);
  assert.deepEqual(last, { t: "ready", cursor: core.events.latest() });
});

test("someone who was away too long is told to fetch afresh", async () => {
  const room = await make("max", "Busy");
  const first = core.events.latest();
  for (let i = 0; i < 6; i++) await say("max", room.id, `m${i}`);
  core.events.prune({ keep: 2 });
  const mia = connect("mia");
  await realtime.receive(mia, JSON.stringify({ t: "hello", cursor: first }));
  assert.deepEqual(mia.frames, [{ t: "resync", cursor: core.events.latest() }]);
});

test("typing is shown to the others in the channel for a moment, and not kept", async () => {
  const room = await make("max", "Typing");
  await join("mia", room.id);
  const [max, mia, ada] = [connect("max"), connect("mia"), connect("ada")];
  const before = core.events.latest();
  await realtime.receive(max, JSON.stringify({ t: "typing", channelId: room.id }));
  await realtime.receive(max, JSON.stringify({ t: "typing", channelId: room.id }));
  assert.deepEqual(mia.frames, [
    { t: "typing", channelId: room.id, userId: "acct_max", name: "Max" },
  ]);
  assert.deepEqual(max.frames, [], "not to the one typing, and not twice in a moment");
  assert.equal(core.events.latest(), before, "it is not an event");
  // A private channel's typing stays inside it.
  ada.frames.length = 0; // she could see the public one
  const secret = await make("max", "Quiet", "private");
  await realtime.receive(max, JSON.stringify({ t: "typing", channelId: secret.id }));
  assert.deepEqual(ada.frames, []);
  // And someone who is not in a channel is not shown to be typing in it.
  await realtime.receive(ada, JSON.stringify({ t: "typing", channelId: room.id }));
  assert.deepEqual(mia.frames.length, 1);
  clock += 5_000;
  await realtime.receive(max, JSON.stringify({ t: "typing", channelId: room.id }));
  assert.equal(mia.frames.length, 2);
});

test("a frame that makes no sense is ignored", async () => {
  const mia = connect("mia");
  for (const text of ["", "nope", "{}", '{"t":"hello"}', '{"t":"typing"}', "[]"])
    await realtime.receive(mia, text);
  assert.deepEqual(mia.frames, []);
});
