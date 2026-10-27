import assert from "node:assert/strict";
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
