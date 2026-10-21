import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { OpencodeTaskRuntime } from "../apps/server/src/opencode/index.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";
import { opencodeStandIn } from "./helpers/opencode.ts";

/**
 * The task executor, with a stand-in for the OpenCode agent: which tools it is offered, what it is
 * told, and what Hive does with what it calls. The agent's side is played by the test.
 */
async function executor(t: TestContext, name: string, adjust: Partial<Config> = {}, store?: Store) {
  const directory = await mkdtemp(join(tmpdir(), `hive-${name}-`));
  const db = store ?? (await createStore());
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...adjust,
  });
  const standIn = opencodeStandIn({
    dataDir: adjust.dataDir ?? directory,
    model: "openai/fixture",
  });
  server.agent.opencodeRuntime = standIn.runtime as unknown as OpencodeTaskRuntime;
  t.after(async () => {
    await server.agent.stop();
    if (!store) await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, server, standIn, directory };
}

const lastPrompt = (prompts: { parts: { text: string }[] }[]) =>
  prompts[0].parts.map((part) => part.text).join("\n");

test("the executor offers Hive's tools, runs what the agent calls, and persists the outcome it reaches", async (t) => {
  const { db, server, standIn } = await executor(t, "executor");
  let offered: string[] = [];
  standIn.agent(async ({ call, tools, idle }) => {
    offered = tools;
    await call("read_workspace", { section: "files" });
    await call("save_artifact", {
      kind: "plan",
      title: "Weekend plan",
      summary: "A walk and time to read",
      data: { steps: ["Take a walk", "Read for 30 minutes"] },
    });
    await call("finish_task", { summary: "Saved your weekend plan with two steps." });
    idle();
  });
  const task = await server.agent.createTask("owner", {
    prompt: "Make a weekend plan",
    kind: "plan",
  });
  await server.agent.worker.tick();
  const result = await server.agent.detail("owner", task.id);
  // The agent hands its work in; it never closes the task itself.
  assert.equal(result.task.status, "in_review", result.task.error ?? result.task.question);
  assert.equal(result.task.state.unconfirmed, false);
  assert.equal(result.task.result, "Saved your weekend plan with two steps.");
  assert.ok(result.artifacts.some((a) => a.title === "Weekend plan"));
  assert.ok(result.events.some((event) => event.title === "Read the authorized workspace sources"));
  // A person marks it done.
  assert.equal((await server.agent.accept("owner", task.id)).status, "succeeded");
  // The agent is told the task, and is offered the worker's tools but no way to approve its own work.
  assert.match(lastPrompt(standIn.prompts), /Make a weekend plan/);
  for (const name of ["prepare_email", "prepare_event", "ask_user", "finish_task"])
    assert.ok(offered.includes(name), name);
  // The agent keeps its own plan, so there is no tool for Hive's.
  for (const name of ["set_plan", "run_computer_command", "approve"])
    assert.ok(!offered.includes(name), name);

  // A calendar event is prepared for review, and the task waits for a person to approve it.
  standIn.reset();
  standIn.agent(async ({ call, idle }) => {
    await call("prepare_event", {
      title: "Sample walk",
      start: "2026-10-10T10:00:00-07:00",
      end: "2026-10-10T11:00:00-07:00",
    });
    idle();
  });
  const appointment = await server.agent.createTask("owner", {
    prompt: "Prepare a sample walk on my calendar",
  });
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("owner", appointment.id);
  assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
  assert.ok(pending.actionId);
  const proposal = await db.get<ActionProposal>("owner", "actions", pending.actionId);
  assert.ok(proposal);
  await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
  // Approved, it runs again with the receipt in the saved state, and hands its work in.
  standIn.reset();
  standIn.agent(async ({ call, idle }) => {
    await call("finish_task", { summary: "The reviewed sample event is on the calendar." });
    idle();
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("owner", appointment.id);
  assert.equal(finished.status, "in_review", finished.error ?? finished.question);
  assert.equal(finished.actionId, null);
  assert.match(lastPrompt(standIn.prompts), /approvalResult/);
  assert.equal(
    (await db.list<ActionProposal>("owner", "actions")).filter((a) => a.taskId === appointment.id)
      .length,
    1,
  );
});

test("an agent that stops without calling finish_task is handed in as unconfirmed, with what it said", async (t) => {
  const { server, standIn } = await executor(t, "executor-text");
  standIn.agent(({ say, idle }) => {
    say("Find cool stuff on Hacker News");
    idle();
  });
  const task = await server.agent.createTask("owner", { prompt: "Plan my week" });
  await server.agent.worker.tick();
  const result = await server.agent.detail("owner", task.id);
  // The run ended without saying it was finished: a person is asked to decide, not told it is done.
  assert.equal(result.task.status, "in_review");
  assert.equal(result.task.state.unconfirmed, true);
  assert.match(String(result.task.result), /Find cool stuff on Hacker News/);
  assert.match(String(result.task.state.lastUpdate), /Find cool stuff on Hacker News/);
  assert.ok(
    result.events.some(
      (event) =>
        event.title === "Agent update" && /Find cool stuff on Hacker News/.test(event.detail),
    ),
    "the reply is recorded in the task timeline",
  );
});

test("a task needs a model before an agent is started for it", async (t) => {
  const { server, standIn } = await executor(t, "executor-unconfigured", { model: undefined });
  standIn.agent(() => assert.fail("no agent should be started"));
  const task = await server.agent.createTask("owner", { prompt: "Plan my week" });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask("owner", task.id);
  assert.equal(waiting.status, "waiting_input");
  assert.match(String(waiting.question), /model is required/i);
  assert.equal(standIn.prompts.length, 0);
});

test("replaying a completed prepared action returns its receipt without reopening approval", async (t) => {
  const { db, server, standIn } = await executor(t, "executor-replay");
  const draft = {
    title: "Sample walk",
    start: "2026-10-10T10:00:00-07:00",
    end: "2026-10-10T11:00:00-07:00",
  };
  standIn.agent(async ({ call, idle }) => {
    await call("prepare_event", draft);
    idle();
  });
  const task = await server.agent.createTask("replay-owner", {
    prompt: "Put a sample walk on my calendar",
  });
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("replay-owner", task.id);
  assert.equal(pending.status, "waiting_approval");
  assert.ok(pending.actionId);
  const proposal = await db.get<ActionProposal>("replay-owner", "actions", pending.actionId);
  assert.ok(proposal);
  const completed = await server.actions.decide(
    "replay-owner",
    proposal.id,
    proposal.hash,
    "approve",
  );
  assert.equal(completed.status, "succeeded");

  // The agent asks for the same event again, and is given the receipt of the one that was approved.
  standIn.reset();
  let replayed: unknown;
  standIn.agent(async ({ call, idle }) => {
    replayed = await call("prepare_event", draft);
    await call("finish_task", { summary: "The reviewed event is already complete." });
    idle();
  });
  await server.agent.worker.tick();

  const finished = await server.agent.getTask("replay-owner", task.id);
  assert.equal(finished.status, "in_review", finished.error ?? finished.question);
  assert.equal(finished.actionId, null);
  assert.equal(finished.state.approvalResult, completed.result);
  assert.deepEqual(replayed, {
    status: "succeeded",
    actionId: proposal.id,
    result: completed.result,
  });
  const actions = (await db.list<ActionProposal>("replay-owner", "actions")).filter(
    (action) => action.taskId === task.id,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "succeeded");
  assert.ok(lastPrompt(standIn.prompts).includes(String(completed.result)));
});

test("browser reads keep observation identity distinct while reusing one session", async (t) => {
  let currentUrl = "https://example.com/one";
  const sessionIds = new Set<string>();
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      const id = String(body.id);
      currentUrl = String(body.url);
      sessionIds.add(id);
      return {
        data: {
          id,
          title: currentUrl,
          url: currentUrl,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/read")) {
      return {
        data: {
          url: currentUrl,
          title: currentUrl.endsWith("/one") ? "Source one" : "Source two",
          text: `Evidence from ${currentUrl}`,
          truncated: false,
        },
      };
    }
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const { server, standIn } = await executor(
    t,
    "executor-browser",
    { ...browser.config, model: "openai/fixture" },
    browser.db,
  );
  standIn.agent(async ({ call, idle }) => {
    await call("read_web", { url: "https://example.com/one" });
    await call("read_web", { url: "https://example.com/two" });
    await call("finish_task", { summary: "Compared both public sources." });
    idle();
  });

  const task = await server.agent.createTask("owner", {
    prompt: "Read both public sources and compare them.",
  });
  await server.agent.worker.tick();

  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "in_review", saved.error ?? saved.question);
  const webEvidence = saved.evidence.filter((item) => item.kind === "web");
  assert.equal(webEvidence.length, 2);
  assert.deepEqual(
    webEvidence.map((item) => item.url),
    ["https://example.com/one", "https://example.com/two"],
  );
  assert.equal(sessionIds.size, 1, "both reads should reuse the same browser session");
  assert.equal(new Set(webEvidence.map((item) => item.id)).size, 2);
});

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("it did not happen in time");
};
const todos = (...items: [string, string][]) =>
  items.map(([content, status]) => ({ content, status, priority: "medium" }));

test("a task's plan is the todo list its agent keeps, shown as the agent writes it", async (t) => {
  const { server, standIn } = await executor(t, "executor-plan");
  let id = "";
  const plan = async () =>
    (await server.agent.getTask("owner", id)).plan.map((step) => `${step.title}:${step.status}`);
  const seen: string[][] = [];
  standIn.agent(async ({ emit, call, idle }) => {
    emit({
      type: "todo.updated",
      properties: {
        sessionID: "ses-1",
        todos: todos(
          ["Read the brief", "in_progress"],
          ["Draft the reply", "pending"],
          ["Tidy up", "pending"],
        ),
      },
    });
    await until(async () => (await plan()).length === 3);
    seen.push(await plan());
    emit({
      type: "todo.updated",
      properties: {
        sessionID: "ses-1",
        todos: todos(
          ["Read the brief", "completed"],
          ["Draft the reply", "in_progress"],
          ["Tidy up", "cancelled"],
        ),
      },
    });
    await until(async () => (await plan()).length === 2);
    seen.push(await plan());
    await call("finish_task", { summary: "Drafted the reply." });
    idle();
  });
  const task = await server.agent.createTask("owner", { prompt: "Reply to the brief" });
  id = task.id;
  // Nothing of Hive's own: a task has no steps until its agent writes some.
  assert.deepEqual(await plan(), []);
  await server.agent.worker.tick();
  assert.deepEqual(seen, [
    ["Read the brief:running", "Draft the reply:pending", "Tidy up:pending"],
    ["Read the brief:succeeded", "Draft the reply:running"],
  ]);
  const finished = await server.agent.getTask("owner", id);
  assert.equal(finished.status, "in_review", finished.error ?? finished.question);
  // Handed in, what the agent listed is done. The item it dropped is still not on the plan.
  assert.deepEqual(await plan(), ["Read the brief:succeeded", "Draft the reply:succeeded"]);
});

test("a run starts from the list its session already holds, so an old plan does not outlive it", async (t) => {
  const { db, server, standIn } = await executor(t, "executor-plan-start");
  const first = await server.agent.createTask("owner", { prompt: "Reply to the brief" });
  // Steps written for this task before the agent kept its own: nothing ever filled them in.
  await db.put("owner", "tasks", {
    ...first,
    plan: [{ id: "0", title: "Understand the outcome", status: "pending" }],
  });
  standIn.agent(({ say, idle }) => {
    say("Looking into it.");
    idle();
  });
  await server.agent.worker.tick();
  // A new session has no list, and the old steps are gone with it.
  assert.deepEqual((await server.agent.getTask("owner", first.id)).plan, []);

  // A session that is picked up again already has its list, which is the plan from the start.
  standIn.setTodos(todos(["Read the brief", "completed"], ["Draft the reply", "in_progress"]));
  const second = await server.agent.createTask("owner", { prompt: "Reply to the other brief" });
  await server.agent.worker.tick();
  assert.deepEqual(
    (await server.agent.getTask("owner", second.id)).plan.map((s) => `${s.title}:${s.status}`),
    ["Read the brief:succeeded", "Draft the reply:running"],
  );
});
