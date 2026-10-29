import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatCore } from "../apps/chat/src/core.ts";
import type { EntryScope } from "../packages/chat-core/src/entries.ts";
import { AppError } from "../packages/chat-core/src/errors.ts";
import type { Run } from "../packages/chat-core/src/runs.ts";
import { SHARED_OWNER } from "../packages/chat-core/src/shared.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import type { RoomFrame } from "../packages/domain/src/chat-agent.ts";
import { chatWorld } from "./helpers/chat-world.ts";

const people = {
  ada: { id: "ada", email: "ada@example.com", name: "Ada", role: "admin" },
  mia: { id: "mia", email: "mia@example.com", name: "Mia", role: "member" },
  max: { id: "max", email: "max@example.com", name: "Max", role: "member" },
  gus: { id: "gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;

async function world(visibility: "public" | "private" = "public", members = ["mia@example.com"]) {
  const frames: RoomFrame[] = [];
  const w = await chatWorld(people, {
    link: { key: "test-key", workspaceId: "test-workspace" },
    runner: () => ({ send: (s) => frames.push(JSON.parse(s)), close() {} }),
  });
  let channel = await w.ok<Channel>(
    await w.call("ada", "POST", "/v1/channels", { name: "Board", visibility, everyone: false }),
    201,
  );
  await w.call("ada", "POST", `/v1/channels/${channel.id}/members`, { add: members });
  await w.call("ada", "PATCH", `/v1/channels/${channel.id}`, { agent: true });
  channel = (await w.core.store.get<Channel>(SHARED_OWNER, "channels", channel.id))!;
  const run = (extra: Partial<Run> = {}): Run => ({
    id: crypto.randomUUID(),
    channelId: channel.id,
    rootId: crypto.randomUUID(),
    triggerId: "trigger",
    replyId: "reply",
    askedBy: "ada",
    askerRole: "admin",
    state: "running",
    reason: null,
    prompts: [],
    lastN: 0,
    attempt: 1,
    createdMs: Date.now(),
    sentMs: Date.now(),
    beatMs: Date.now(),
    endedMs: null,
    updates: 0,
    savedMs: 0,
    ...extra,
  });
  const goal = (title: string, scope: EntryScope) =>
    w.core.goals.create("ada", {
      title,
      description: title,
      category: "work",
      milestones: [],
      scope,
    });
  const routine = (title: string, scope: EntryScope) =>
    w.core.routines.create(
      "ada",
      { title, note: title, schedule: { kind: "every", minutes: 60 }, scope },
      { channelId: channel.id },
    );
  const task = (title: string, projectId = "general") =>
    w.core.work.createTask("ada", { title, kind: "manual", input: {}, projectId });
  const project = async (name: string, emails: string[] = [people.mia.email]) => {
    const made = await w.core.work.createProject("ada", { name, access: "private" });
    return w.core.work.updateProject("ada", made.id, {
      members: [
        { email: people.ada.email, role: "admin" },
        ...emails.map((email) => ({ email, role: "viewer" })),
      ],
    });
  };
  const start = async () => {
    const message = await w.ok<ChatMessage>(
      await w.call("ada", "POST", `/v1/channels/${channel.id}/messages`, {
        body: "@hive look up the board",
      }),
      201,
    );
    await w.core.agent.pump();
    const active = w.core.runs.byTrigger(message.id)!;
    assert.ok(frames.some((f) => f.t === "run.start" && f.run.id === active.id));
    return active;
  };
  const request = async (active: Run | null, op: string, args: object = {}, extra: object = {}) => {
    const reqId = crypto.randomUUID();
    await w.core.agent.onFrame(
      JSON.stringify({
        t: "work.call",
        reqId,
        ...(active ? { runId: active.id } : {}),
        op,
        args,
        ...extra,
      }),
    );
    const reply = frames.find((f) => f.t === "work.result" && f.reqId === reqId);
    assert.ok(reply?.t === "work.result");
    return reply;
  };
  return { ...w, channel, frames, run, goal, routine, task, project, start, request };
}
const ids = (rows: { id?: unknown }[]) => rows.map((row) => row.id).sort();
const denied = (error: unknown) => error instanceof AppError && [404, 409].includes(error.status);

test("public lookups include unjoined readers and never use the asker's admin override", async () => {
  const w = await world();
  const hidden = await w.project("HIDDEN-project");
  await w.task("HIDDEN-task", hidden.id);
  await w.goal("HIDDEN-goal", { type: "project", id: hidden.id });
  await w.routine("HIDDEN-routine", { type: "project", id: hidden.id });
  const task = await w.task("Visible task");
  const goal = await w.goal("Visible goal", { type: "team" });
  const routine = await w.routine("Visible routine", { type: "team" });
  const result = await w.core.channelBoard.read(w.run());
  assert.deepEqual(ids(result.tasks), [task.id]);
  assert.deepEqual(ids(result.goals), [goal.id]);
  assert.deepEqual(ids(result.routines), [routine.id]);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN/);
  assert.ok(!(w.channel.members ?? []).includes(people.max.email));
  assert.equal(result.hasMore, false);
});

test("private lookups use visibility, including project viewers and broader channel scopes", async () => {
  const w = await world("private");
  const project = await w.project("Shared private project");
  const task = await w.task("Viewer may read", project.id);
  const goal = await w.goal("Project goal", { type: "project", id: project.id });
  const routine = await w.routine("Channel routine", { type: "channel", id: w.channel.id });
  const narrower = await w.ok<Channel>(
    await w.call("ada", "POST", "/v1/channels", { name: "HIDDEN-channel", visibility: "private" }),
    201,
  );
  await w.goal("HIDDEN-goal", { type: "channel", id: narrower.id });
  await w.routine("HIDDEN-personal", { type: "person" });
  const result = await w.core.channelBoard.read(w.run());
  assert.ok(ids(result.projects).includes(project.id));
  assert.deepEqual(ids(result.tasks), [task.id]);
  assert.deepEqual(ids(result.goals), [goal.id]);
  assert.deepEqual(ids(result.routines), [routine.id]);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN/);
});

