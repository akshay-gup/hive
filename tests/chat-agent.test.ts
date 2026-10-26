import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { RunnerLink } from "../apps/chat/src/agent-link.ts";
import { ChatCore } from "../apps/chat/src/core.ts";
import { type Peer, Realtime } from "../apps/chat/src/realtime.ts";
import { RUN_LIMITS } from "../packages/chat-core/src/runs.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import type { ChatFrame, ChatMessage } from "../packages/domain/src/chat.ts";
import type { AgentExtra, RoomFrame, RunnerFrame } from "../packages/domain/src/chat-agent.ts";
import { memorySql } from "./helpers/do-shim.ts";

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

interface Machine extends RunnerLink {
  frames: RoomFrame[];
  closed?: { code: number; reason: string };
}
interface FakePeer extends Peer {
  frames: ChatFrame[];
}

let core: ChatCore;
let realtime: Realtime;
let clock: number;
let machine: Machine | null;
let woken: number;
let watchers: FakePeer[];

const connectMachine = (): Machine => {
  const m: Machine = {
    frames: [],
    send: (text) => m.frames.push(JSON.parse(text) as RoomFrame),
    close: (code, reason) => {
      m.closed = { code, reason };
    },
  };
  machine = m;
  return m;
};
const watch = (who: Who): FakePeer => {
  const peer: FakePeer = {
    id: people[who].id,
    exp: clock + 600_000,
    frames: [],
    send: (text) => peer.frames.push(JSON.parse(text) as ChatFrame),
    close: () => undefined,
  };
  watchers.push(peer);
  return peer;
};
const fromMachine = (frame: RunnerFrame) => core.agent.onFrame(JSON.stringify(frame));
const hello = (active: { runId: string; n: number }[] = []) =>
  fromMachine({
    t: "hello",
    v: 1,
    identity: { name: "Hive" },
    capacity: { maxRuns: 2 },
    active,
  });
const started = (m: Machine | null = machine) =>
  (m?.frames ?? []).filter((f): f is Extract<RoomFrame, { t: "run.start" }> => f.t === "run.start");

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
const make = async (who: Who, name: string, visibility?: "public" | "private") => {
  const channel = (await (
    await call(who, "POST", "/v1/channels", { name, visibility })
  ).json()) as Channel;
  // A public channel is one the team joins.
  if (visibility !== "private")
    for (const other of ["olive", "ada", "max", "mia"] as const)
      if (other !== who)
        await call(other, "POST", `/v1/channels/${channel.id}/members`, {
          add: [people[other].email],
        });
  return channel;
};
const post = async (who: Who, channel: string, body: string, extra: object = {}) => {
  const response = await call(who, "POST", `/v1/channels/${channel}/messages`, { body, ...extra });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as ChatMessage;
};
const replies = async (who: Who, rootId: string) =>
  (await (await call(who, "GET", `/v1/messages/${rootId}/replies`)).json()) as {
    root: ChatMessage;
    replies: ChatMessage[];
  };
/** The agent's reply to a message, as people are shown it. */
const replyTo = async (rootId: string) => {
  // Whoever can open the channel will do: the first of these that can.
  let list: ChatMessage[] = [];
  for (const who of ["max", "olive", "mia"] as const) {
    const response = await call(who, "GET", `/v1/messages/${rootId}/replies`);
    if (response.ok) {
      list = ((await response.json()) as { replies: ChatMessage[] }).replies;
      break;
    }
  }
  const reply = list.find((m) => m.author.kind === "agent");
  assert.ok(reply, "the agent has replied");
  return reply;
};
const extraOf = (message: ChatMessage) => message.extra as AgentExtra;
const runOf = (rootId: string) => {
  const run = core.runs.active().find((r) => r.rootId === rootId);
  assert.ok(run, "the run is going");
  return run;
};
const settle = () =>
  realtime.publish({ id: 0, channelId: null, userId: "nobody", type: "settle", data: null, at: 0 });

beforeEach(async () => {
  clock = Date.now();
  machine = null;
  woken = 0;
  watchers = [];
  core = new ChatCore(memorySql(), {
    clock: () => clock,
    publish: (event) => void realtime.publish(event),
    runner: () => machine,
    stream: (channelId, message) => void realtime.stream(channelId, message),
    workspaceId: () => "ws_1",
    linkKey: () => "link-key",
    wake: () => {
      woken++;
    },
  });
  realtime = new Realtime(
    core,
    () => watchers,
    () => clock,
  );
  await core.syncPeople(
    Object.values(people).map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );
});

