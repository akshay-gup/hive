import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { people, wired } from "./helpers/chat-wired.ts";

/**
 * A task through the real room, the real server (its worker, executor, sessions and tools) and OpenCode played
 * by a stand-in: the room holds the task, the machine is lent it, works it, and gives it back.
 */
const ask = (f: Awaited<ReturnType<typeof wired>>, body: object) =>
  f.core.work.createTask(people.max.id, { kind: "agent", input: {}, ...body });
const task = (f: Awaited<ReturnType<typeof wired>>, id: string) =>
  f.core.tasks.get(id) as AgentTask;

test("an agent task the room holds is lent to the machine, worked there, and handed back for review", async (t) => {
  const prompts: string[] = [];
  const f = await wired(t, (turn) => {
    prompts.push(turn.text);
    turn.say("Looked at it.\nTASK_COMPLETE: three venues found");
  });
  const made = await ask(f, { prompt: "Find three venues" });
  await f.until("the task to come back", () => task(f, made.id).status === "in_review");
  const back = task(f, made.id);
  assert.equal(back.leaseId, null);
  assert.equal(back.attempts, 1);
  assert.match(String(back.result), /three venues found/);
  assert.ok(prompts[0]?.includes("Find three venues"), "the agent was given the task's words");
  // The machine keeps nothing of it once it is handed back.
  await f.until(
    "the machine to let go of its copy",
    async () => (await f.db.scan("tasks")).length === 0,
  );
});

test("a task that asks a question waits for a person, and carries on with the answer", async (t) => {
  const prompts: string[] = [];
  const f = await wired(t, (turn) => {
    prompts.push(turn.text);
    if (prompts.length === 1) turn.say("TASK_BLOCKED: which venue do you like?");
    else turn.say("TASK_COMPLETE: booked the first");
  });
  const made = await ask(f, { prompt: "Book a venue" });
  await f.until("the question", () => task(f, made.id).status === "waiting_input");
  assert.equal(task(f, made.id).question, "which venue do you like?");
  const answered = await f.call("max", "POST", `/v1/tasks/${made.id}/input`, {
    answer: "The first",
  });
  assert.equal(answered.status, 200);
  await f.until("the task to finish", () => task(f, made.id).status === "in_review");
  assert.ok(
    prompts[1]?.includes("The first"),
    `the second run was given the answer: ${prompts[1]?.slice(0, 300)}`,
  );
  // The machine marked the answer as read, and the room knows.
  assert.ok(task(f, made.id).notes?.every((n) => n.delivered));
});

test("pausing a task the machine is working stops the run, and the machine lets go of it", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await wired(t, async () => {
    started();
    await held;
  });
  const made = await ask(f, { prompt: "Take your time" });
  await running;
  await f.until("the task to be running", () => task(f, made.id).status === "running");
  const paused = await f.call("max", "POST", `/v1/tasks/${made.id}/control`, { action: "pause" });
  assert.equal(paused.status, 200);
  await f.until("the session to be stopped", () => f.opencode.aborted.length > 0);
  await f.until(
    "the machine to let go of its copy",
    async () => (await f.db.scan("tasks")).length === 0,
  );
  assert.equal(task(f, made.id).status, "paused");
  assert.equal(task(f, made.id).leaseId, null);
  release();
});

test("a person adds a note while the agent works: the agent is told, and the room knows it was read", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await wired(t, async (turn) => {
    await held;
    turn.say("TASK_COMPLETE: done with the note in mind");
  });
  const made = await ask(f, { prompt: "Draft the update" });
  await f.until("the task to be running", () => task(f, made.id).status === "running");
  const noted = await f.call("max", "POST", `/v1/tasks/${made.id}/notes`, {
    text: "Keep it short",
  });
  assert.equal(noted.status, 201);
  await f.until("the machine to have the note", async () => {
    const copy = (await f.db.scan<AgentTask>("tasks"))[0]?.value;
    return Boolean(copy?.notes?.some((n) => n.text === "Keep it short"));
  });
  release();
  await f.until("the task to come back", () => task(f, made.id).status === "in_review");
});
