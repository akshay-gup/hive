import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { channelWorkspaceDir, diskOwnerForChannel } from "../apps/server/src/engine/threads.ts";
import { conversationTools } from "../apps/server/src/engine/tools.ts";
import type {
  AgentNotification,
  AgentTask,
  AgentWorkspace,
  Goal,
  RunEvent,
} from "../packages/domain/src/agent.ts";
import { taskBriefLimits } from "../packages/domain/src/agent.ts";
import type { Artifact } from "../packages/domain/src/index.ts";

/**
 * Review and the task brief. The agent hands its work in and never closes a task; a person marks it
 * done or sends it back. Notes and files are what the agent is told besides the task itself.
 */

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const person = "local-user";

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
const upload = (taskId: string, name: string, bytes: Uint8Array, type = "text/plain") => {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type }));
  return server.app.request(`/api/agent/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
};
const text = (value: string) => new TextEncoder().encode(value);
const force = (id: string, patch: Record<string, unknown>) =>
  db.compareAndSwap("shared", "tasks", id, {}, patch);
const create = (body: Record<string, unknown> = {}) =>
  read<AgentTask>("/tasks", { title: "A task", prompt: "Do the thing", ...body }, 201);
/** An agent task the agent has handed in. */
async function inReview(body: Record<string, unknown> = {}) {
  const task = await create(body);
  await force(task.id, { status: "in_review", result: "Here is what I did.", attempts: 1 });
  return task;
}
async function pdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage();
  return document.save();
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-task-review-"));
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
  token = (await session.json()).token;
  await db.put("system", "users", { id: person, name: "Pat" });
  await db.put("system", "users", { id: "alice", name: "Alice" });
  await db.put("system", "users", { id: "bob", name: "Bob" });
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// ---- Review: the agent never closes a task -------------------------------------------------

test("a person marks handed-in work done, and only then does it count as done", async () => {
  const goal = await server.agent.createGoal(person, { title: "Offsite", description: "Plan it" });
  const task = await inReview({ goalId: goal.id });
  const detail = await read<{ task: AgentTask }>(`/tasks/${task.id}`);
  assert.equal(detail.task.status, "in_review");
  assert.equal((await db.get<Goal>(person, "goals", goal.id))?.milestones.length, 0);

  const done = await read<AgentTask>(`/tasks/${task.id}/accept`, {});
  assert.equal(done.status, "succeeded");
  assert.equal(done.result, "Here is what I did.");
  const events = (await server.agent.detail(person, task.id)).events;
  const marked = events.find((event: RunEvent) => event.title === "Marked done");
  assert.equal(marked?.detail, "By Pat");

  // The outcome is published as it is accepted: a notification and the goal's milestone.
  const workspace = await read<AgentWorkspace>("");
  assert.ok(workspace.notifications.some((n: AgentNotification) => n.taskId === task.id));
  const saved = await db.get<Goal>(person, "goals", goal.id);
  assert.deepEqual(
    saved?.milestones.map((m) => [m.id, m.done]),
    [[task.id, true]],
  );
  // Accepting twice is refused.
  await read(`/tasks/${task.id}/accept`, {}, 409);
});

test("only work that is ready for review can be marked done", async () => {
  for (const status of ["queued", "running", "waiting_input", "failed", "paused", "cancelled"]) {
    const task = await create();
    await force(task.id, { status });
    const refused = await read<{ error: string }>(`/tasks/${task.id}/accept`, {}, 409);
    assert.match(refused.error, /ready for review/, status);
    assert.equal((await server.agent.getTask(person, task.id)).status, status);
  }
  await read("/tasks/nope/accept", {}, 404);
});

test("agent work cannot be set to done by hand either, only accepted", async () => {
  const task = await inReview();
  const rejected = await read<{ error: string }>(
    `/tasks/${task.id}`,
    { status: "succeeded" },
    422,
    "PATCH",
  );
  assert.match(rejected.error, /marked done by a person/);
  assert.equal((await server.agent.getTask(person, task.id)).status, "in_review");
});

test("the agent itself can never mark a task done", async () => {
  const task = await inReview();
  await assert.rejects(
    server.agent.updateTask(person, task.id, { status: "succeeded" }, "agent"),
    /Only a person can mark a task done/,
  );
  const manual = await create({ kind: "manual", prompt: undefined });
  await assert.rejects(
    server.agent.updateTask(person, manual.id, { status: "succeeded" }, "agent"),
    /Only a person can mark a task done/,
  );
  // A person still can: manual issues move freely.
  const moved = await server.agent.updateTask(person, manual.id, { status: "succeeded" });
  assert.equal(moved.status, "succeeded");

  // The tool the agent is given does not offer it, and refuses it if asked anyway.
  const tools = conversationTools(
    server.agent,
    person,
    {
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    { signal: new AbortController().signal, requestKey: "test" },
  );
  const update = tools.find((tool) => tool.name === "update_task");
  assert.ok(update);
  const parameters = update.parameters as { safeParse: (value: unknown) => { success: boolean } };
  assert.equal(parameters.safeParse({ taskId: task.id, status: "succeeded" }).success, false);
  assert.equal(parameters.safeParse({ taskId: task.id, status: "paused" }).success, true);
  await assert.rejects(
    (update.execute as (args: unknown) => Promise<unknown>)({
      taskId: task.id,
      status: "succeeded",
    }),
    /Only a person can mark a task done/,
  );
  assert.equal((await server.agent.getTask(person, task.id)).status, "in_review");
});

test("what the agent reads about a task includes its notes and file names, but no download links", async () => {
  const task = await create();
  await server.agent.addNote(person, task.id, { text: "Mind the budget" });
  await server.agent.addAttachment(person, task.id, { name: "budget.csv", bytes: text("a,b\n") });
  const tools = conversationTools(
    server.agent,
    person,
    {
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    { signal: new AbortController().signal, requestKey: "test" },
  );
  const status = tools.find((tool) => tool.name === "agent_status");
  assert.ok(status);
  const seen = (
    await (status.execute as (args: unknown) => Promise<AgentWorkspace>)({})
  ).tasks.find((t) => t.id === task.id);
  assert.equal(seen?.notes?.[0].text, "Mind the budget");
  assert.equal(seen?.attachments?.[0].name, "budget.csv");
  assert.equal(seen?.attachments?.[0].url, undefined);
  assert.ok(!JSON.stringify(seen).includes("signature="));
  // People still get their links.
  const snapshot = (await server.agent.snapshot(person)).tasks.find((t) => t.id === task.id);
  assert.ok(snapshot?.attachments?.[0].url?.includes("signature="));
});

test("handed-in work is announced once, as ready for review", async () => {
  const task = await inReview({ title: "Venue shortlist" });
  const publish = (
    server.agent as unknown as { publishOutcome: (owner: string, task: AgentTask) => Promise<void> }
  ).publishOutcome.bind(server.agent);
  await publish(person, task);
  await publish(person, task);
  const notices = (await server.agent.snapshot(person)).notifications.filter(
    (n) => n.taskId === task.id,
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "Ready for your review");
  assert.equal(notices[0].body, "Venue shortlist");
});

test("work in review has nothing to pause, can be cancelled, and stays in review when moved", async () => {
  const task = await inReview();
  assert.equal((await server.agent.control(person, task.id, "pause")).status, "in_review");
  const moved = await server.agent.delegateTask(person, task.id, "orchestrator");
  assert.equal(moved.status, "in_review");
  assert.equal((await server.agent.control(person, task.id, "cancel")).status, "cancelled");
});

test("taking work in review back from the agent returns it to the to-do column, not done", async () => {
  const issue = await create({ kind: "manual", prompt: "Draft it" });
  await read(`/tasks/${issue.id}`, { assignee: "agent" }, 200, "PATCH");
  await force(issue.id, { status: "in_review", result: "Drafted." });
  const back = await read<AgentTask>(`/tasks/${issue.id}`, { assignee: null }, 200, "PATCH");
  assert.equal(back.kind, "manual");
  assert.equal(back.status, "queued");
});

test("the worker never picks up work in review", async () => {
  const task = await inReview();
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(person, task.id)).status, "in_review");
});

// ---- Notes -----------------------------------------------------------------------------------

test("a note records who wrote it and is not yet read by the agent", async () => {
  const task = await create();
  const noted = await read<AgentTask>(
    `/tasks/${task.id}/notes`,
    { text: "  Budget is $5k  " },
    201,
  );
  assert.equal(noted.notes?.length, 1);
  const [note] = noted.notes ?? [];
  assert.equal(note.text, "Budget is $5k");
  assert.equal(note.kind, "note");
  assert.equal(note.delivered, false);
  assert.equal(note.createdBy, person);
  assert.equal(note.createdByName, "Pat");
  assert.equal(note.mine, true);
  assert.equal(noted.status, "queued", "a plain note does not change what the task is doing");

  // Others see it as theirs-not-mine, and it travels with the workspace snapshot.
  await server.agent.addNote("alice", task.id, { text: "Near the station" });
  const snapshot = (await read<AgentWorkspace>("")).tasks.find((t) => t.id === task.id);
  assert.deepEqual(
    snapshot?.notes?.map((n) => [n.createdByName, n.mine]),
    [
      ["Pat", true],
      ["Alice", false],
    ],
  );
  const events = (await server.agent.detail(person, task.id)).events;
  assert.ok(events.some((e) => e.kind === "instruction" && e.title === "Pat added a note"));
});

test("notes are validated and limited", async () => {
  const task = await create();
  await read(`/tasks/${task.id}/notes`, { text: "   " }, 422);
  await read(`/tasks/${task.id}/notes`, { text: "x".repeat(taskBriefLimits.noteChars + 1) }, 422);
  await read("/tasks/nope/notes", { text: "hi" }, 404);
  for (let i = 0; i < taskBriefLimits.notes; i++)
    await server.agent.addNote(person, task.id, { text: `note ${i}` });
  const full = await read<{ error: string }>(`/tasks/${task.id}/notes`, { text: "one more" }, 409);
  assert.match(full.error, /50 notes/);
});

test("changes requested in review go back to the agent with the note, in one step", async () => {
  const task = await inReview();
  const back = await read<AgentTask>(
    `/tasks/${task.id}/notes`,
    { text: "Cheaper, please", run: true },
    201,
  );
  assert.equal(back.status, "queued");
  assert.equal(back.leaseId, null);
  assert.equal(back.result, "Here is what I did.", "the previous result stays for the next run");
  assert.deepEqual(
    back.notes?.map((n) => [n.text, n.kind, n.delivered]),
    [["Cheaper, please", "feedback", false]],
  );
  const events = (await server.agent.detail(person, task.id)).events;
  assert.ok(events.some((e) => e.title === "Pat asked for changes"));
});

test("a note with run reopens failed, cancelled and finished tasks, and answers a question", async () => {
  for (const [status, kind] of [
    ["failed", "note"],
    ["cancelled", "note"],
    ["succeeded", "note"],
    ["waiting_input", "answer"],
  ] as const) {
    const task = await create();
    await force(task.id, { status, error: "Boom", question: "Which day?" });
    const back = await read<AgentTask>(
      `/tasks/${task.id}/notes`,
      { text: "Try again with Thursday", run: true },
      201,
    );
    assert.equal(back.status, "queued", status);
    assert.equal(back.error, null, status);
    assert.equal(back.question, null, status);
    assert.equal(back.notes?.[0].kind, kind, status);
  }
});

test("a note with run leaves a task that is already moving alone", async () => {
  for (const status of ["running", "queued", "paused", "waiting_approval"]) {
    const task = await create();
    await force(task.id, { status, ...(status === "running" ? { leaseId: "lease" } : {}) });
    const same = await read<AgentTask>(`/tasks/${task.id}/notes`, { text: "FYI", run: true }, 201);
    assert.equal(same.status, status);
    assert.equal(same.notes?.length, 1);
  }
});

test("sending a task back after a failure takes the same care as a retry", async () => {
  await db.put("shared", "actions", { id: "denied-action", status: "denied" });
  const failed = await create();
  await force(failed.id, { status: "failed", actionId: "denied-action" });
  const refused = await read<{ error: string }>(
    `/tasks/${failed.id}/notes`,
    { text: "again", run: true },
    409,
  );
  assert.match(refused.error, /Check the reviewed action/);
  assert.equal(
    (await server.agent.getTask(person, failed.id)).notes,
    undefined,
    "no note was kept",
  );

  // A task that is simply waiting for its review is not disturbed by a note, whatever it holds.
  const waiting = await create();
  await force(waiting.id, { status: "waiting_approval", actionId: "denied-action" });
  const noted = await read<AgentTask>(
    `/tasks/${waiting.id}/notes`,
    { text: "FYI", run: true },
    201,
  );
  assert.equal(noted.status, "waiting_approval");
});

test("a note cannot start a run for a task that has no agent behind it", async () => {
  const issue = await create({ kind: "manual", prompt: undefined });
  const refused = await read<{ error: string }>(
    `/tasks/${issue.id}/notes`,
    { text: "go", run: true },
    422,
  );
  assert.match(refused.error, /Hand this task to the agent/);
  // But a person can still leave notes on an issue.
  assert.equal(
    (await read<AgentTask>(`/tasks/${issue.id}/notes`, { text: "Context" }, 201)).notes?.length,
    1,
  );
  const finance = await create({ kind: "finance", input: {} });
  await force(finance.id, { status: "succeeded" });
  const workflow = await read<{ error: string }>(
    `/tasks/${finance.id}/notes`,
    { text: "again", run: true },
    422,
  );
  assert.match(workflow.error, /does not take notes/);
});

test("answering a question adds the answer to the task's notes and queues it in one step", async () => {
  const task = await create();
  await force(task.id, { status: "waiting_input", question: "Which venue?" });
  const answered = await read<AgentTask>(`/tasks/${task.id}/input`, {
    answer: "The Hillside",
    fields: { venue: "Hillside" },
  });
  assert.equal(answered.status, "queued");
  assert.equal(answered.question, null);
  assert.deepEqual(answered.input.fields, { venue: "Hillside" });
  assert.equal(answered.state.answer, undefined, "answers are notes now, not a single saved value");
  assert.deepEqual(
    answered.notes?.map((n) => [n.text, n.kind]),
    [["The Hillside", "answer"]],
  );
  // A second answer cannot overwrite the first: the task is no longer waiting.
  await read(`/tasks/${task.id}/input`, { answer: "Another" }, 409);
});

test("only the author removes a note, and only before the agent has read it", async () => {
  const task = await create();
  const withNote = await server.agent.addNote("alice", task.id, { text: "Mine" });
  const note = withNote.notes?.[0];
  assert.ok(note);
  await assert.rejects(server.agent.removeNote("bob", task.id, note.id), /your own notes/);
  await assert.rejects(server.agent.removeNote("alice", task.id, "nope"), /Note not found/);

  await server.agent.markNotesDelivered("alice", task.id, [note.id]);
  await assert.rejects(
    server.agent.removeNote("alice", task.id, note.id),
    /already read this note/,
  );

  const second = await server.agent.addNote("alice", task.id, { text: "Second" });
  const removable = second.notes?.find((n) => n.text === "Second");
  assert.ok(removable);
  const after = await server.agent.removeNote("alice", task.id, removable.id);
  assert.deepEqual(
    after.notes?.map((n) => n.text),
    ["Mine"],
  );
});

test("notes added at the same moment are all kept", async () => {
  const task = await create();
  await Promise.all(
    Array.from({ length: 15 }, (_, i) => server.agent.addNote(person, task.id, { text: `n${i}` })),
  );
  assert.equal((await server.agent.getTask(person, task.id)).notes?.length, 15);
});

// ---- Files -------------------------------------------------------------------------------------

test("a text file attached to a task is stored privately and downloaded through a signed link", async () => {
  const task = await create();
  const response = await upload(task.id, "budget.csv", text("item,cost\nvenue,1000\n"), "text/csv");
  assert.equal(response.status, 201);
  const saved: AgentTask = await response.json();
  const [file] = saved.attachments ?? [];
  assert.equal(file.name, "budget.csv");
  assert.equal(file.mimeType, "text/csv");
  assert.equal(file.size, 21);
  assert.equal(file.mine, true);
  assert.equal(file.addedByName, "Pat");
  assert.ok(file.url?.includes("signature="));
  assert.equal(file.fileId, undefined, "only PDFs are also kept in Files");

  // The bytes are on disk away from any workspace.
  assert.ok(existsSync(join(directory, "task-files", task.id, file.id)));

  // The link works without the access key...
  const link = new URL(file.url ?? "");
  const download = await server.app.request(`${link.pathname}${link.search}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "item,cost\nvenue,1000\n");
  assert.equal(download.headers.get("content-type"), "text/csv");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename\*=/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-security-policy") ?? "", /sandbox/);

  // ...but only for that file: the signature does not carry over to another path or none at all.
  const other = await server.app.request(
    `/api/agent/tasks/${task.id}/attachments/other/content${link.search}`,
  );
  assert.equal(other.status, 403);
  const unsigned = await server.app.request(link.pathname);
  assert.equal(unsigned.status, 401);

  // The snapshot sends clients a fresh link, and the sheet shows who added it.
  const snapshot = (await read<AgentWorkspace>("")).tasks.find((t) => t.id === task.id);
  assert.ok(snapshot?.attachments?.[0].url);
});