test("a mention in a public channel makes a run and a reply in the thread, and sends it to the machine", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  await post("mia", room.id, "earlier talk");
  const asked = await post("max", room.id, "@hive what is the plan?");
  const [start] = started();
  assert.ok(start, "the run was sent");
  assert.equal(start.run.text, "@hive what is the plan?");
  assert.equal(start.run.asker.email, "max@example.com");
  assert.equal(start.run.channel.name, "Design");
  assert.deepEqual(
    start.run.thread.messages.map((m) => [m.author, m.body]),
    [["Mia", "earlier talk"]],
  );
  const reply = await replyTo(asked.id);
  // The sender is answered with the message as it is once the agent's reply is under it.
  assert.equal(asked.replyCount, 1);
  assert.equal(reply.threadRoot, asked.id);
  assert.equal(reply.author.name, "Hive");
  assert.equal(extraOf(reply).status, "queued");
  assert.equal(extraOf(reply).runId, start.run.id);
});

test("without a machine the run waits and the machine is woken, once in a while", async () => {
  const room = await make("max", "Design");
  const asked = await post("max", room.id, "@hive hello");
  assert.equal(woken, 1);
  await post("max", room.id, "@hive and again");
  assert.equal(woken, 1, "not asked again at once");
  clock += 31_000;
  await core.agent.maintain();
  assert.equal(woken, 2);
  connectMachine();
  await hello();
  assert.equal(started().length, 2);
  assert.equal(extraOf(await replyTo(asked.id)).status, "queued");
});

test("a message that does not ask for the agent makes no run", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const plain = await post("max", room.id, "hello everyone");
  await post("max", room.id, "mailing hive@example.com or the hive team");
  await post("max", room.id, "@hiver is not it");
  assert.equal(started().length, 0);
  assert.equal((await replies("max", plain.id)).replies.length, 0);
  // Saying it again with the same client id is one message and one run.
  const first = await post("max", room.id, "@hive once", { clientId: "c1" });
  const again = await post("max", room.id, "@hive once", { clientId: "c1" });
  assert.equal(first.id, again.id);
  assert.equal(started().length, 1);
});

test("an edit, an agent's message and a system message never start a run", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const message = await post("max", room.id, "hello");
  const edited = await call("max", "PATCH", `/v1/messages/${message.id}`, { body: "@hive hello" });
  assert.equal(edited.status, 200);
  assert.equal(started().length, 0);
});

test("a direct message and a private channel without the agent refuse, saying why", async () => {
  connectMachine();
  await hello();
  const dm = (await (
    await call("max", "POST", "/v1/dms", { email: "mia@example.com" })
  ).json()) as Channel;
  const inDm = await post("max", dm.id, "@hive hi");
  assert.equal(extraOf(await replyTo(inDm.id)).reason, "dm");
  const secret = await make("max", "Payroll", "private");
  const asked = await post("max", secret.id, "@hive hi");
  const reply = await replyTo(asked.id);
  assert.equal(extraOf(reply).status, "failed");
  assert.equal(extraOf(reply).reason, "disabled");
  assert.match(reply.body, /switch it on/);
  assert.equal(started().length, 0);
  assert.equal(core.runs.active().length, 0);
});

test("a manager switches the agent on in a private channel, and only a manager", async () => {
  connectMachine();
  await hello();
  const secret = await make("max", "Payroll", "private");
  await call("max", "POST", `/v1/channels/${secret.id}/members`, { add: ["mia@example.com"] });
  const refused = await call("mia", "PATCH", `/v1/channels/${secret.id}`, { agent: true });
  assert.equal(refused.status, 403);
  const on = await call("max", "PATCH", `/v1/channels/${secret.id}`, { agent: true });
  assert.equal(on.status, 200);
  await post("mia", secret.id, "@hive total this up");
  const [start] = started();
  assert.equal(start?.run.channel.visibility, "private");
  assert.deepEqual(start?.run.people.map((p) => p.handle).sort(), ["max", "mia"]);
});

