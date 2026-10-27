import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { people, wired } from "./helpers/chat-wired.ts";

/**
 * The agent changes the board through the chat service, as the person it works for. The room decides who that
 * is from the run (or the ticket the app gave), never from what the machine says, so the agent sees and
 * changes what that person could and nothing more.
 */
test("the agent makes items as the person who asked, and cannot put one in a private project of someone else's", async (t) => {
  let attempt = "";
  let secretId = "";
  const f = await wired(t, async ({ call, say }) => {
    await call("create_issue", { title: "Book the room" });
    attempt = await call("create_issue", { title: "Sneak in", projectId: secretId }).then(
      () => "made",
      (e: unknown) => String(e),
    );
    say("Done.");
  });
  const secret = await f.core.work.createProject(people.max.id, {
    name: "Reorg",
    access: "private",
  });
  secretId = secret.id;
  const room = await f.channel("mia", "Design");
  const asked = await f.post("mia", room.id, "@hive put it on the board");
  await f.finished(asked.id, "mia");
  const made = f.core.tasks.all();
  assert.deepEqual(
    made.map((task) => [task.title, task.createdBy, task.channelId]),
    [["Book the room", people.mia.id, room.id]],
  );
  assert.match(attempt, /not found/i);
});

test("a call for a run that is over, or for a task the machine does not hold, is turned down", async (t) => {
  const f = await wired(t, ({ say }) => say("ok"));
  const board = f.server.agent.board;
  await assert.rejects(
    board.forRun("no-such-run").call("task.create", { title: "x", kind: "manual", input: {} }),
    /over/,
  );
  await assert.rejects(
    board.forTask("no-such-task").call("task.create", { title: "x", kind: "manual", input: {} }),
    /not being worked on/,
  );
  await assert.rejects(
    board.forPerson(people.max.id).call("task.create", { title: "x", kind: "manual", input: {} }),
    /Open the app/,
  );
  assert.equal(f.core.tasks.all().length, 0);
});

test("a ticket from the app lets the agent change the board for that person, and a changed one does not", async (t) => {
  const f = await wired(t, ({ say }) => say("ok"));
  const response = await f.call("max", "GET", "/v1/work/ticket");
  const { ticket } = (await response.json()) as { ticket: string };
  const send = (ticket: string, title: string) =>
    f.core.agent.onFrame(
      JSON.stringify({
        t: "work.call",
        reqId: crypto.randomUUID(),
        ticket,
        op: "task.create",
        args: { title, kind: "manual", input: {} },
      }),
    );
  await send(ticket, "From the app's chat");
  // Someone else's name on the same signature, and a ticket from nowhere.
  const [body, signature] = ticket.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()),
      u: "acct_olive",
    }),
  ).toString("base64url");
  await send(`${forged}.${signature}`, "Forged");
  await send("nonsense", "Nonsense");
  const made = f.core.tasks.all();
  assert.deepEqual(
    made.map((task) => [task.title, task.createdBy]),
    [["From the app's chat", people.max.id]],
  );
});

test("what only the machine keeps of a task is asked for through the room, for a person who may see the task", async (t) => {
  const f = await wired(t, (turn) => turn.say("Done.\nTASK_COMPLETE: all good"));
  const made = await f.core.work.createTask(people.max.id, {
    kind: "agent",
    prompt: "Do it",
    input: {},
  });
  await f.until("the task to come back", () => f.core.tasks.get(made.id)?.status === "in_review");
  const seen = await f.call("max", "GET", `/v1/tasks/${made.id}/run`);
  assert.equal(seen.status, 200);
  const history = (await seen.json()) as { awake: boolean; events: unknown[]; files: unknown[] };
  assert.equal(history.awake, true);
  assert.ok(Array.isArray(history.events));
  // Someone who may not see the task is not told it exists.
  const secret = await f.core.work.createProject(people.max.id, {
    name: "Reorg",
    access: "private",
  });
  const hidden = await f.core.work.createTask(people.max.id, {
    kind: "manual",
    title: "Quiet",
    projectId: secret.id,
    input: {},
  });
  const refused = await f.call("mia", "GET", `/v1/tasks/${hidden.id}/run`);
  assert.equal(refused.status, 404);
});

test("when a person marks a task done, the goal it counts toward is told on the machine", async (t) => {
  const f = await wired(t, ({ say }) => say("ok"));
  const goal = await f.server.agent.createGoal(people.max.id, {
    title: "Launch",
    description: "Ship it",
    category: "work",
    milestones: [],
  });
  const made = await f.core.work.createTask(people.max.id, {
    kind: "manual",
    title: "Write the post",
    goalId: goal.id,
    input: {},
  });
  await f.core.work.updateTask(people.max.id, made.id, { status: "succeeded" });
  await f.until("the goal to count it", async () => {
    const current = await f.db.get<{ milestones: { id: string; done: boolean }[] }>(
      people.max.id,
      "goals",
      goal.id,
    );
    return Boolean(current?.milestones.some((m) => m.id === made.id && m.done));
  });
  // Said once it is done: the room does not keep telling.
  await f.until(
    "the room to stop telling",
    async () => (await f.core.store.list("system", "outcomes")).length === 0,
  );
});