test("a guest reader excludes team items and admits explicitly shared project and channel items", async () => {
  const w = await world("public", [people.gus.email]);
  const project = await w.project("Shared with guest", [
    people.mia.email,
    people.max.email,
    people.gus.email,
  ]);
  const task = await w.task("Guest task", project.id);
  const goal = await w.goal("Guest goal", { type: "project", id: project.id });
  const routine = await w.routine("Guest routine", { type: "channel", id: w.channel.id });
  await w.task("HIDDEN-general");
  await w.goal("HIDDEN-team", { type: "team" });
  await w.routine("HIDDEN-personal", { type: "person" });
  const result = await w.core.channelBoard.read(w.run({ askedBy: "gus", askerRole: "guest" }));
  assert.deepEqual(ids(result.projects), [project.id]);
  assert.deepEqual(ids(result.tasks), [task.id]);
  assert.deepEqual(ids(result.goals), [goal.id]);
  assert.deepEqual(ids(result.routines), [routine.id]);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN/);
});

test("a personal item can be read in a sole-reader channel, while DMs remain excluded", async () => {
  const w = await world("private", []);
  const goal = await w.goal("Own goal", { type: "person" });
  const routine = await w.routine("Own routine", { type: "person" });
  const result = await w.core.channelBoard.read(w.run());
  assert.deepEqual(ids(result.goals), [goal.id]);
  assert.deepEqual(ids(result.routines), [routine.id]);
  await w.core.store.put(SHARED_OWNER, "channels", { ...w.channel, kind: "dm" });
  await assert.rejects(w.core.channelBoard.read(w.run()), denied);
});

