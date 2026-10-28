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
import { inspectAttachment } from "../apps/server/src/engine/task-files.ts";
import { channelWorkspaceDir, diskOwnerForChannel } from "../apps/server/src/engine/threads.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { taskBriefLimits } from "../packages/domain/src/agent.ts";
import type { Artifact } from "../packages/domain/src/index.ts";
import {
  detailOf,
  localBoard,
  localFile,
  localNote,
  localTask,
  markDone,
} from "./helpers/local-task.ts";

/**
 * What the machine does with a task it was lent: the agent hands its work in for review, and is told the notes
 * and files people added besides the task itself. (Who may mark work done, add notes and files, and send work
 * back is the chat service's; see chat-work.test.ts and chat-work-calls.test.ts.)
 */

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
const person = "local-user";

const text = (value: string) => new TextEncoder().encode(value);
const force = (id: string, patch: Record<string, unknown>) =>
  db.compareAndSwap("shared", "tasks", id, {}, patch);
const create = (body: Record<string, unknown> = {}) =>
  localTask(server.agent, person, { title: "A task", prompt: "Do the thing", ...body });
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
  // The board is the chat service's; these tests are about the machine, which may see every task.
  server.agent.board = localBoard(server.agent);
  await db.put("system", "users", { id: person, name: "Pat" });
  await db.put("system", "users", { id: "alice", name: "Alice" });
  await db.put("system", "users", { id: "bob", name: "Bob" });
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// ---- Review and the brief ----

test("the worker never picks up work in review", async () => {
  const task = await inReview();
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(person, task.id)).status, "in_review");
});

// ---- Notes -----------------------------------------------------------------------------------

test("only supported, genuine files are kept for the agent", () => {
  const refused = (name: string, bytes: Uint8Array, status: number, pattern: RegExp) => {
    assert.throws(
      () => inspectAttachment(name, bytes),
      (error: Error & { status?: number }) =>
        error.status === status && pattern.test(error.message),
      name,
    );
  };
  refused("run.exe", text("MZ"), 422, /Attach a PDF/);
  refused("noext", text("hello"), 422, /Attach a PDF/);
  refused("empty.txt", new Uint8Array(), 422, /empty/);
  refused("fake.png", text("this is not a png"), 422, /not a real PNG/);
  refused("fake.pdf", text("%PDF"), 422, /not a real PDF/);
  refused("binary.txt", new Uint8Array([104, 105, 0, 1, 2]), 422, /not a real TXT/);
  refused("latin1.md", new Uint8Array([0xff, 0xfe, 0xfd]), 422, /not a real MD/);
  refused(
    "big.txt",
    new Uint8Array(taskBriefLimits.attachmentBytes + 1).fill(97),
    413,
    /10 MB or smaller/,
  );
  // Real ones are fine, and the type comes from the file's name, with the folder part dropped.
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(inspectAttachment("../../etc/Photo.PNG", png), {
    name: "Photo.png",
    mimeType: "image/png",
  });
});

test("a PDF kept for a task is also kept in Files for the agent's PDF tools", async () => {
  const task = await create();
  const file = await localFile(server.agent, person, task.id, {
    name: "permission-slip.pdf",
    bytes: await pdf(),
  });
  assert.equal(file.mimeType, "application/pdf");
  assert.ok(file.fileId);
  const kept = await db.get<Artifact>(person, "files", file.fileId);
  assert.equal(kept?.name, "permission-slip.pdf");
  assert.equal(kept?.source, "Attached to a task");
  // A PDF that does not open is refused before it is kept.
  await assert.rejects(
    localFile(server.agent, person, task.id, {
      name: "broken.pdf",
      bytes: text("%PDF-1.7 but nothing else"),
    }),
  );
  assert.equal((await server.agent.getTask(person, task.id)).attachments?.length, 1);
});

test("a run's brief carries the notes and files, copies the files into its workspace, and marks the notes read", async () => {
  const task = await create({ prompt: "Plan the offsite" });
  await localNote(server.agent, "alice", task.id, { text: "Budget is $5k" });
  await localFile(server.agent, "alice", task.id, { name: "form.pdf", bytes: await pdf() });
  await localFile(server.agent, "bob", task.id, { name: "form.txt", bytes: text("Name: ____") });
  await localFile(server.agent, "bob", task.id, { name: "form.txt", bytes: text("Second") });
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
  await db.removeItem("shared", "tasks", task.id, "attachments", removed.id);
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
  await localFile(server.agent, person, task.id, {
    name: "notes.txt",
    bytes: text("remember the milk"),
  });
  await localFile(server.agent, person, task.id, { name: "form.pdf", bytes: await pdf() });
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
  const noted = await localNote(server.agent, person, task.id, { text: "Heads up" });
  const withFile = await localFile(server.agent, person, task.id, {
    name: "a.txt",
    bytes: text("a"),
  });
  const fileId = withFile.id;
  const pending = await server.agent.pendingUpdate(person, task.id, new Set());
  assert.deepEqual(
    [pending?.notes.map((n) => n.text), pending?.files.map((f) => f.id)],
    [["Heads up"], [fileId]],
  );
  await server.agent.markNotesDelivered(person, task.id, [noted.id]);
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
  const task = await localTask(app.agent, "owner", { prompt: "Find an offsite venue" });
  await localNote(app.agent, "owner", task.id, { text: "Nothing over $5k" });
  await localFile(app.agent, "owner", task.id, {
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
      (await detailOf(app.agent, "owner", task.id)).events.find(
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
  // The chat service puts it back in the queue with the note; the machine is lent it again.
  await localNote(app.agent, "owner", task.id, { text: "Cheaper, please" });
  await app.agent.db.compareAndSwap("owner", "tasks", task.id, {}, { status: "queued" });
  await app.agent.worker.tick();
  assert.ok(promptText().includes("Cheaper, please"));
  assert.ok(promptText().includes("Shortlisted two venues."));
  assert.equal((await app.agent.getTask("owner", task.id)).status, "in_review");
  assert.equal((await markDone(app.agent, "owner", task.id)).status, "succeeded");
});
