import assert from "node:assert/strict";
import { test } from "node:test";
import { IdeaDelivery } from "../apps/server/src/chat-runner/ideas.ts";
import { SqliteRecordStore } from "../packages/chat-core/src/sqlite-store.ts";
import type { Idea, IdeaBatch } from "../packages/domain/src/agent.ts";
import type { RoomFrame, RunnerFrame } from "../packages/domain/src/chat-agent.ts";
import { chatWorld } from "./helpers/chat-world.ts";
import { memorySql } from "./helpers/do-shim.ts";

const people = {
  ada: { id: "ada", email: "ada@example.com", name: "Ada", role: "admin" },
  mia: { id: "mia", email: "mia@example.com", name: "Mia", role: "member" },
  max: { id: "max", email: "max@example.com", name: "Max", role: "member" },
  guest: { id: "guest", email: "guest@example.com", name: "Guest", role: "guest" },
} as const;
type Who = keyof typeof people;
const seed = (id: string): IdeaBatch["ideas"][number] => ({
  id,
  title: `Follow up ${id}`,
  reason: "A shared-mail request",
  prompt: "Prepare a reply",
  kind: "document",
  input: { messageId: id },
  evidence: [{ id, kind: "mail", title: "Request", excerpt: "Please complete the form" }],
  status: "new",
});

async function world() {
  const frames: RoomFrame[] = [];
  let connected = true;
  const w = await chatWorld(people, {
    runner: () => (connected ? { send: (s) => frames.push(JSON.parse(s)), close() {} } : null),
  });
  const list = async (who: Who = "mia") => w.ok<Idea[]>(await w.call(who, "GET", "/v1/ideas"));
  const batch = async (ideas: IdeaBatch["ideas"], sentMessageIds: string[] = []) => {
    await w.core.agent.onFrame(
      JSON.stringify({
        t: "ideas.batch",
        batch: { id: crypto.randomUUID(), ideas, sentMessageIds },
      }),
    );
  };
  return {
    ...w,
    frames,
    list,
    batch,
    disconnect: () => {
      connected = false;
    },
  };
}

test("mail ideas are room-owned, team-visible, and readable and dismissible while the machine sleeps", async () => {
  const w = await world();
  await w.batch([seed("mail-1")]);
  assert.ok(w.frames.some((f) => f.t === "ideas.ack"));
  const idea = (await w.list())[0]!;
  assert.deepEqual(idea.scope, { type: "team" });
  assert.equal(idea.evidence[0]?.excerpt, "Please complete the form");
  assert.equal((await w.list("ada")).length, 1);
  assert.deepEqual(await w.list("guest"), []);
  w.disconnect();
  assert.equal((await w.list())[0]?.id, idea.id);
  assert.equal(
    (await w.ok<Idea>(await w.call("max", "POST", `/v1/ideas/${idea.id}`, { action: "dismiss" })))
      .status,
    "dismissed",
  );
  await w.batch([seed("mail-1")]);
  assert.equal(
    (await w.list())[0]?.status,
    "dismissed",
    "replay does not restore a dismissed suggestion",
  );
});

test("simultaneous acceptances create exactly one goal and task together, as the first accepter", async () => {
  const w = await world();
  await w.batch([seed("accept")]);
  w.disconnect();
  const idea = (await w.list())[0]!;
  const decisions = await Promise.all(
    (["mia", "max"] as const).map((who) =>
      w
        .call(who, "POST", `/v1/ideas/${idea.id}`, { action: "accept", prompt: `From ${who}` })
        .then((r) => w.ok<Idea>(r)),
    ),
  );
  assert.equal(decisions[0]?.taskId, decisions[1]?.taskId);
  const tasks = w.core.tasks.all();
  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.prompt, `From ${task.createdBy}`);
  const goals = w.core.entries.list("goal");
  assert.equal(goals.length, 1);
  assert.equal(task.goalId, goals[0]?.id);
  assert.equal(goals[0]?.createdBy, task.createdBy);
  assert.deepEqual(goals[0]?.scope, { type: "team" });
  await w.batch([seed("accept")]);
  assert.equal((await w.list())[0]?.taskId, task.id);
});