test("query, exact IDs and pagination operate only on visible results", async () => {
  const w = await world();
  const project = await w.project("HIDDEN-project");
  const hidden = await w.task("HIDDEN-needle", project.id);
  for (let i = 0; i < 4; i++) await w.task(`Needle ${i}`);
  const run = w.run();
  const first = await w.core.channelBoard.read(run, { kind: "tasks", query: "needle", limit: 2 });
  const second = await w.core.channelBoard.read(run, {
    kind: "tasks",
    query: "NEEDLE",
    limit: 2,
    offset: first.nextOffset,
  });
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...ids(first.tasks), ...ids(second.tasks)]).size, 4);
  assert.equal((await w.core.channelBoard.read(run, { id: hidden.id })).tasks.length, 0);
  assert.equal((await w.core.channelBoard.read(run, { query: "HIDDEN" })).hasMore, false);
  await assert.rejects(w.core.channelBoard.require(run, "tasks", hidden.id), denied);
  await assert.rejects(w.core.channelBoard.require(run, "tasks", "nonexistent"), denied);
  for (const bad of [{ limit: 51 }, { offset: -1 }, { query: "x".repeat(501) }])
    await assert.rejects(
      w.core.channelBoard.read(run, bad),
      (e) => e instanceof AppError && e.status === 422,
    );
});

test("task projections omit machine data and links to narrower goals and tasks", async () => {
  const w = await world();
  const project = await w.project("HIDDEN-project");
  const secret = await w.task("HIDDEN-task", project.id);
  const hiddenGoal = await w.goal("HIDDEN-goal", { type: "person" });
  const publicGoal = await w.goal("Shared goal", { type: "team" });
  w.core.tasks.change(secret.id, { status: "succeeded", goalId: publicGoal.id });
  await w.core.goals.countTask(w.core.tasks.get(secret.id)!);
  const task = await w.task("Visible task");
  w.core.tasks.change(task.id, {
    blockedBy: [secret.id],
    goalId: hiddenGoal.id,
    input: { secret: "MACHINE-SECRET" },
    state: { secret: "MACHINE-SECRET" },
    originChannelId: "HIDDEN-origin",
    threadId: "HIDDEN-thread",
    result: "😀".repeat(12000),
  });
  const run = w.run();
  const result = await w.core.channelBoard.read(run);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN|MACHINE-SECRET/);
  assert.deepEqual(result.tasks[0]?.blockedBy, []);
  assert.equal(result.tasks[0]?.goalId, undefined);
  assert.deepEqual(result.goals[0]?.milestones, []);
  assert.equal(result.tasks[0]?.truncated, true);
  assert.equal(typeof result.tasks[0]?.result, "string");
  assert.ok(JSON.stringify(result).length < 10000);
  assert.deepEqual(await w.core.channelBoard.visibleIds(run, [task.id, secret.id, "absent"]), [
    task.id,
  ]);
});

test("large Unicode results stay within the response budget and pagination makes progress", async () => {
  const w = await world();
  for (let i = 0; i < 40; i++) {
    const task = await w.task(`Task ${i}`);
    w.core.tasks.change(task.id, {
      prompt: "😀".repeat(1200),
      result: "😀".repeat(1200),
      notes: [0, 1, 2].map((n) => ({
        id: `note-${n}`,
        text: "文".repeat(1000),
        createdAt: new Date().toISOString(),
        createdBy: "ada",
        kind: "note" as const,
        delivered: false,
      })),
    });
  }
  const run = w.run();
  const first = await w.core.channelBoard.read(run, { kind: "tasks", limit: 50 });
  assert.ok(new TextEncoder().encode(JSON.stringify(first)).length <= 160000);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextOffset && first.nextOffset > 0);
  const found = new Set(ids(first.tasks));
  let page = first;
  for (let n = 0; page.hasMore && n < 10; n++) {
    page = await w.core.channelBoard.read(run, {
      kind: "tasks",
      limit: 50,
      offset: page.nextOffset,
    });
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).length <= 160000);
    for (const id of ids(page.tasks)) {
      assert.ok(!found.has(id));
      found.add(id);
    }
  }
  assert.equal(page.hasMore, false);
  assert.equal(found.size, 40);
  const goal = await w.goal("Large detail", { type: "team" });
  await w.core.goals.update("ada", goal.id, {
    milestones: Array.from({ length: 100 }, (_, i) => ({
      id: `${i}:` + "\0".repeat(190),
      title: "\0".repeat(200),
      done: false,
    })),
  });
  await assert.rejects(
    w.core.channelBoard.read(run, { kind: "goals", id: goal.id }),
    (e) => e instanceof AppError && e.status === 422,
  );
  assert.equal((await w.core.channelBoard.read(run, { kind: "goals" })).goals.length, 1);
});

