import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { agentOn, agentRefusal, wantsAgent } from "../packages/chat-core/src/agent-trigger.ts";
import { Messages } from "../packages/chat-core/src/messages.ts";
import { RUN_LIMITS, Runs } from "../packages/chat-core/src/runs.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import { withHandles } from "../packages/domain/src/mentions.ts";
import { chatWorld } from "./helpers/chat-world.ts";
import { memorySql } from "./helpers/do-shim.ts";

let clock: number;
let runs: Runs;
let n = 0;
const make = (over: Partial<Parameters<Runs["create"]>[0]> = {}) =>
  runs.create({
    id: `r${++n}`,
    channelId: "c1",
    rootId: `root${n}`,
    triggerId: `t${n}`,
    replyId: `a${n}`,
    askedBy: "u1",
    askerRole: "member",
    ...over,
  });

beforeEach(() => {
  clock = 1_000_000;
  runs = new Runs(memorySql(), () => clock);
});

test("a run moves forward and an ended one is never touched again", () => {
  const run = make();
  assert.equal(run.state, "queued");
  assert.equal(runs.markSent(run.id)?.state, "sent");
  assert.equal(runs.markRunning(run.id), true);
  assert.deepEqual(runs.say(run.id, 1), { taken: true, keep: true });
  assert.equal(runs.end(run.id, "done", "ok")?.state, "done");
  assert.equal(runs.end(run.id, "failed", "error"), null, "once");
  assert.equal(runs.markRunning(run.id), false);
  assert.deepEqual(runs.say(run.id, 2), { taken: false, keep: false });
  assert.equal(runs.get(run.id)?.reason, "ok");
});

test("only newer snapshots of a reply are taken, and only about one a second is kept", () => {
  const run = make();
  runs.markSent(run.id);
  assert.equal(runs.say(run.id, 3).taken, true);
  assert.equal(runs.say(run.id, 3).taken, false);
  assert.equal(runs.say(run.id, 2).taken, false);
  clock += 200;
  assert.deepEqual(runs.say(run.id, 4), { taken: true, keep: false });
  clock += 900;
  assert.deepEqual(runs.say(run.id, 5), { taken: true, keep: true });
  assert.equal(runs.get(run.id)?.lastN, 5);
});

test("one at a time in a thread, in order, as many at once as the machine allows", () => {
  const a = make({ channelId: "c1", rootId: "T1" });
  const b = make({ channelId: "c1", rootId: "T1" });
  const c = make({ channelId: "c2", rootId: "T2" });
  const d = make({ channelId: "c3", rootId: "T3" });
  assert.equal(runs.nextToSend(2)?.id, a.id);
  runs.markSent(a.id);
  // The thread of `a` waits for it; the next one goes.
  assert.equal(runs.nextToSend(2)?.id, c.id);
  runs.markSent(c.id);
  assert.equal(runs.nextToSend(2), null, "the machine has two in hand");
  assert.equal(runs.nextToSend(3)?.id, d.id, "unless it can take three");
  runs.end(a.id, "done", "ok");
  assert.equal(runs.nextToSend(3)?.id, b.id, "the thread goes on once its run is over");
});

test("a channel runs only so many at once", () => {
  const ids = [make({ rootId: "A" }), make({ rootId: "B" }), make({ rootId: "C" })];
  for (const run of ids.slice(0, 2)) runs.markSent(run.id);
  assert.equal(RUN_LIMITS.concurrentPerChannel, 2);
  assert.equal(runs.nextToSend(8), null);
  const other = make({ channelId: "c2", rootId: "D" });
  assert.equal(runs.nextToSend(8)?.id, other.id);
});

test("a person and a workspace cannot ask without end, and a full queue says busy", () => {
  for (let i = 0; i < RUN_LIMITS.perPerson.count; i++)
    make({ rootId: `x${i}`, state: "done", reason: "ok" });
  assert.equal(runs.check("u1", "c1"), "limit");
  assert.equal(runs.check("u2", "c1"), null);
  clock += RUN_LIMITS.perPerson.windowMs + 1;
  assert.equal(runs.check("u1", "c1"), null);
  for (let i = 0; i < RUN_LIMITS.queueDepth; i++)
    make({ askedBy: `q${i}`, rootId: `q${i}`, channelId: `ch${i}` });
  assert.equal(runs.check("someone", "ch-new"), "busy");
});

test("the first answer to a prompt is the one taken", () => {
  const run = make();
  runs.markSent(run.id);
  runs.markRunning(run.id);
  runs.addPrompt(run.id, { kind: "approval", id: "p1", title: "run `ls`" }, "per_1");
  runs.addPrompt(run.id, { kind: "approval", id: "p1", title: "again" }, "per_1");
  assert.equal(runs.get(run.id)?.prompts.length, 1, "asked once");
  assert.equal(runs.get(run.id)?.prompts[0]?.requestId, "per_1");
  const first = runs.answer(run.id, "p1", { id: "u2", name: "Max" }, { reply: "once" });
  assert.equal(first?.answered?.byName, "Max");
  assert.equal(runs.answer(run.id, "p1", { id: "u3", name: "Mia" }, { reply: "reject" }), null);
  assert.equal(runs.answer(run.id, "nope", { id: "u2", name: "Max" }, { reply: "once" }), null);
  runs.end(run.id, "done", "ok");
  runs.addPrompt(run.id, { kind: "approval", id: "p2", title: "late" }, "per_2");
  assert.equal(runs.get(run.id)?.prompts.length, 1, "nothing is asked of an ended run");
});