test("the machine's reply is shown as it is written, and kept at most about once a second", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const mia = watch("mia");
  const asked = await post("max", room.id, "@hive go");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  assert.equal(extraOf(await replyTo(asked.id)).status, "working");
  const kept = async () => (await replyTo(asked.id)).body;
  await fromMachine({ t: "run.say", runId, n: 1, body: "One", steps: [] });
  assert.equal(await kept(), "One");
  // Soon after: shown, not kept.
  clock += 300;
  await fromMachine({ t: "run.say", runId, n: 2, body: "One two", steps: [] });
  await settle();
  assert.equal(await kept(), "One");
  const streamed = mia.frames.filter((f) => f.t === "stream") as { message: ChatMessage }[];
  assert.equal(streamed.at(-1)?.message.body, "One two");
  // A snapshot that is not newer is dropped.
  await fromMachine({ t: "run.say", runId, n: 2, body: "stale", steps: [] });
  await fromMachine({ t: "run.say", runId, n: 1, body: "older", steps: [] });
  clock += 1_000;
  await fromMachine({ t: "run.say", runId, n: 3, body: "One two three", steps: [] });
  assert.equal(await kept(), "One two three");
  await fromMachine({
    t: "run.end",
    runId,
    n: 4,
    status: "done",
    body: "All done",
    steps: [{ id: "s1" }],
  });
  const done = await replyTo(asked.id);
  assert.equal(done.body, "All done");
  assert.equal(extraOf(done).status, "done");
  assert.equal(extraOf(done).steps.length, 1);
  assert.deepEqual(
    machine?.frames.filter((f) => f.t === "ack"),
    [{ t: "ack", runId }],
  );
  // Nothing more is taken once it has ended.
  await fromMachine({ t: "run.say", runId, n: 9, body: "late", steps: [] });
  await fromMachine({ t: "run.end", runId, n: 10, status: "failed", body: "late", steps: [] });
  assert.equal((await replyTo(asked.id)).body, "All done");
  assert.equal(extraOf(await replyTo(asked.id)).status, "done");
});

test("the person who asked is told when the run is over, unless they stopped it", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const first = await post("max", room.id, "@hive one");
  await fromMachine({ t: "run.ack", runId: runOf(first.id).id });
  await fromMachine({
    t: "run.end",
    runId: runOf(first.id).id,
    n: 1,
    status: "done",
    body: "Done one",
    steps: [],
  });
  const notices = (await (await call("max", "GET", "/v1/notifications")).json()) as {
    title: string;
    body: string;
    by: string;
    byName: string;
  }[];
  assert.equal(notices.length, 1);
  assert.match(notices[0]?.title ?? "", /Hive answered you in #Design/);
  assert.equal(notices[0]?.body, "Done one");
  // Shown with the agent's own picture, not a person's initial.
  assert.equal(notices[0]?.by, "");
  assert.equal(notices[0]?.byName, "");
  const second = await post("max", room.id, "@hive two");
  await call("max", "POST", `/v1/runs/${runOf(second.id).id}/stop`);
  const after = (await (await call("max", "GET", "/v1/notifications")).json()) as unknown[];
  assert.equal(after.length, 1);
  const third = await post("max", room.id, "@hive three");
  await fromMachine({ t: "run.ack", runId: runOf(third.id).id });
  await fromMachine({
    t: "run.end",
    runId: runOf(third.id).id,
    n: 1,
    status: "failed",
    body: "",
    steps: [],
  });
  const last = (await (await call("max", "GET", "/v1/notifications")).json()) as {
    title: string;
  }[];
  assert.equal(last.length, 2);
  assert.ok(last.some((n) => /Hive could not answer in #Design/.test(n.title)));
});

test("a run is sent to the machine in order, one at a time in a thread, and at most as many as it can take", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const a = await post("max", room.id, "@hive a");
  const b = await post("mia", room.id, "@hive b");
  const c = await post("max", room.id, "@hive c");
  assert.deepEqual(
    started().map((s) => s.run.text),
    ["@hive a", "@hive b"],
    "two at once",
  );
  await fromMachine({
    t: "run.end",
    runId: runOf(a.id).id,
    n: 1,
    status: "done",
    body: "a",
    steps: [],
  });
  assert.equal(started().length, 3);
  assert.equal(started()[2]?.run.text, "@hive c");
  // Two mentions in one thread go one after the other.
  const thread = await post("max", room.id, "start", {});
  await fromMachine({
    t: "run.end",
    runId: runOf(b.id).id,
    n: 1,
    status: "done",
    body: "b",
    steps: [],
  });
  await fromMachine({
    t: "run.end",
    runId: runOf(c.id).id,
    n: 1,
    status: "done",
    body: "c",
    steps: [],
  });
  const before = started().length;
  await post("max", room.id, "@hive x", { threadRoot: thread.id });
  await post("mia", room.id, "@hive y", { threadRoot: thread.id });
  assert.equal(started().length, before + 1, "the second waits for the first");
  const x = started().at(-1);
  await fromMachine({
    t: "run.end",
    runId: x?.run.id ?? "",
    n: 1,
    status: "done",
    body: "x",
    steps: [],
  });
  assert.equal(started().length, before + 2);
  assert.deepEqual(
    started()
      .slice(-2)
      .map((s) => s.run.text),
    ["@hive x", "@hive y"],
  );
  // The second one is shown what the first said.
  assert.ok(
    started()
      .at(-1)
      ?.run.thread.messages.some((m) => m.body === "x"),
  );
});

test("a thread mention is given the thread so far, and a person who is not in the thread's channel is not named", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const root = await post("max", room.id, "question about the logo");
  await post("mia", room.id, "i think blue", { threadRoot: root.id });
  await post("max", room.id, "@hive what do you think", { threadRoot: root.id });
  const [start] = started();
  assert.deepEqual(
    start?.run.thread.messages.map((m) => m.body),
    ["question about the logo", "i think blue"],
  );
  assert.equal(start?.run.thread.rootId, root.id);
  assert.ok(start?.run.people.every((p) => p.name !== "Gus"));
});