test("dismissal racing acceptance never leaves work for a dismissed idea", async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) {
    await w.batch([seed(`race-${i}`)]);
    const idea = (await w.list()).find((item) => item.id === `idea:race-${i}`)!;
    await Promise.all([
      w.call("mia", "POST", `/v1/ideas/${idea.id}`, { action: "accept" }),
      w.call("max", "POST", `/v1/ideas/${idea.id}`, { action: "dismiss" }),
    ]);
    const saved = (await w.list()).find((i) => i.id === idea.id)!;
    const tasks = w.core.tasks.all().filter((t) => t.title === idea.title);
    assert.equal(tasks.length, saved.status === "accepted" ? 1 : 0);
    assert.equal(
      w.core.entries.list("goal").filter((e) => e.data.title === idea.title).length,
      tasks.length,
    );
  }
});

test("an interrupted legacy acceptance reuses its existing task and goal", async () => {
  const w = await world();
  w.disconnect();
  const goal = await w.core.goals.create("mia", { title: "Existing goal" });
  const existing = await w.core.work.createTask(
    "mia",
    { title: "Existing work", kind: "agent", prompt: "Saved instructions", goalId: goal.id },
    { key: "idea:interrupted" },
  );
  await w.batch([seed("interrupted")]);
  const idea = (await w.list())[0]!;
  const accepted = await w.ok<Idea>(
    await w.call("mia", "POST", `/v1/ideas/${idea.id}`, {
      action: "accept",
      prompt: "A later edit",
    }),
  );
  assert.equal(accepted.taskId, existing.id);
  assert.equal(accepted.prompt, "Saved instructions");
  assert.equal(w.core.tasks.all().length, 1);
  assert.equal(w.core.entries.list("goal").length, 1);
});

test("an import keeps its private audience and dismissal when a fresh report arrives alongside it", async () => {
  const w = await world();
  const channel = await w.ok<{ id: string }>(
    await w.call("mia", "POST", "/v1/channels", { name: "Private", visibility: "private" }),
    201,
  );
  await Promise.all([
    w.batch([{ ...seed("import-race"), channelId: channel.id, status: "dismissed" }]),
    w.batch([seed("import-race")]),
  ]);
  assert.equal((await w.list())[0]?.status, "dismissed");
  assert.deepEqual((await w.list())[0]?.scope, { type: "channel", id: channel.id });
  assert.deepEqual(await w.list("ada"), []);
});

test("the task cap refuses an acceptance without marking it accepted or leaving a goal", async () => {
  const w = await world();
  await w.batch([seed("full")]);
  for (let i = 0; i < 100; i++)
    await w.core.work.createTask("mia", { kind: "manual", title: `Open ${i}` });
  const idea = (await w.list())[0]!;
  const response = await w.call("mia", "POST", `/v1/ideas/${idea.id}`, { action: "accept" });
  assert.equal(response.status, 409);
  assert.equal((await w.list())[0]?.status, "new");
  assert.equal(w.core.entries.list("goal").length, 0);
  assert.equal(w.core.tasks.all().length, 100);
});

test("a failed idea write rolls back its task and goal and publishes no new work", async () => {
  const w = await world();
  w.disconnect();
  await w.batch([seed("rollback")]);
  const put = w.core.entries.put.bind(w.core.entries);
  w.core.entries.put = (input) => {
    if (input.kind === "idea" && input.status === "accepted")
      throw new Error("Storage interrupted");
    return put(input);
  };
  const response = await w.call("mia", "POST", "/v1/ideas/idea:rollback", { action: "accept" });
  assert.equal(response.status, 500);
  w.core.entries.put = put;
  assert.equal((await w.list())[0]?.status, "new");
  assert.equal(w.core.tasks.all().length, 0);
  assert.equal(w.core.entries.list("goal").length, 0);
  assert.ok(!w.published.some((event) => event.type === "task.changed"));
});