test("only supported, genuine files are accepted", async () => {
  const task = await create();
  const refused = async (name: string, bytes: Uint8Array, status: number, pattern: RegExp) => {
    const response = await upload(task.id, name, bytes);
    assert.equal(response.status, status, name);
    assert.match(((await response.json()) as { error: string }).error, pattern, name);
  };
  await refused("run.exe", text("MZ"), 422, /Attach a PDF/);
  await refused("noext", text("hello"), 422, /Attach a PDF/);
  await refused("empty.txt", new Uint8Array(), 422, /empty/);
  await refused("fake.png", text("this is not a png"), 422, /not a real PNG/);
  await refused("fake.pdf", text("%PDF"), 422, /not a real PDF/);
  await refused("binary.txt", new Uint8Array([104, 105, 0, 1, 2]), 422, /not a real TXT/);
  await refused("latin1.md", new Uint8Array([0xff, 0xfe, 0xfd]), 422, /not a real MD/);
  await refused(
    "big.txt",
    new Uint8Array(taskBriefLimits.attachmentBytes + 1).fill(97),
    413,
    /10 MB or smaller/,
  );
  const missing = await server.app.request(`/api/agent/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new FormData(),
  });
  assert.equal(missing.status, 400);
  assert.equal((await server.agent.getTask(person, task.id)).attachments, undefined);

  // Real ones are fine, and the type comes from the file, not from what the browser claims.
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const accepted = await upload(task.id, "../../etc/Photo.PNG", png, "text/html");
  assert.equal(accepted.status, 201);
  const [file] = ((await accepted.json()) as AgentTask).attachments ?? [];
  assert.equal(
    file.name,
    "Photo.png",
    "the folder part of a name is dropped, the extension tidied",
  );
  assert.equal(file.mimeType, "image/png");
});

test("a task holds a limited number of files, and a limited total size", async () => {
  const task = await create();
  for (let i = 0; i < taskBriefLimits.attachments; i++)
    assert.equal((await upload(task.id, `f${i}.txt`, text(`file ${i}`))).status, 201);
  const full = await upload(task.id, "extra.txt", text("one too many"));
  assert.equal(full.status, 409);
  assert.match(((await full.json()) as { error: string }).error, /10 files/);

  const heavy = await create();
  const nine = new Uint8Array(9 * 1024 * 1024).fill(97);
  assert.equal((await upload(heavy.id, "a.txt", nine)).status, 201);
  assert.equal((await upload(heavy.id, "b.txt", nine)).status, 201);
  const over = await upload(heavy.id, "c.txt", nine);
  assert.equal(over.status, 413);
  assert.match(((await over.json()) as { error: string }).error, /25 MB/);
});

test("files arriving together cannot slip past the total size limit", async () => {
  const task = await create();
  const nine = new Uint8Array(9 * 1024 * 1024).fill(97);
  const results = await Promise.all(
    ["a", "b", "c", "d"].map((name) => upload(task.id, `${name}.txt`, nine)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 413, 413]);
  const saved = await server.agent.getTask(person, task.id);
  assert.equal(saved.attachments?.length, 2);
});

test("a PDF attached to a task is also kept in Files for the agent's PDF tools", async () => {
  const task = await create();
  const response = await upload(task.id, "permission-slip.pdf", await pdf(), "application/pdf");
  assert.equal(response.status, 201);
  const [file] = ((await response.json()) as AgentTask).attachments ?? [];
  assert.equal(file.mimeType, "application/pdf");
  assert.ok(file.fileId);
  const kept = await db.get<Artifact>(person, "files", file.fileId);
  assert.equal(kept?.name, "permission-slip.pdf");
  assert.equal(kept?.source, "Attached to a task");
  // A PDF opens in the browser's own reader, so it is served inline and unsandboxed.
  const link = new URL(file.url ?? "");
  const viewed = await server.app.request(`${link.pathname}${link.search}`);
  assert.equal(viewed.headers.get("content-type"), "application/pdf");
  assert.match(viewed.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(viewed.headers.get("x-content-type-options"), "nosniff");
  assert.equal(viewed.headers.get("content-security-policy"), null);
  // A PDF that does not open is refused before it is stored.
  const broken = await upload(
    task.id,
    "broken.pdf",
    text("%PDF-1.7 but nothing else"),
    "application/pdf",
  );
  assert.ok(broken.status >= 400 && broken.status < 500, String(broken.status));
  assert.equal((await server.agent.getTask(person, task.id)).attachments?.length, 1);
});

test("only the person who attached a file removes it, and its bytes go with it", async () => {
  const task = await create();
  const added = await server.agent.addAttachment("alice", task.id, {
    name: "plan.md",
    bytes: text("# Plan"),
  });
  const file = added.attachments?.[0];
  assert.ok(file);
  const stored = join(directory, "task-files", task.id, file.id);
  assert.ok(existsSync(stored));
  await assert.rejects(
    server.agent.removeAttachment("bob", task.id, file.id),
    /files you attached/,
  );
  await assert.rejects(server.agent.removeAttachment("alice", task.id, "nope"), /File not found/);
  const after = await server.agent.removeAttachment("alice", task.id, file.id);
  assert.deepEqual(after.attachments, []);
  assert.ok(!existsSync(stored));
  const gone = await server.app.request(new URL(file.url ?? "http://x/").pathname, {
    headers: headers(),
  });
  assert.equal(gone.status, 404);
});

test("deleting a task deletes its files", async () => {
  const task = await create();
  await upload(task.id, "keep.txt", text("hi"));
  const folder = join(directory, "task-files", task.id);
  assert.ok(existsSync(folder));
  await read(`/tasks/${task.id}`, undefined, 200, "DELETE");
  assert.ok(!existsSync(folder));
});

// ---- The brief a run starts from -----------------------------------------------------------------

test("a run's brief carries the notes and files, copies the files into its workspace, and marks the notes read", async () => {
  const task = await create({ prompt: "Plan the offsite" });
  await server.agent.addNote("alice", task.id, { text: "Budget is $5k" });
  await server.agent.addAttachment("alice", task.id, { name: "form.pdf", bytes: await pdf() });
  await server.agent.addAttachment("bob", task.id, { name: "form.txt", bytes: text("Name: ____") });
  await server.agent.addAttachment("bob", task.id, { name: "form.txt", bytes: text("Second") });
  await force(task.id, {
    input: { discussion: { channel: "ops", lines: "Alice: ship Friday" } },
  });
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const claimed = await server.agent.getTask(person, task.id);
  // The brief is built from the task as it is now, not as it was when the worker claimed it.
  const stale = { ...claimed, notes: [], attachments: [] };

  const brief = await server.agent.prepareBrief(person, stale, workspace);
  assert.match(brief.text, /1\. Alice · .* UTC\n {3}Budget is \$5k/);
  assert.match(brief.text, /Recent discussion in #ops/);
  assert.deepEqual(
    brief.files.map((f) => f.path),
    [
      `attachments/${task.id}/form.pdf`,
      `attachments/${task.id}/form.txt`,
      `attachments/${task.id}/form-2.txt`,
    ],
    "two files with one name keep both",
  );
  assert.equal(await readFile(join(workspace, brief.files[1].path), "utf8"), "Name: ____");
  assert.equal(await readFile(join(workspace, brief.files[2].path), "utf8"), "Second");
  assert.equal(brief.noteIds.length, 1);
  assert.match(brief.text, /also in Files as/);

  // Once the agent has the notes they are marked read; a later brief carries them again, as history.
  await server.agent.markNotesDelivered(person, task.id, brief.noteIds);
  const rerun = await server.agent.prepareBrief(
    person,
    await server.agent.getTask(person, task.id),
    workspace,
  );
  assert.deepEqual(rerun.noteIds, []);
  assert.match(rerun.text, /Budget is \$5k/);

  // Staging starts from an empty folder, so a removed file does not linger. Taking away the first
  // form.txt leaves the other one under that name, and form-2.txt is gone.
  const removed = rerun.files.find((f) => f.name === "form.txt");
  assert.ok(removed);
  await server.agent.removeAttachment("bob", task.id, removed.id);
  const after = await server.agent.prepareBrief(
    person,
    await server.agent.getTask(person, task.id),
    workspace,
  );
  assert.deepEqual(
    after.files.map((f) => f.path),
    [`attachments/${task.id}/form.pdf`, `attachments/${task.id}/form.txt`],
  );
  assert.equal(await readFile(join(workspace, after.files[1].path), "utf8"), "Second");
  assert.ok(!existsSync(join(workspace, `attachments/${task.id}/form-2.txt`)));
});

test("without a workspace the brief pastes text files in and points the agent at Files for PDFs", async () => {
  const task = await create();
  await server.agent.addAttachment(person, task.id, {
    name: "notes.txt",
    bytes: text("remember the milk"),
  });
  await server.agent.addAttachment(person, task.id, { name: "form.pdf", bytes: await pdf() });
  const brief = await server.agent.prepareBrief(
    person,
    await server.agent.getTask(person, task.id),
  );
  assert.match(brief.text, /### notes\.txt\n```\nremember the milk\n```/);
  assert.match(brief.text, /form\.pdf — PDF.*also in Files as/);
  assert.ok(!existsSync(join(directory, "attachments", task.id)));
});

test("a task with nothing added has no brief at all", async () => {
  const task = await create();
  const brief = await server.agent.prepareBrief(person, task);
  assert.equal(brief.text, "");
  assert.deepEqual(brief.noteIds, []);
});

test("an update is whatever the agent has not yet read or been shown", async () => {
  const task = await create();
  assert.equal(await server.agent.pendingUpdate(person, task.id, new Set()), null);
  const noted = await server.agent.addNote(person, task.id, { text: "Heads up" });
  const withFile = await server.agent.addAttachment(person, task.id, {
    name: "a.txt",
    bytes: text("a"),
  });
  const fileId = withFile.attachments?.[0].id ?? "";
  const pending = await server.agent.pendingUpdate(person, task.id, new Set());
  assert.deepEqual(
    [pending?.notes.map((n) => n.text), pending?.files.map((f) => f.id)],
    [["Heads up"], [fileId]],
  );
  await server.agent.markNotesDelivered(person, task.id, [noted.notes?.[0].id ?? ""]);
  const afterNote = await server.agent.pendingUpdate(person, task.id, new Set());
  assert.deepEqual(afterNote?.notes, []);
  assert.equal(await server.agent.pendingUpdate(person, task.id, new Set([fileId])), null);
});

// ---- A whole run, through the worker -----------------------------------------------------------

test("a run reads the notes and files, and hands its answer in for review", async (t) => {
  const { opencodeStandIn } = await import("./helpers/opencode.ts");
  const folder = await mkdtemp(join(tmpdir(), "hive-run-brief-"));
  const store = await createStore();
  const app = await createApp(store, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: folder,
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  const standIn = opencodeStandIn({ dataDir: folder });
  app.agent.opencodeRuntime = standIn.runtime as never;
  t.after(async () => {
    await app.agent.stop();
    await store.close();
    await rm(folder, { recursive: true, force: true });
  });
  const promptText = () => standIn.prompts[0].parts.map((part) => part.text).join("\n");
  standIn.agent(async ({ call, idle }) => {
    await call("finish_task", { summary: "Shortlisted two venues." });
    idle();
  });
  const task = await app.agent.createTask("owner", { prompt: "Find an offsite venue" });
  await app.agent.addNote("owner", task.id, { text: "Nothing over $5k" });
  await app.agent.addAttachment("owner", task.id, {
    name: "wishlist.txt",
    bytes: text("Has a lake"),
  });
  await app.agent.worker.tick();

  // The agent is told the task, the note, and where the file is, and the file is there to read.
  assert.ok(promptText().includes("Find an offsite venue"));
  assert.ok(promptText().includes("Nothing over $5k"));
  assert.ok(promptText().includes(`attachments/${task.id}/wishlist.txt`));
  const workspace = channelWorkspaceDir(
    folder,
    diskOwnerForChannel("orchestrator", "owner"),
    "orchestrator",
  );
  assert.equal(
    await readFile(join(workspace, "attachments", task.id, "wishlist.txt"), "utf8"),
    "Has a lake",
  );
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "in_review", saved.error ?? saved.question);
  assert.equal(saved.result, "Shortlisted two venues.");
  assert.equal(saved.notes?.[0].delivered, true, "the run read the note");
  assert.match(
    JSON.stringify(
      (await app.agent.detail("owner", task.id)).events.find(
        (e) => e.title === "Ready for your review",
      ),
    ),
    /Shortlisted two venues/,
  );

  // Sent back with a note, it runs again with the note and its own earlier result.
  standIn.reset();
  standIn.agent(async ({ call, idle }) => {
    await call("finish_task", { summary: "Now under $4k." });
    idle();
  });
  await app.agent.addNote("owner", task.id, { text: "Cheaper, please", run: true });
  await app.agent.worker.tick();
  assert.ok(promptText().includes("Cheaper, please"));
  assert.ok(promptText().includes("Shortlisted two venues."));
  assert.equal((await app.agent.getTask("owner", task.id)).status, "in_review");
  assert.equal((await app.agent.accept("owner", task.id)).status, "succeeded");
});