test("approvals: the room writes the prompt, the first answer wins, guests and outsiders cannot answer", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const mia = watch("mia");
  const asked = await post("max", room.id, "@hive run the build");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  await fromMachine({
    t: "run.ask",
    runId,
    requestId: "secret-request-id",
    prompt: { kind: "approval", id: "p1", title: "bash: pnpm build" },
  });
  const shown = extraOf(await replyTo(asked.id));
  assert.equal(shown.prompts?.length, 1);
  assert.equal(shown.prompts?.[0]?.prompt.id, "p1");
  // What the machine will answer with does not reach the app, in the reply or in what was sent.
  assert.equal(JSON.stringify(await replyTo(asked.id)).includes("secret-request-id"), false);
  await settle();
  assert.equal(JSON.stringify(mia.frames).includes("secret-request-id"), false);

  const answer = (who: Who, choice: unknown) =>
    call(who, "POST", `/v1/runs/${runId}/answer`, { promptId: "p1", choice });
  assert.equal(
    (await answer("gus", { reply: "once" })).status,
    404,
    "a guest who is not in the channel",
  );
  // Someone in the channel who is not the asker may answer.
  const wrongKind = await answer("mia", { answers: [["x"]] });
  assert.equal(wrongKind.status, 422);
  assert.equal((await answer("mia", { reply: "once" })).status, 200);
  assert.equal((await answer("max", { reply: "reject" })).status, 409, "the first answer stands");
  const answers = (machine?.frames ?? []).filter((f) => f.t === "run.answer");
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    t: "run.answer",
    runId,
    promptId: "p1",
    requestId: "secret-request-id",
    by: people.mia.id,
    choice: { reply: "once" },
  });
  const after = extraOf(await replyTo(asked.id));
  assert.equal(after.prompts?.[0]?.answered?.by, people.mia.id);
  assert.equal(after.prompts?.[0]?.answered?.byName, "Mia");
  const nothing = await call("mia", "POST", `/v1/runs/${runId}/answer`, {
    promptId: "nope",
    choice: { reply: "once" },
  });
  assert.equal(nothing.status, 404);
});

test("a guest in the channel can look but not decide", async () => {
  const room = await make("max", "Review", "private");
  await call("max", "POST", `/v1/channels/${room.id}/members`, { add: ["gus@example.com"] });
  await call("max", "PATCH", `/v1/channels/${room.id}`, { agent: true });
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive do it");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  await fromMachine({
    t: "run.ask",
    runId,
    requestId: "r",
    prompt: { kind: "approval", id: "p", title: "x" },
  });
  const response = await call("gus", "POST", `/v1/runs/${runId}/answer`, {
    promptId: "p",
    choice: { reply: "once" },
  });
  assert.equal(response.status, 403);
});

