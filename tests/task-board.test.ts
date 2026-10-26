import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask, AgentWorkspace, Project } from "../packages/domain/src/agent.ts";
import { taskColumn } from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown, method?: string) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined && method === undefined
      ? {}
      : {
          method: method ?? "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
  });
async function read<T>(path: string, body?: unknown, status = 200, method?: string): Promise<T> {
  const response = await request(path, body, method);
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-task-board-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("manual issues create without a prompt and default sanely", async () => {
  const issue = await read<AgentTask>("/tasks", { title: "Buy milk", kind: "manual" }, 201);
  assert.equal(issue.kind, "manual");
  assert.equal(issue.status, "queued");
  assert.equal(issue.priority, "medium");
  assert.deepEqual(issue.blockedBy, []);
  assert.deepEqual(issue.labels, []);
  assert.deepEqual(issue.plan, []);
});

test("agent-executed tasks still require a prompt", async () => {
  await read("/tasks", { title: "No prompt", kind: "agent" }, 422);
});

test("manual tasks move freely across the board", async () => {
  const issue = await read<AgentTask>("/tasks", { title: "Move me", kind: "manual" }, 201);
  const running = await read<AgentTask>(`/tasks/${issue.id}`, { status: "running" }, 200, "PATCH");
  assert.equal(running.status, "running");
  const failed = await read<AgentTask>(`/tasks/${issue.id}`, { status: "failed" }, 200, "PATCH");
  assert.equal(failed.status, "failed");
  assert.equal(taskColumn(failed.status), "failed");
  const done = await read<AgentTask>(`/tasks/${issue.id}`, { status: "succeeded" }, 200, "PATCH");
  assert.equal(done.status, "succeeded");
  assert.equal(taskColumn(done.status), "done");
});

test("worker tasks cannot be completed or run directly", async () => {
  const task = await read<AgentTask>(
    "/tasks",
    { title: "Worker job", prompt: "do work", kind: "agent" },
    201,
  );
  await read(`/tasks/${task.id}`, { status: "succeeded" }, 422, "PATCH");
  await read(`/tasks/${task.id}`, { status: "running" }, 422, "PATCH");
  const paused = await read<AgentTask>(`/tasks/${task.id}`, { status: "paused" }, 200, "PATCH");
  assert.equal(paused.status, "paused");
  const cancelled = await read<AgentTask>(
    `/tasks/${task.id}`,
    { status: "cancelled" },
    200,
    "PATCH",
  );
  assert.equal(cancelled.status, "cancelled");
});

test("terminal tasks can be reopened", async () => {
  const issue = await read<AgentTask>("/tasks", { title: "Reopen me", kind: "manual" }, 201);
  await read(`/tasks/${issue.id}`, { status: "succeeded" }, 200, "PATCH");
  const reopened = await read<AgentTask>(`/tasks/${issue.id}`, { status: "running" }, 200, "PATCH");
  assert.equal(reopened.status, "running");
  const retried = await read<AgentTask>(
    "/tasks",
    { title: "Worker rerun", prompt: "work", kind: "agent" },
    201,
  );
  await read(`/tasks/${retried.id}`, { status: "cancelled" }, 200, "PATCH");
  const requeued = await read<AgentTask>(
    `/tasks/${retried.id}`,
    { status: "queued" },
    200,
    "PATCH",
  );
  assert.equal(requeued.status, "queued");
});

test("dependencies validate existence, self-reference, and cycles", async () => {
  const a = await read<AgentTask>("/tasks", { title: "A", kind: "manual" }, 201);
  const b = await read<AgentTask>("/tasks", { title: "B", kind: "manual" }, 201);
  await read(`/tasks/${b.id}`, { blockedBy: [a.id] }, 200, "PATCH");
  await read(`/tasks/${b.id}`, { blockedBy: [b.id] }, 422, "PATCH");
  await read(`/tasks/${b.id}`, { blockedBy: ["nope"] }, 404, "PATCH");
  await read(`/tasks/${a.id}`, { blockedBy: [b.id] }, 422, "PATCH");
});

test("dates validate ordering", async () => {
  await read(
    "/tasks",
    { title: "Bad dates", kind: "manual", startAt: "2026-10-05", dueAt: "2026-10-01" },
    422,
  );
  const issue = await read<AgentTask>(
    "/tasks",
    { title: "Dated", kind: "manual", startAt: "2026-10-01", dueAt: "2026-10-05" },
    201,
  );
  assert.equal(issue.startAt, "2026-10-01");
  assert.equal(issue.dueAt, "2026-10-05");
  await read(`/tasks/${issue.id}`, { dueAt: "2026-09-01" }, 422, "PATCH");
});

test("delete removes the task and cleans dependencies", async () => {
  const a = await read<AgentTask>("/tasks", { title: "Gone", kind: "manual" }, 201);
  const b = await read<AgentTask>("/tasks", { title: "Depends", kind: "manual" }, 201);
  await read(`/tasks/${b.id}`, { blockedBy: [a.id] }, 200, "PATCH");
  const deleted = await read<{ deleted: string }>(`/tasks/${a.id}`, undefined, 200, "DELETE");
  assert.equal(deleted.deleted, a.id);
  const after = await read<{ task: AgentTask }>(`/tasks/${b.id}`, undefined, 200, "GET");
  assert.deepEqual(after.task.blockedBy, []);
  await read(`/tasks/${a.id}`, undefined, 404, "GET");
});

test("the worker never claims manual tasks", async () => {
  const wdb = await createStore({ dataDir: join(directory, "wdb") });
  try {
    const manual: AgentTask = {
      id: "m-1",
      title: "Human job",
      prompt: "",
      kind: "manual",
      status: "queued",
      priority: "medium",
      blockedBy: [],
      labels: [],
      plan: [],
      evidence: [],
      input: {},
      state: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    const agent: AgentTask = {
      ...manual,
      id: "a-1",
      kind: "agent",
      prompt: "work",
      title: "Agent job",
    };
    await wdb.put("owner", "tasks", manual);
    await wdb.put("owner", "tasks", agent);
    const claimed: string[] = [];
    await new TaskWorker(wdb, async (_owner, task) => {
      claimed.push(task.id);
      return { status: "succeeded" as const };
    }).tick();
    assert.deepEqual(claimed, ["a-1"]);
  } finally {
    await wdb.close();
  }
});

test("projects group tasks and survive deletion", async () => {
  const project = await read<Project>("/projects", { name: "Website" }, 201);
  assert.equal(project.name, "Website");
  const issue = await read<AgentTask>(
    "/tasks",
    { title: "In project", kind: "manual", projectId: project.id },
    201,
  );
  assert.equal(issue.projectId, project.id);
  // Work that names no project is in General, which is always there.
  const loose = await read<AgentTask>("/tasks", { title: "No project", kind: "manual" }, 201);
  assert.equal(loose.projectId, "general");
  await read("/tasks", { title: "Bad project", kind: "manual", projectId: "nope" }, 404);
  const snapshot = await read<AgentWorkspace>("", undefined, 200, "GET");
  assert.ok(snapshot.projects.some((p) => p.id === project.id));
  const renamed = await read<Project>(
    `/projects/${project.id}`,
    { name: "Website v2" },
    200,
    "PATCH",
  );
  assert.equal(renamed.name, "Website v2");
  const moved = await read<AgentTask>(`/tasks/${issue.id}`, { projectId: "general" }, 200, "PATCH");
  assert.equal(moved.projectId, "general");
  // A task is moved between projects, never out of them.
  const out = await request(`/tasks/${issue.id}`, { projectId: null }, "PATCH");
  assert.ok(out.status >= 400 && out.status < 500, String(out.status));
  // General cannot be deleted, nor made less than open.
  await read("/projects/general", undefined, 422, "DELETE");
  await read("/projects/general", { access: "private" }, 422, "PATCH");
  await read(`/tasks/${issue.id}`, { projectId: "nope" }, 404, "PATCH");
  // Deleting a project keeps its tasks, moved to General.
  const doomed = await read<Project>("/projects", { name: "Doomed" }, 201);
  const member = await read<AgentTask>(
    "/tasks",
    { title: "Member", kind: "manual", projectId: doomed.id },
    201,
  );
  const deleted = await read<{ deleted: string }>(
    `/projects/${doomed.id}`,
    undefined,
    200,
    "DELETE",
  );
  assert.equal(deleted.deleted, doomed.id);
  const after = await read<{ task: AgentTask }>(`/tasks/${member.id}`, undefined, 200, "GET");
  assert.equal(after.task.projectId, "general");
  await read(`/projects/${doomed.id}`, { name: "x" }, 404, "PATCH");
});

test("assigning a manual issue to the agent queues it with channel context", async () => {
  // Seed a shared channel transcript the issue's channel points at.
  await db.put("shared", "channels", { id: "general", name: "General" });
  await db.put("shared", "conversations", {
    id: "channel:general",
    messages: [
      { id: "c1", role: "user", name: "Alice", content: "We should launch Tuesday" },
      { id: "c2", role: "user", name: "Bob", content: "Agreed, I'll draft the notes" },
    ],
  });
  const issue = await read<AgentTask>(
    "/tasks",
    {
      title: "Prep launch",
      kind: "manual",
      prompt: "Draft the announcement",
      channelId: "general",
    },
    201,
  );
  assert.equal(issue.kind, "manual");

  const assigned = await read<AgentTask>(`/tasks/${issue.id}`, { assignee: "agent" }, 200, "PATCH");
  assert.equal(assigned.kind, "agent");
  assert.equal(assigned.status, "queued");
  assert.equal(assigned.assignee, "agent");
  // The description stays as written. The channel discussion is a snapshot taken at hand-off,
  // and each run's brief is built from both.
  assert.equal(assigned.prompt, "Draft the announcement");
  const discussion = assigned.input.discussion as { channel: string; lines: string };
  assert.equal(discussion.channel, "General");
  assert.ok(discussion.lines.includes("Alice: We should launch Tuesday"));
  assert.ok(discussion.lines.includes("Bob: Agreed"));

  // Unassigning restores the manual issue with its description, and drops the snapshot.
  const unassigned = await read<AgentTask>(`/tasks/${issue.id}`, { assignee: null }, 200, "PATCH");
  assert.equal(unassigned.kind, "manual");
  assert.equal(unassigned.assignee ?? null, null);
  assert.equal(unassigned.prompt, "Draft the announcement");
  assert.equal(unassigned.input.discussion, undefined);
});

test("the person decides whether the agent gets the channel discussion", async () => {
  await db.put("shared", "channels", { id: "ops", name: "Ops" });
  await db.put("shared", "conversations", {
    id: "channel:ops",
    messages: [{ id: "c1", role: "user", name: "Alice", content: "Ship it Friday" }],
  });
  const issue = await read<AgentTask>(
    "/tasks",
    { title: "Ship", kind: "manual", channelId: "ops" },
    201,
  );
  const assigned = await read<AgentTask>(
    `/tasks/${issue.id}`,
    { assignee: "agent", channelContext: false },
    200,
    "PATCH",
  );
  assert.equal(assigned.kind, "agent");
  assert.equal(assigned.input.discussion, undefined);
});

test("a manual issue's description can be edited and cleared", async () => {
  const issue = await read<AgentTask>(
    "/tasks",
    { title: "Describe me", kind: "manual", prompt: "First draft" },
    201,
  );
  const edited = await read<AgentTask>(
    `/tasks/${issue.id}`,
    { prompt: "Second draft" },
    200,
    "PATCH",
  );
  assert.equal(edited.prompt, "Second draft");
  const cleared = await read<AgentTask>(`/tasks/${issue.id}`, { prompt: "" }, 200, "PATCH");
  assert.equal(cleared.prompt, "");
  // An agent task's instructions can be changed but not emptied.
  const job = await read<AgentTask>("/tasks", { title: "Job", prompt: "do it" }, 201);
  await read(`/tasks/${job.id}`, { prompt: "" }, 422, "PATCH");
});

test("an issue handed over before descriptions were kept as written is restored from its saved notes", async () => {
  const issue = await read<AgentTask>(
    "/tasks",
    { title: "Old hand-off", kind: "manual", prompt: "Original" },
    201,
  );
  // The earlier scheme replaced the prompt with a built one and set the original aside.
  await db.compareAndSwap(
    "owner",
    "tasks",
    issue.id,
    {},
    {
      kind: "agent",
      assignee: "agent",
      prompt: "Old hand-off\n\nNotes:\nOriginal\n\nCarry out the task above.",
      input: { manualNotes: "Original" },
    },
  );
  const restored = await read<AgentTask>(`/tasks/${issue.id}`, { assignee: null }, 200, "PATCH");
  assert.equal(restored.kind, "manual");
  assert.equal(restored.prompt, "Original");
  assert.equal(restored.input.manualNotes, undefined);
});

test("assigning a non-manual task to the agent is rejected", async () => {
  const task = await read<AgentTask>("/tasks", { title: "Agent job", prompt: "do it" }, 201);
  assert.equal(task.kind, "agent");
  await read(`/tasks/${task.id}`, { assignee: "agent" }, 422, "PATCH");
});

test("assignee cannot change together with status", async () => {
  const issue = await read<AgentTask>("/tasks", { title: "Combo", kind: "manual" }, 201);
  await read(`/tasks/${issue.id}`, { assignee: "agent", status: "paused" }, 422, "PATCH");
});