test("a file attached to a task is kept by the room, reaches the agent while it works, and is gone from the machine after", async (t) => {
  const prompts: string[] = [];
  const f = await wired(t, (turn) => {
    prompts.push(turn.text);
    turn.say("Read it.\nTASK_COMPLETE: summarised");
  });
  const made = await f.core.work.createTask(people.max.id, {
    kind: "manual",
    title: "Summarise the brief",
    prompt: "Summarise the attached brief",
    input: {},
  });
  // The person asks to attach, sends the bytes to the address given, and puts the file on the task.
  const bytes = new TextEncoder().encode("# Brief\n\nLaunch in May.\n");
  const begun = await f.call("max", "POST", `/v1/tasks/${made.id}/attachments/begin`, {
    name: "brief.md",
    bytes: bytes.length,
  });
  assert.equal(begun.status, 201);
  const { fileId } = (await begun.json()) as { fileId: string };
  f.stored.set(fileId, bytes);
  f.core.filing.uploaded(fileId, "file", bytes.length);
  const attached = await f.call("max", "POST", `/v1/tasks/${made.id}/attachments`, { fileId });
  assert.equal(attached.status, 201);
  const shown = (await attached.json()) as { attachments: { name: string; url?: string }[] };
  assert.equal(shown.attachments[0]?.name, "brief.md");
  assert.match(shown.attachments[0]?.url ?? "", /^\/f\/dl\//);
  // Someone who may not see the task cannot put a file on it.
  const secret = await f.core.work.createProject(people.max.id, {
    name: "Reorg",
    access: "private",
  });
  const hidden = await f.core.work.createTask(people.max.id, {
    kind: "manual",
    title: "Quiet",
    projectId: secret.id,
    input: {},
  });
  const refused = await f.call("mia", "POST", `/v1/tasks/${hidden.id}/attachments/begin`, {
    name: "x.md",
    bytes: 3,
  });
  assert.equal(refused.status, 404);
  // Handing the task to the agent: the file is fetched for the run and the agent is told where it is.
  const handed = await f.call("max", "PATCH", `/v1/tasks/${made.id}`, { assignee: "agent" });
  assert.equal(handed.status, 200);
  await f.until("the task to come back", () => f.core.tasks.get(made.id)?.status === "in_review");
  assert.match(prompts[0] ?? "", /brief\.md/);
  await f.until(
    "the machine to let go of its files",
    async () => (await f.db.scan("tasks")).length === 0,
  );
  assert.equal(
    await readdir(join(f.dataDir, "task-files", made.id)).then(
      (names) => names.length,
      () => 0,
    ),
    0,
  );
  // Taking it off the task is the person who attached it.
  const gone = await f.call("max", "DELETE", `/v1/tasks/${made.id}/attachments/${fileId}`);
  assert.equal(gone.status, 200);
  assert.equal(f.core.files.get(fileId), null);
});

test("only a person marks work done, and only work that is ready for review", async (t) => {
  const f = await wired(t, ({ say }) => say("ok"));
  const made = await f.core.work.createTask(people.max.id, {
    kind: "agent",
    prompt: "Draft the update",
    input: {},
  });
  // Not handed in yet: nothing to mark done.
  f.core.tasks.change(made.id, { status: "paused" });
  const early = await f.call("max", "POST", `/v1/tasks/${made.id}/accept`, {});
  assert.equal(early.status, 409);
  f.core.tasks.change(made.id, { status: "in_review" });
  const done = await f.call("max", "POST", `/v1/tasks/${made.id}/accept`, {});
  assert.equal(done.status, 200);
  assert.equal(f.core.tasks.get(made.id)?.status, "succeeded");
});

test("a task is handed to another channel the person can open, and stays in review if it was", async (t) => {
  const f = await wired(t, ({ say }) => say("ok"));
  const room = await f.channel("max", "Design");
  const secret = await f.channel("mia", "Payroll", "private");
  const made = await f.core.work.createTask(people.max.id, {
    kind: "agent",
    prompt: "Draft the update",
    input: {},
  });
  f.core.tasks.change(made.id, { status: "in_review" });
  const missing = await f.call("max", "POST", `/v1/tasks/${made.id}/delegate`, { target: "nowhere" });
  assert.equal(missing.status, 404);
  // A channel the person cannot open is not one they are told exists.
  const closed = await f.call("max", "POST", `/v1/tasks/${made.id}/delegate`, { target: secret.id });
  assert.equal(closed.status, 404);
  const moved = await f.call("max", "POST", `/v1/tasks/${made.id}/delegate`, {
    target: room.id,
    reason: "Design owns it",
  });
  assert.equal(moved.status, 200);
  const task = f.core.tasks.get(made.id);
  assert.deepEqual(
    [task?.channelId, task?.delegatedTo, task?.status, task?.originChannelId],
    [room.id, room.id, "in_review", "orchestrator"],
  );
  // An archived channel takes no work.
  await f.call("max", "POST", `/v1/channels/${room.id}/archive`, {});
  const archived = await f.call("max", "POST", `/v1/tasks/${made.id}/delegate`, { target: room.id });
  assert.equal(archived.status, 404);
});