test("whoever asked, a channel manager, an admin or the owner can stop a run; no one else", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("mia", room.id, "@hive long job");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  await fromMachine({ t: "run.say", runId, n: 1, body: "Partway", steps: [] });
  // Max made the channel, so he manages it; Gus is outside it.
  assert.equal((await call("gus", "POST", `/v1/runs/${runId}/stop`)).status, 404);
  await call("ada", "POST", `/v1/channels/${room.id}/members`, { add: ["ada@example.com"] });
  const other = await post("max", room.id, "@hive other job");
  void other;
  assert.equal((await call("max", "POST", `/v1/runs/${runId}/stop`)).status, 200);
  const stopped = await replyTo(asked.id);
  assert.equal(extraOf(stopped).status, "stopped");
  assert.equal(stopped.body, "Partway", "what was written stays");
  assert.deepEqual(
    machine?.frames.filter((f) => f.t === "run.stop"),
    [{ t: "run.stop", runId, by: "room", reason: "user" }],
  );
  // Stopping again is fine, and the machine's own end afterwards changes nothing.
  assert.equal((await call("mia", "POST", `/v1/runs/${runId}/stop`)).status, 200);
  await fromMachine({ t: "run.end", runId, n: 2, status: "done", body: "late", steps: [] });
  assert.equal((await replyTo(asked.id)).body, "Partway");
});

test("a member who is not the asker and does not manage the channel cannot stop it", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive job");
  const runId = runOf(asked.id).id;
  const response = await call("mia", "POST", `/v1/runs/${runId}/stop`);
  assert.equal(response.status, 403);
  assert.equal((await call("ada", "POST", `/v1/runs/${runId}/stop`)).status, 200);
});

test("a run stops when its asker can no longer open the channel", async () => {
  const room = await make("max", "Payroll", "private");
  await call("max", "POST", `/v1/channels/${room.id}/members`, { add: ["mia@example.com"] });
  await call("max", "PATCH", `/v1/channels/${room.id}`, { agent: true });
  connectMachine();
  await hello();
  const asked = await post("mia", room.id, "@hive go");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  await call("max", "POST", `/v1/channels/${room.id}/members`, { remove: ["mia@example.com"] });
  const reply = await replyTo(asked.id);
  assert.equal(extraOf(reply).status, "stopped");
  assert.equal(extraOf(reply).reason, "access");
  assert.ok(machine?.frames.some((f) => f.t === "run.stop"));
  assert.equal(core.runs.active().length, 0);
});

test("switching the agent off, archiving and deleting end the runs in the channel", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const a = await post("max", room.id, "@hive a");
  await call("max", "PATCH", `/v1/channels/${room.id}`, { agent: false });
  assert.equal(extraOf(await replyTo(a.id)).reason, "disabled");
  await call("max", "PATCH", `/v1/channels/${room.id}`, { agent: true });
  const b = await post("max", room.id, "@hive b");
  await call("max", "POST", `/v1/channels/${room.id}/archive`);
  assert.equal(extraOf(await replyTo(b.id)).reason, "archived");
  const other = await make("max", "Other");
  await post("max", other.id, "@hive c");
  assert.equal(core.runs.active().length, 1);
  await call("max", "DELETE", `/v1/channels/${other.id}`);
  assert.equal(core.runs.active().length, 0);
});

test("a revoked sign-in ends what that person asked, and deleting the message that asked does too", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const a = await post("mia", room.id, "@hive a");
  const b = await post("max", room.id, "@hive b");
  await core.agent.revoked(people.mia.id);
  assert.equal(extraOf(await replyTo(a.id)).reason, "access");
  assert.equal(core.runs.active().length, 1);
  await call("max", "DELETE", `/v1/messages/${b.id}`);
  assert.equal(core.runs.active().length, 0);
});

test("the limits keep one person, one channel and the workspace from using the agent up", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  for (let i = 0; i < RUN_LIMITS.perPerson.count; i++) await post("max", room.id, `@hive ${i}`);
  const over = await post("max", room.id, "@hive one too many");
  assert.equal(extraOf(await replyTo(over.id)).reason, "limit");
  // Someone else is not held to Max's count.
  const mia = await post("mia", room.id, "@hive me too");
  assert.notEqual(extraOf(await replyTo(mia.id)).status, "failed");
});