test("unknown project IDs fail closed and routine summaries omit their private wake location", async () => {
  const w = await world();
  const task = await w.task("HIDDEN-orphan");
  w.core.tasks.change(task.id, { projectId: "nonexistent-project" });
  const routine = await w.routine("Visible routine", { type: "team" });
  const entry = w.core.entries.get(routine.id)!;
  w.core.entries.put({
    ...entry,
    data: {
      ...entry.data,
      where: { channelId: "HIDDEN-wake-channel", rootId: "HIDDEN-root" },
      hook: { on: true, epoch: 5 },
    },
  });
  const result = await w.core.channelBoard.read(w.run());
  assert.equal(result.tasks.length, 0);
  assert.equal(result.routines.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN|hook|where/);
});

test("cached access survives a room restart and rotates only when exposed permissions change", async () => {
  const w = await world("private");
  const project = await w.project("Project");
  const task = await w.task("Task", project.id);
  const run = w.run();
  const key = await w.core.channelBoard.begin(run);
  await w.core.channelBoard.read(run);
  w.core.tasks.change(task.id, { result: "Progress", status: "running" });
  const next = w.run({ rootId: run.rootId });
  assert.equal(await w.core.channelBoard.begin(next), key);
  const restarted = new ChatCore(w.core.sql);
  assert.equal(await restarted.channelBoard.begin(w.run({ rootId: run.rootId })), key);
  w.core.projects.put({ ...project, members: [] });
  assert.equal(w.core.channelBoard.current(run), false);
  assert.notEqual(await restarted.channelBoard.begin(w.run({ rootId: run.rootId })), key);
  await assert.rejects(w.core.channelBoard.read(run), denied);
});

test("new channel readers invalidate cached results, including unjoined public readers", async () => {
  for (const visibility of ["private", "public"] as const) {
    const w = await world(visibility);
    const run = w.run();
    const key = await w.core.channelBoard.begin(run);
    await w.core.channelBoard.read(run);
    if (visibility === "private")
      await w.call("ada", "POST", `/v1/channels/${w.channel.id}/members`, {
        add: [people.max.email],
      });
    else
      await w.core.syncPerson({
        sub: "new",
        email: "new@example.com",
        name: "New",
        role: "member",
        issuedAt: Date.now(),
      });
    assert.equal(w.core.channelBoard.current(run), false);
    assert.notEqual(await w.core.channelBoard.begin(w.run({ rootId: run.rootId })), key);
  }
});

test("task and entry scope moves invalidate earlier tool results", async () => {
  const w = await world();
  const project = await w.project("Private");
  const task = await w.task("Task");
  const goal = await w.goal("Goal", { type: "team" });
  const run = w.run();
  await w.core.channelBoard.read(run);
  w.core.tasks.change(task.id, { projectId: project.id });
  assert.equal(w.core.channelBoard.current(run), false);
  const next = w.run();
  await w.core.channelBoard.read(next);
  w.core.entries.put({ ...w.core.entries.get(goal.id)!, scope: { type: "person", id: "ada" } });
  assert.equal(w.core.channelBoard.current(next), false);
});

