import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type {
  AgentNotification,
  AgentTask,
  AgentWorkspace,
  ChannelThread,
  Project,
} from "../packages/domain/src/agent.ts";
import type { ActionProposal, Workspace } from "../packages/domain/src/index.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";
import { detailOf, localBoard, localTask } from "./helpers/local-task.ts";

/**
 * Hive is a team workspace: channels, threads (and the agent's replies in them), tasks, boards,
 * reviews, files, drafts and the agent's own memory are shared by everyone who is signed in. Only
 * the orchestrator chat stays private.
 */

const ALICE = "google:alice";
const BOB = "google:bob";
let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
let tokenA = "",
  tokenB = "";

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
function call(token: string, path: string, body?: unknown, method?: string) {
  return server.app.request(path, {
    headers: headers(token),
    ...(body === undefined && method === undefined
      ? {}
      : {
          method: method ?? "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
  });
}
async function read<T>(
  token: string,
  path: string,
  body?: unknown,
  status = 200,
  method?: string,
): Promise<T> {
  const response = await call(token, path, body, method);
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const agent = <T>(token: string, path: string, body?: unknown, status = 200, method?: string) =>
  read<T>(token, `/api/agent${path}`, body, status, method);
type Transcript = { messages: { id: string; role: string; content?: unknown; name?: string }[] };
const transcript = (token: string, threadId: string) =>
  read<Transcript>(token, `/api/conversation?threadId=${encodeURIComponent(threadId)}`);
const saveTranscript = (token: string, threadId: string, messages: unknown[]) =>
  read(
    token,
    `/api/conversation?threadId=${encodeURIComponent(threadId)}`,
    { messages },
    200,
    "PUT",
  );

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-shared-"));
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
  server.agent.board = localBoard(server.agent);
  tokenA = (await server.auth.sessionForOwner(ALICE)).token;
  tokenB = (await server.auth.sessionForOwner(BOB)).token;
  await db.put("system", "users", { id: ALICE, name: "Alice", email: "alice@example.com" });
  await db.put("system", "users", { id: BOB, name: "Bob", email: "bob@example.com" });
  await agent(tokenA, "/channels");
  await agent(tokenB, "/channels");
  await agent(tokenA, "/channels", { name: "Team" }, 201);
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

let thread: ChannelThread;
test("a thread's messages and the agent's replies are visible to everyone in the channel", async () => {
  thread = await agent<ChannelThread>(
    tokenA,
    "/channels/team/threads",
    { name: "Plan", parentMessageId: "root" },
    201,
  );
  await saveTranscript(tokenA, thread.threadId, [
    { id: "u1", role: "user", content: "@hive draft the launch plan" },
    { id: "a1", role: "assistant", content: "Here is a first draft." },
  ]);
  const seenByBob = await transcript(tokenB, thread.threadId);
  assert.deepEqual(
    seenByBob.messages.map((m) => [m.id, m.role, m.name]),
    [
      ["u1", "user", "Alice"],
      ["a1", "assistant", undefined],
    ],
  );
});

test("replies from different people merge into one thread", async () => {
  await saveTranscript(tokenB, thread.threadId, [
    { id: "u1", role: "user", content: "@hive draft the launch plan" },
    { id: "a1", role: "assistant", content: "Here is a first draft." },
    { id: "u2", role: "user", content: "Add a rollback step" },
  ]);
  // Alice's client had not loaded Bob's reply when it saved again.
  await saveTranscript(tokenA, thread.threadId, [
    { id: "u1", role: "user", content: "@hive draft the launch plan" },
    { id: "a1", role: "assistant", content: "Here is a first draft." },
    { id: "a2", role: "assistant", content: "Anything else?" },
  ]);
  const seen = await transcript(tokenB, thread.threadId);
  assert.deepEqual(
    seen.messages.map((m) => [m.id, m.name]),
    [
      ["u1", "Alice"],
      ["a1", undefined],
      ["u2", "Bob"],
      ["a2", undefined],
    ],
  );
});

test("a thread forked from a channel keeps the channel's authors on the seeded messages", async () => {
  await saveTranscript(tokenA, "channel:team", [
    { id: "c1", role: "user", content: "Launch is Friday" },
  ]);
  const forked = await agent<ChannelThread>(
    tokenB,
    "/channels/team/threads",
    { name: "Friday", parentMessageId: "c1" },
    201,
  );
  // Bob forks the thread; the client seeds it with the channel messages it was showing.
  await saveTranscript(tokenB, forked.threadId, [
    { id: "c1", role: "user", content: "Launch is Friday" },
    { id: "u9", role: "user", content: "@hive what is left?" },
  ]);
  const seen = await transcript(tokenA, forked.threadId);
  assert.deepEqual(
    seen.messages.map((m) => [m.id, m.name]),
    [
      ["c1", "Alice"],
      ["u9", "Bob"],
    ],
  );
});

test("the orchestrator chat stays private, including its threads", async () => {
  const main = await agent<ChannelThread>(
    tokenA,
    "/threads/bind",
    { threadId: "orchestrator-thread-a", channelId: "orchestrator" },
    200,
  );
  assert.equal(main.channelId, "orchestrator");
  await saveTranscript(tokenA, main.threadId, [
    { id: "p1", role: "user", content: "private note to my orchestrator" },
  ]);
  assert.equal((await transcript(tokenA, main.threadId)).messages.length, 1);
  assert.deepEqual((await transcript(tokenB, main.threadId)).messages, []);
  // The legacy main conversation is private too.
  await read(
    tokenA,
    "/api/conversation",
    { messages: [{ id: "d1", role: "user", content: "x" }] },
    200,
    "PUT",
  );
  assert.deepEqual((await read<Transcript>(tokenB, "/api/conversation")).messages, []);
});

let _task: AgentTask;
let _project: Project;
test("the worker runs a task as the person who asked for it and its run is on the machine for the room to show", async () => {
  const mine = await localTask(server.agent, ALICE, {
    title: "Summarise the thread",
    prompt: "Summarise it",
    kind: "agent",
    channelId: "team",
  });
  const actors: string[] = [];
  const worker = new TaskWorker(
    db,
    async (owner, _task, context) => {
      actors.push(owner);
      await context.event("step", "Reading the thread", "three messages");
      return { status: "succeeded", result: "Summarised" };
    },
    { pollMs: 5 },
  );
  await worker.tick();
  assert.deepEqual(actors, [ALICE]);
  const seen = await detailOf(server.agent, BOB, mine.id);
  assert.equal(seen.task.status, "succeeded");
  assert.ok(seen.events.some((e) => e.title === "Reading the thread"));
});

test("a task's outcome notifies whoever started it, and no one else", async () => {
  await localTask(server.agent, ALICE, {
    title: "Research venues",
    prompt: "Find venues",
    kind: "agent",
    channelId: "team",
  });
  // No model is configured, so the task stops to ask for one: an outcome that wants a person.
  await server.agent.worker.tick();
  const notes = (token: string) => agent<AgentNotification[]>(token, "/notifications");
  const forAlice = (await notes(tokenA)).find((n) => n.title === "Your details are needed");
  assert.ok(forAlice, "Alice sees the notification her task raised");
  // It is hers: Bob is not shown it, cannot read it, and reading it does not change what she has.
  assert.equal(
    (await notes(tokenB)).some((n) => n.id === forAlice.id),
    false,
  );
  await agent(tokenB, `/notifications/${forAlice.id}/read`, {}, 404);
  await agent(tokenA, `/notifications/${forAlice.id}/read`, {});
  assert.equal((await notes(tokenA)).find((n) => n.id === forAlice.id)?.read, true);
});

test("reviews and receipts are shared, and anyone on the team can approve one", async () => {
  const work = await localTask(server.agent, ALICE, {
    title: "Book the venue",
    kind: "manual",
    channelId: "team",
  });
  await db.put(ALICE, "tasks", { ...work, status: "running" });
  const now = Date.now();
  const proposal = await server.actions.propose(
    ALICE,
    {
      kind: "calendar.create",
      data: {
        calendarId: "primary",
        title: "Venue walkthrough",
        start: new Date(now + 86400000).toISOString(),
        end: new Date(now + 90000000).toISOString(),
        allDay: false,
        timeZone: "UTC",
        description: "",
        location: "Main hall",
        attendees: [],
      },
    },
    "venue-review",
    work.id,
  );
  const bobsView = await read<Workspace>(tokenB, "/api/workspace");
  assert.ok(
    bobsView.actions.some((a) => a.id === proposal.id),
    "Bob sees the pending review",
  );
  assert.ok(
    bobsView.activity.some((a) => a.actionId === proposal.id),
    "and its timeline entry",
  );

  // The review runs on the workspace's one Google connection, so Bob can approve Alice's.
  const approved = await read<ActionProposal>(tokenB, `/api/actions/${proposal.id}/decide`, {
    hash: proposal.hash,
    decision: "approve",
  });
  assert.equal(approved.status, "succeeded");
  const receipts = await read<Workspace>(tokenA, "/api/workspace");
  const receipt = receipts.actions.find((a) => a.id === proposal.id);
  assert.equal(receipt?.status, "succeeded");
  assert.equal(receipt?.createdByName, "Alice");
});

const calendarReview = (title: string) => ({
  kind: "calendar.create" as const,
  data: {
    calendarId: "primary",
    title,
    start: new Date(Date.now() + 86400000).toISOString(),
    end: new Date(Date.now() + 90000000).toISOString(),
    allDay: false,
    timeZone: "UTC",
    description: "",
    location: "",
    attendees: [],
  },
});

test("anyone can decline a review", async () => {
  const work = await localTask(server.agent, ALICE, {
    title: "Send the invite",
    kind: "manual",
    channelId: "team",
  });
  await db.put(ALICE, "tasks", { ...work, status: "running" });
  const proposal = await server.actions.propose(
    ALICE,
    calendarReview("Kickoff"),
    "kickoff-review",
    work.id,
  );
  const declined = await read<ActionProposal>(tokenB, `/api/actions/${proposal.id}/decide`, {
    hash: proposal.hash,
    decision: "deny",
  });
  assert.equal(declined.status, "denied");
});

test("cancelling a task declines its pending review, whoever cancels it", async () => {
  const work = await localTask(server.agent, ALICE, {
    title: "Order the cake",
    kind: "manual",
    channelId: "team",
  });
  await db.put(ALICE, "tasks", { ...work, status: "running" });
  const proposal = await server.actions.propose(
    ALICE,
    calendarReview("Cake pickup"),
    "cake-review",
    work.id,
  );
  await db.compareAndSwap(ALICE, "tasks", work.id, {}, { actionId: proposal.id });
  // Whoever stops it, in the chat service, the machine is told, and declines what was waiting on a decision.
  const stopped = await db.put(ALICE, "tasks", {
    ...work,
    status: "cancelled" as const,
    actionId: proposal.id,
  });
  await server.agent.outcome(stopped);
  const after = await read<Workspace>(tokenA, "/api/workspace");
  assert.equal(after.actions.find((a) => a.id === proposal.id)?.status, "denied");
});

test("a review prepared outside any task is the workspace's too", async () => {
  const now = Date.now();
  const outside = await server.actions.propose(ALICE, {
    kind: "calendar.create",
    data: {
      calendarId: "primary",
      title: "Dentist",
      start: new Date(now + 86400000).toISOString(),
      end: new Date(now + 90000000).toISOString(),
      allDay: false,
      timeZone: "UTC",
      description: "",
      location: "",
      attendees: [],
    },
  });
  const bobsView = await read<Workspace>(tokenB, "/api/workspace");
  assert.ok(bobsView.actions.some((a) => a.id === outside.id));
  assert.ok(bobsView.activity.some((a) => a.actionId === outside.id));
  const approved = await read<ActionProposal>(tokenB, `/api/actions/${outside.id}/decide`, {
    hash: outside.hash,
    decision: "approve",
  });
  assert.equal(approved.status, "succeeded");
});

test("everything else is shared too: drafts, files, browser sessions, memory and the agent's personality", async () => {
  await read(
    tokenA,
    "/api/drafts",
    { to: ["x@example.com"], cc: [], bcc: [], subject: "Hi", body: "Draft", attachmentIds: [] },
    201,
  );
  assert.equal((await read<unknown[]>(tokenB, "/api/drafts")).length, 1);

  const file = await server.files.import(
    ALICE,
    "Permission slip.pdf",
    await createSamplePdf(),
    "Uploaded",
  );
  assert.ok((await read<Workspace>(tokenB, "/api/workspace")).files.some((f) => f.id === file.id));
  const content = await call(tokenB, `/api/files/${file.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "application/pdf");

  await db.put(ALICE, "browsers", {
    id: "session-1",
    title: "Example",
    url: "https://example.org/",
    status: "idle",
    updatedAt: new Date().toISOString(),
  });
  assert.ok(
    (await read<Workspace>(tokenB, "/api/workspace")).browsers.some((b) => b.id === "session-1"),
  );

  await agent(tokenA, "/memories", { text: "Prefers short answers" }, 201);
  assert.equal((await agent<AgentWorkspace>(tokenB, "")).memories.length, 1);
  await agent(tokenA, "/identity", { name: "Sky", tone: "concise" });
  assert.equal((await agent<AgentWorkspace>(tokenB, "")).identity.name, "Sky");
});

test("work the server does for the workspace itself leaves no orchestrator chat behind", async () => {
  // The agent's personality is one shared record, so background maintenance, which acts as the
  // record's owner, now runs for the workspace rather than for a person.
  await (server.agent as unknown as { maintain(): Promise<void> }).maintain();
  await server.agent.ensure("shared");
  assert.equal(await db.get("shared", "channels", "orchestrator"), null);
  const channels = await agent<{ id: string }[]>(tokenA, "/channels");
  assert.equal(channels.filter((c) => c.id === "orchestrator").length, 1);
});