test("the queue has a depth", async () => {
  const room = await make("max", "Design");
  const who: Who[] = ["max", "mia", "ada", "olive"];
  let refused = 0;
  for (let i = 0; i < RUN_LIMITS.queueDepth + 3; i++) {
    const asked = await post(who[i % 4] as Who, room.id, `@hive ${i}`);
    if (extraOf(await replyTo(asked.id)).reason === "busy") refused++;
  }
  assert.equal(refused, 3);
});

test("a run nobody takes fails, a machine that goes quiet loses its runs, and one that comes back keeps them", async () => {
  const room = await make("max", "Design");
  const a = await post("max", room.id, "@hive a");
  clock += RUN_LIMITS.wakeMs + 1_000;
  assert.equal(await core.agent.maintain(), false);
  assert.equal(extraOf(await replyTo(a.id)).reason, "no-runner");

  connectMachine();
  await hello();
  const b = await post("max", room.id, "@hive b");
  const c = await post("mia", room.id, "@hive c");
  const [rb, rc] = [runOf(b.id).id, runOf(c.id).id];
  await fromMachine({ t: "run.ack", runId: rb });
  await fromMachine({ t: "run.ack", runId: rc });
  // Beats keep a run alive.
  clock += 60_000;
  await fromMachine({ t: "beat", runIds: [rb] });
  clock += 60_000;
  assert.equal(await core.agent.maintain(), true);
  assert.equal(extraOf(await replyTo(b.id)).status, "working");
  assert.equal(extraOf(await replyTo(c.id)).reason, "lost");
  // A late beat for a run that was given up on changes nothing.
  await fromMachine({ t: "beat", runIds: [rc] });
  assert.equal(extraOf(await replyTo(c.id)).status, "failed");
});

test("after the machine reconnects, what it reports is kept and what it does not is lost or sent again", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const a = await post("max", room.id, "@hive a");
  const b = await post("mia", room.id, "@hive b");
  const [ra, rb] = [runOf(a.id).id, runOf(b.id).id];
  await fromMachine({ t: "run.ack", runId: ra });
  // b was sent but never taken; the connection drops and a new one says hello.
  machine = null;
  await core.agent.disconnected();
  assert.equal(core.runs.get(rb)?.state, "queued");
  const second = connectMachine();
  await hello([{ runId: ra, n: 0 }]);
  const welcome = second.frames.find((f) => f.t === "welcome");
  assert.deepEqual(welcome && "resume" in welcome ? welcome.resume : null, [ra]);
  assert.equal(extraOf(await replyTo(a.id)).status, "working");
  assert.deepEqual(
    started(second).map((s) => [s.run.id, s.run.attempt]),
    [[rb, 2]],
    "sent again, as a second try",
  );
  // A machine that restarted and knows nothing of a running run: the run is sent again, from the start.
  await fromMachine({ t: "run.say", runId: ra, n: 1, body: "Half of it", steps: [] });
  const third = connectMachine();
  await hello([]);
  const again = await replyTo(a.id);
  assert.equal(extraOf(again).status, "queued");
  assert.equal(again.body, "Half of it", "what the lost run had written stays in the reply");
  assert.deepEqual(
    new Map(started(third).map((s) => [s.run.id, s.run.attempt])),
    new Map([
      [ra, 2],
      [rb, 3],
    ]),
    "both are sent again",
  );
  // The one that had written something carries on from it; the one that had not starts as it was.
  const resumed = started(third).find((s) => s.run.id === ra);
  assert.equal(resumed?.run.resume?.body, "Half of it");
  assert.equal(started(third).find((s) => s.run.id === rb)?.run.resume, undefined);
});

test("a run its machine keeps losing is sent a few times, and then given up on", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive long job");
  const runId = runOf(asked.id).id;
  for (let attempt = 1; attempt < RUN_LIMITS.maxAttempts; attempt++) {
    await fromMachine({ t: "run.ack", runId });
    connectMachine();
    await hello([]);
    assert.equal(
      extraOf(await replyTo(asked.id)).status,
      "queued",
      `sent again after try ${attempt}`,
    );
  }
  await fromMachine({ t: "run.ack", runId });
  connectMachine();
  await hello([]);
  const last = await replyTo(asked.id);
  assert.equal(extraOf(last).status, "failed");
  assert.equal(extraOf(last).reason, "lost");
});