test("private ideas and their updates obey scope, and acceptance never widens the audience", async () => {
  const w = await world();
  w.disconnect();
  const personal = await w.ok<Idea>(
    await w.call("mia", "POST", "/v1/ideas", { ...seed("private"), scope: { type: "person" } }),
    201,
  );
  for (const who of ["ada", "max", "guest"] as const) {
    assert.deepEqual(await w.list(who), []);
    assert.notEqual(
      (await w.call(who, "POST", `/v1/ideas/${personal.id}`, { action: "dismiss" })).status,
      200,
    );
  }
  const unsafe = await w.call("mia", "POST", `/v1/ideas/${personal.id}`, {
    action: "accept",
    projectId: "general",
  });
  assert.equal(unsafe.status, 409);
  assert.equal(w.core.tasks.all().length, 0);
  const project = await w.core.work.createProject("mia", {
    name: "Private work",
    access: "private",
  });
  const projectIdea = await w.core.ideas.create("mia", {
    ...seed("project"),
    scope: { type: "project", id: project.id },
  });
  const accepted = await w.ok<Idea>(
    await w.call("mia", "POST", `/v1/ideas/${projectIdea.id}`, { action: "accept" }),
  );
  assert.equal(w.core.tasks.get(accepted.taskId!)?.projectId, project.id);
  assert.deepEqual(w.core.entries.list("goal")[0]?.scope, { type: "project", id: project.id });
  assert.deepEqual(await w.list("max"), []);
  await w.ok(await w.call("mia", "DELETE", `/v1/projects/${project.id}`, { deleteTasks: true }));
  assert.ok(!(await w.list()).some((i) => i.id === projectIdea.id));
  assert.ok(
    !w.published.some(
      (e) =>
        e.type === "entry.changed" &&
        e.userId === "max" &&
        (e.data as { id: string }).id === personal.id,
    ),
  );
});

test("mail completion and sent replies retire only imported mail suggestions, and guest decisions are refused", async () => {
  const w = await world();
  await w.batch([seed("completed"), seed("sent"), seed("open")]);
  const personal = await w.core.ideas.create("mia", { ...seed("sent"), scope: { type: "person" } });
  w.core.tasks.create({
    id: "finished",
    createdBy: "mia",
    kind: "document",
    status: "in_review",
    input: { messageId: "completed" },
  });
  await w.batch([seed("completed"), seed("sent"), seed("open")], ["sent"]);
  const list = await w.list();
  assert.equal(list.find((i) => i.id === "idea:completed")?.status, "dismissed");
  assert.equal(list.find((i) => i.id === "idea:sent")?.status, "dismissed");
  assert.equal(list.find((i) => i.id === "idea:open")?.status, "new");
  assert.equal(list.find((i) => i.id === personal.id)?.status, "new");
  assert.equal(
    (await w.call("guest", "POST", "/v1/ideas/idea:open", { action: "accept" })).status,
    403,
  );
});

test("pending batches survive restart; legacy rows are removed only on acknowledgement and stale acknowledgements cannot clear new mail", async () => {
  const db = new SqliteRecordStore(memorySql());
  const sent: RunnerFrame[] = [];
  let open = false;
  const send = (frame: RunnerFrame) => {
    if (!open) return false;
    sent.push(frame);
    return true;
  };
  let delivery = new IdeaDelivery(db, send);
  await db.put("shared", "ideas", {
    ...seed("legacy"),
    createdAt: "2026-10-01T00:00:00.000Z",
    status: "dismissed",
  });
  await delivery.onOpen();
  assert.equal(sent.length, 0);
  delivery = new IdeaDelivery(db, send);
  open = true;
  await delivery.onOpen();
  const imported = sent.find((f) => f.t === "ideas.batch")!;
  assert.equal(imported.t, "ideas.batch");
  assert.ok(await db.get("shared", "ideas", "legacy"));
  const w = await world();
  await w.core.agent.onFrame(JSON.stringify(imported));
  assert.equal((await w.list())[0]?.status, "dismissed");
  assert.equal((await w.list())[0]?.createdAt, "2026-10-01T00:00:00.000Z");
  await delivery.ack(imported.batch.id);
  assert.equal(await db.get("shared", "ideas", "legacy"), null);
  await delivery.report({ ideas: [seed("old")], sentMessageIds: [] });
  const old = (await db.list<{ batch: IdeaBatch }>("system", "idea-delivery"))[0]!.batch.id;
  await delivery.report({ ideas: [seed("new")], sentMessageIds: [] });
  await delivery.ack(old);
  assert.equal(
    (await db.list<{ batch: IdeaBatch }>("system", "idea-delivery"))[0]?.batch.ideas[0]?.id,
    "new",
  );
});