test("an access change while an asynchronous lookup is assembling results refuses the read", async () => {
  const w = await world("private");
  const project = await w.project("Project");
  await w.task("Task", project.id);
  const original = w.core.goals.list.bind(w.core.goals);
  w.core.goals.list = async (actor) => {
    const result = await original(actor);
    w.core.projects.put({ ...project, members: [] });
    return result;
  };
  await assert.rejects(
    w.core.channelBoard.read(w.run()),
    (e) => e instanceof AppError && e.status === 409,
  );
});

test("the wire filters all read paths and prevents guessing a personal routine through update", async () => {
  const w = await world();
  await w.task("Shared task");
  const routine = await w.routine("HIDDEN-routine", { type: "person" });
  const goal = await w.goal("HIDDEN-goal", { type: "person" });
  const run = await w.start();
  for (const op of ["board", "goal.list", "routine.list"]) {
    const reply = await w.request(run, op);
    assert.ok(reply.ok);
    assert.doesNotMatch(JSON.stringify(reply.body), /HIDDEN/);
  }
  const refused = await w.request(run, "routine.update", {
    routineId: routine.id,
    title: "Changed",
  });
  assert.equal(refused.ok, false);
  const goalReply = await w.request(run, "board", { id: goal.id });
  assert.ok(goalReply.ok);
  assert.doesNotMatch(JSON.stringify(goalReply.body), /HIDDEN/);
  assert.equal(
    (await w.core.routines.list("ada")).find((r) => r.id === routine.id)?.title,
    "HIDDEN-routine",
  );
});

test("revoking shared access stops streamed and final replies and clears tool steps", async () => {
  const w = await world("private");
  const project = await w.project("Project");
  await w.task("Private details", project.id);
  const run = await w.start();
  assert.equal((await w.request(run, "board")).ok, true);
  w.core.projects.put({ ...project, members: [] });
  await w.core.agent.onFrame(
    JSON.stringify({
      t: "run.say",
      runId: run.id,
      n: 1,
      body: "Private details",
      steps: [{ result: "Private details" }],
    }),
  );
  await w.core.agent.onFrame(
    JSON.stringify({
      t: "run.end",
      runId: run.id,
      n: 2,
      status: "done",
      body: "Private details",
      steps: [{ result: "Private details" }],
    }),
  );
  const reply = w.core.messages.get(run.replyId)!;
  assert.match(reply.body, /access changed/);
  assert.doesNotMatch(JSON.stringify(reply), /Private details/);
  assert.equal(w.core.runs.get(run.id)?.state, "failed");
  assert.ok(w.frames.some((f) => f.t === "run.stop" && f.runId === run.id));
});

test("removing a shared routine does not invalidate the reply to its own deletion", async () => {
  const w = await world();
  const routine = await w.routine("Routine", { type: "team" });
  const run = await w.start();
  assert.equal((await w.request(run, "routine.remove", { routineId: routine.id })).ok, true);
  assert.equal(w.core.channelBoard.current(run), true);
});

test("personal tickets and leased task lookups retain the actor's own access", async () => {
  const w = await world();
  const project = await w.project("Actor's project", []);
  const task = await w.task("HIDDEN-from-channel", project.id);
  const ownGoal = await w.goal("Own goal", { type: "person" });
  const ticket = w.core.agent.boardTicket("ada").ticket;
  const personal = await w.request(null, "board", {}, { ticket });
  assert.ok(personal.ok);
  assert.match(JSON.stringify(personal.body), new RegExp(ownGoal.id));
  assert.match(JSON.stringify(personal.body), /HIDDEN-from-channel/);
  w.core.sql.run("UPDATE tasks SET lease_id = ? WHERE id = ?", "held", task.id);
  const worker = await w.request(null, "board", {}, { taskId: task.id, leaseId: "held" });
  assert.ok(worker.ok);
  assert.match(JSON.stringify(worker.body), /HIDDEN-from-channel/);
});