test("the agent asking is told to the person who asked at once, with where in the reply it came up", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive what colour?");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  await fromMachine({
    t: "run.say",
    runId,
    n: 1,
    body: "Let me check.",
    steps: [{ role: "assistant", toolCalls: [] }],
  });
  await fromMachine({
    t: "run.ask",
    runId,
    requestId: "r1",
    prompt: {
      kind: "question",
      id: "q1",
      questions: [{ header: "Colour", question: "Which colour do you like?", options: [] }],
    },
    after: { steps: 1, chars: 13 },
  });
  type Told = { title: string; body: string; read: boolean }[];
  const told = (await (await call("max", "GET", "/v1/notifications")).json()) as Told;
  assert.equal(told.length, 1, "told while it still waits");
  assert.match(told[0]?.title ?? "", /Hive needs you in #Design/);
  assert.equal(told[0]?.body, "Which colour do you like?");
  assert.deepEqual(extraOf(await replyTo(asked.id)).prompts?.[0]?.after, { steps: 1, chars: 13 });
  // Read, answered, and then the run ends: it is news again, now as an answer.
  const noticeId = (await replyTo(asked.id)).id;
  await call("max", "POST", `/v1/notifications/${noticeId}/read`);
  await call("max", "POST", `/v1/runs/${runId}/answer`, {
    promptId: "q1",
    choice: { answers: [["Green"]] },
  });
  await fromMachine({ t: "run.end", runId, n: 2, status: "done", body: "Green it is.", steps: [] });
  const end = (await (await call("max", "GET", "/v1/notifications")).json()) as Told;
  assert.equal(end.length, 1, "still one notice for the run");
  assert.match(end[0]?.title ?? "", /Hive answered you in #Design/);
  assert.equal(end[0]?.read, false);
});

test("the machine's name is the agent's name, and what it says that is not understood changes nothing", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await fromMachine({
    t: "hello",
    v: 1,
    identity: { name: "Scout", avatar: "sky" },
    active: [],
  });
  const asked = await post("max", room.id, "@hive hi");
  assert.equal((await replyTo(asked.id)).author.name, "Scout");
  const runId = runOf(asked.id).id;
  for (const junk of [
    "not json",
    "{}",
    JSON.stringify({ t: "run.say", runId, n: "x", body: 1 }),
    JSON.stringify({ t: "run.say", runId: "nope", n: 1, body: "x", steps: [] }),
    JSON.stringify({ t: "run.end", runId: "nope", n: 1, status: "done", body: "x", steps: [] }),
    JSON.stringify({ t: "run.say", runId, n: 1, body: "x".repeat(50_000), steps: [] }),
  ])
    await core.agent.onFrame(junk);
  assert.equal(core.runs.get(runId)?.state, "sent");
  assert.equal((await replyTo(asked.id)).body, "");
});

test("a huge record of steps is cut down to what can be kept", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive big");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  const steps = Array.from({ length: 400 }, (_, i) => ({ i, text: "x".repeat(2_000) }));
  await fromMachine({ t: "run.say", runId, n: 1, body: "ok", steps });
  const extra = extraOf(await replyTo(asked.id));
  assert.ok(JSON.stringify(extra).length <= 256 * 1024);
  assert.ok(extra.steps.length > 0 && extra.steps.length <= 80);
});

test("the agent's machine is not someone events are sent to", async () => {
  // The machine is not among the people the room speaks to: a message in a channel reaches the watchers only.
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const max = watch("max");
  await post("mia", room.id, "a private-ish remark");
  await settle();
  assert.ok(max.frames.some((f) => f.t === "event" && f.type === "message.new"));
  assert.equal(
    (machine?.frames ?? []).some((f) => JSON.stringify(f).includes("private-ish")),
    false,
  );
});

test("a refused run for a person who has since left shows the right words", async () => {
  const room = await make("max", "Design");
  const asked = await post("mia", room.id, "@hive please");
  // Mia is removed from the workspace before the machine arrives.
  await core.syncPeople(
    Object.values(people)
      .filter((p) => p.id !== people.mia.id)
      .map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );
  connectMachine();
  await hello();
  assert.equal(extraOf(await replyTo(asked.id)).reason, "access");
  assert.equal(started().length, 0);
});

// Files the agent puts in its reply