test("what waited too long, ran too long, or went quiet is found", () => {
  const waiting = make({ rootId: "w" });
  const sent = make({ rootId: "s" });
  runs.markSent(sent.id);
  const long = make({ rootId: "l" });
  runs.markSent(long.id);
  runs.markRunning(long.id);
  const asking = make({ rootId: "a" });
  runs.markSent(asking.id);
  runs.markRunning(asking.id);
  runs.addPrompt(asking.id, { kind: "approval", id: "p", title: "x" }, "r");
  clock += RUN_LIMITS.wakeMs + 1;
  const reasons = (list: ReturnType<Runs["expired"]>) =>
    Object.fromEntries(list.map((e) => [e.run.id, e.reason]));
  assert.deepEqual(reasons(runs.expired()), { [waiting.id]: "no-runner", [sent.id]: "no-runner" });
  clock += RUN_LIMITS.beatStaleMs;
  assert.deepEqual(
    runs
      .quiet()
      .map((r) => r.id)
      .sort(),
    [asking.id, long.id].sort(),
    "running ones not heard of",
  );
  runs.beat([long.id]);
  assert.deepEqual(
    runs.quiet().map((r) => r.id),
    [asking.id],
  );
  clock += RUN_LIMITS.promptWaitMs;
  const later = reasons(runs.expired());
  assert.equal(later[asking.id], "timeout", "a question left unanswered");
  clock += RUN_LIMITS.maxRunMs;
  assert.equal(reasons(runs.expired())[long.id], "timeout");
});

test("@hive is how the agent is asked for, and a person is never named by it", () => {
  assert.equal(wantsAgent("@hive summarise this"), true);
  assert.equal(wantsAgent("thanks @Hive!"), true);
  assert.equal(wantsAgent("mail@hive.com"), false);
  assert.equal(wantsAgent("@hiver"), false);
  assert.equal(wantsAgent("no mention"), false);
  const [real, other] = withHandles([
    { email: "hive@example.com", name: "A person", role: "member" },
    { email: "max@example.com", name: "Max", role: "member" },
  ]);
  assert.equal(real?.handle, "hive@example.com");
  assert.equal(other?.handle, "max");
});

test("the agent is in a public channel unless a manager said no, in a private one only if yes, and never in a direct message", () => {
  const base = { id: "c", name: "c", status: "active" } as Channel;
  assert.equal(agentOn({ ...base }), true);
  assert.equal(agentOn({ ...base, agent: false }), false);
  assert.equal(agentOn({ ...base, visibility: "private" }), false);
  assert.equal(agentOn({ ...base, visibility: "private", agent: true }), true);
  assert.equal(agentOn({ ...base, visibility: "private", agent: true, kind: "dm" }), false);
  assert.equal(agentRefusal({ ...base, kind: "dm" }), "dm");
  assert.equal(agentRefusal({ ...base, status: "archived" }), "archived");
  assert.equal(agentRefusal({ ...base, visibility: "private" }), "disabled");
  assert.equal(agentRefusal({ ...base }), null);
});

test("only an agent's own message is changed by the room's patch", () => {
  const sql = memorySql();
  const messages = new Messages(sql);
  const person = messages.post({ channelId: "c", authorId: "u1", body: "hi" }).message;
  const agent = messages.post({
    channelId: "c",
    authorId: "agent",
    authorKind: "agent",
    body: "",
  }).message;
  assert.equal(messages.patchAgent(person.id, { body: "x", extra: {} }), null);
  const patched = messages.patchAgent(agent.id, { body: "done", extra: { v: 1 } });
  assert.deepEqual(
    [patched?.body, patched?.extra, patched?.authorKind],
    ["done", { v: 1 }, "agent"],
  );
  messages.remove(agent.id);
  assert.equal(
    messages.patchAgent(agent.id, { body: "again", extra: {} }),
    null,
    "not once deleted",
  );
});

test("a manager switches the agent on or off for a channel, and closing a channel turns it off", async () => {
  const people = {
    ada: { id: "a", email: "ada@x.test", name: "Ada", role: "admin" as const },
    max: { id: "m", email: "max@x.test", name: "Max", role: "member" as const },
    mia: { id: "i", email: "mia@x.test", name: "Mia", role: "member" as const },
  };
  const world = await chatWorld(people);
  const made = await world.ok<{ id: string }>(
    await world.call("max", "POST", "/v1/channels", { name: "Work" }),
    201,
  );
  await world.call("mia", "POST", `/v1/channels/${made.id}/members`, { add: ["mia@x.test"] });
  const view = (who: "max" | "mia") =>
    world.call(who, "GET", `/v1/channels/${made.id}/members`).then((r) => r.json()) as Promise<{
      agent: boolean;
      you: { agent: boolean };
    }>;
  assert.deepEqual([(await view("max")).agent, (await view("max")).you.agent], [true, true]);
  assert.equal((await view("mia")).you.agent, false, "not hers to switch");
  assert.equal(
    (await world.call("mia", "PATCH", `/v1/channels/${made.id}`, { agent: false })).status,
    403,
  );
  assert.equal(
    (await world.call("max", "PATCH", `/v1/channels/${made.id}`, { agent: false })).status,
    200,
  );
  assert.equal((await view("mia")).agent, false);
  await world.call("max", "PATCH", `/v1/channels/${made.id}`, { agent: true });
  // Made private, what was said when it was open is not carried over.
  await world.call("max", "PATCH", `/v1/channels/${made.id}`, { visibility: "private" });
  assert.equal((await view("max")).agent, false);
  assert.equal(
    (await world.call("max", "PATCH", `/v1/channels/${made.id}`, { agent: true })).status,
    200,
  );
  assert.equal((await view("mia")).agent, true);
});