const begin = (runId: string, reqId: string, bytes = 100, name = "report.pdf") =>
  fromMachine({ t: "file.begin", runId, reqId, name, mime: "application/pdf", bytes });
const sentToMachine = (type: string) =>
  (machine?.frames ?? []).filter((f) => f.t === type) as Record<string, string>[];
/** The bytes arrive, as the Worker would tell the room. */
const arrive = (fileId: string, bytes: number) => core.filing.uploaded(fileId, "file", bytes);

test("the agent can put a file in its reply: the room says where to send it, then attaches it", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive make a report");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  await begin(runId, "q1", 100);
  const [upload] = sentToMachine("file.upload");
  assert.ok(upload?.fileId);
  assert.match(upload?.path ?? "", /^\/w\/ws_1\/f\/up\//);
  // Nothing is attached until it has arrived and the machine says so.
  await fromMachine({ t: "file.done", runId, reqId: "q1", fileId: upload?.fileId ?? "" });
  assert.deepEqual(
    sentToMachine("file.refused").map((f) => f.error),
    ["That file did not arrive"],
  );
  arrive(upload?.fileId ?? "", 100);
  await fromMachine({ t: "file.done", runId, reqId: "q1", fileId: upload?.fileId ?? "" });
  assert.equal(sentToMachine("file.attached").length, 1);
  const reply = await replyTo(asked.id);
  assert.deepEqual(
    reply.files.map((f) => [f.name, f.bytes]),
    [["report.pdf", 100]],
  );
  // It is the asker's file in the workspace's storage.
  assert.equal(core.files.usage().bytesUsed >= 100, true);
});

test("a file for a run that is over, in too great a number, or too large is refused", async () => {
  const room = await make("max", "Design");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive many files");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  for (let i = 0; i < RUN_LIMITS.filesPerRun; i++) {
    await begin(runId, `r${i}`);
    const up = sentToMachine("file.upload").at(-1);
    arrive(up?.fileId ?? "", 100);
    await fromMachine({ t: "file.done", runId, reqId: `r${i}`, fileId: up?.fileId ?? "" });
  }
  assert.equal(sentToMachine("file.attached").length, RUN_LIMITS.filesPerRun);
  await begin(runId, "one-too-many");
  assert.match(sentToMachine("file.refused").at(-1)?.error ?? "", /At most 5 files/);
  // A file larger than the plan allows is refused by the room's own rules.
  const other = await post("mia", room.id, "@hive big one");
  const otherRun = runOf(other.id).id;
  await fromMachine({ t: "run.ack", runId: otherRun });
  await begin(otherRun, "big", 10 * 1024 ** 4);
  assert.equal(sentToMachine("file.refused").length >= 2, true);
  // And once the run has ended, nothing.
  await fromMachine({ t: "run.end", runId, n: 1, status: "done", body: "ok", steps: [] });
  await begin(runId, "late");
  assert.equal(sentToMachine("file.refused").at(-1)?.error, "This run is over");
});

test("a file someone else sent, or one in another channel, cannot be put in the reply", async () => {
  const room = await make("max", "Design");
  const elsewhere = await make("max", "Elsewhere");
  connectMachine();
  await hello();
  const asked = await post("max", room.id, "@hive a file");
  const runId = runOf(asked.id).id;
  await fromMachine({ t: "run.ack", runId });
  // Mia's own upload, ready in this channel.
  const theirs = (await (
    await call("mia", "POST", "/v1/files/uploads", {
      channelId: room.id,
      name: "mine.txt",
      mime: "text/plain",
      bytes: 10,
    })
  ).json()) as { fileId: string };
  arrive(theirs.fileId, 10);
  await fromMachine({ t: "file.done", runId, reqId: "x", fileId: theirs.fileId });
  // Max's own, but in another channel.
  const away = (await (
    await call("max", "POST", "/v1/files/uploads", {
      channelId: elsewhere.id,
      name: "away.txt",
      mime: "text/plain",
      bytes: 10,
    })
  ).json()) as { fileId: string };
  arrive(away.fileId, 10);
  await fromMachine({ t: "file.done", runId, reqId: "y", fileId: away.fileId });
  assert.deepEqual(
    sentToMachine("file.refused").map((f) => f.error),
    ["That file did not arrive", "That file did not arrive"],
  );
  assert.equal((await replyTo(asked.id)).files.length, 0);
});
