import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { IdeaBatch } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import {
  answerLocal,
  controlLocal,
  detailOf,
  localBoard,
  localTask,
} from "./helpers/local-task.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
const owner = "workflow-user";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-workflows-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  server.agent.board = localBoard(server.agent);
  await server.workspace.ensureSample(owner, server.actions);
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function documentTask() {
  const w = await server.workspace.snapshot(owner);
  const mail = w.mail.find((m) => m.attachments.length);
  assert.ok(mail);
  const task = await localTask(server.agent, owner, {
    title: "Return school form",
    prompt: "Fill the school form and prepare a reply",
    kind: "document",
    input: { messageId: mail.id },
  });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask(owner, task.id);
  assert.equal(waiting.status, "waiting_input");
  assert.ok(Array.isArray(waiting.state.missingFields));
  await answerLocal(server.agent, owner, task.id, "Use these fictional test values", {
    participant_name: "Test Student",
    guardian_name: "Test Guardian",
    permission_granted: true,
  });
  await server.agent.worker.tick();
  const reviewed = await detailOf(server.agent, owner, task.id);
  assert.equal(reviewed.task.status, "waiting_approval");
  assert.equal(reviewed.files.length, 1);
  assert.ok(reviewed.files[0].url);
  assert.ok(reviewed.task.actionId);
  const action = await db.get<ActionProposal>(owner, "actions", reviewed.task.actionId);
  assert.ok(action);
  assert.equal(action.taskId, task.id);
  return { task: reviewed.task, action, originalId: mail.attachments[0] };
}

test("document job runs without a client, waits for review, and resumes from its receipt", async () => {
  const { task, action, originalId } = await documentTask();
  assert.equal((await server.files.get(owner, originalId)).parentId, undefined);
  assert.equal(
    (await server.workspace.snapshot(owner)).mail.filter((m) => m.subject.startsWith("Re:")).length,
    0,
  );
  await controlLocal(server.agent, owner, task.id, "pause");
  await assert.rejects(
    server.actions.decide(owner, action.id, action.hash, "approve"),
    /Resume the task/,
  );
  await controlLocal(server.agent, owner, task.id, "resume");
  const receipt = await server.actions.decide(owner, action.id, action.hash, "approve");
  assert.equal(receipt.status, "succeeded");
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
  await server.agent.worker.tick();
  assert.equal(
    (await db.list<ActionProposal>(owner, "actions")).filter((a) => a.taskId === task.id).length,
    1,
  );
});

test("ideas ignore sent replies while retaining unfinished incoming requests", async () => {
  const ideaOwner = "sent-reply-ideas";
  await server.workspace.ensureSample(ideaOwner, server.actions);
  const workspace = await server.workspace.snapshot(ideaOwner);
  // The mailbox is the workspace's, and earlier tests have sent replies with attachments into it.
  const incoming = workspace.mail.find(
    (mail) => mail.attachments.length && !/^Sent\b/i.test(mail.label),
  );
  assert.ok(incoming);
  await server.workspace.execute(ideaOwner, {
    kind: "email.send",
    data: {
      to: [incoming.from],
      cc: [],
      bcc: [],
      subject: "Re: Complete the form and schedule a meeting",
      body: "Here is the completed permission form. Let's meet for coffee.",
      attachmentIds: incoming.attachments,
    },
  });
  let batch: Omit<IdeaBatch, "id"> | undefined;
  server.agent.publishIdeas = async (sent) => {
    batch = sent;
  };
  await server.agent.refreshIdeas(ideaOwner);
  const ideas = batch!.ideas;
  const sent = (await server.workspace.snapshot(ideaOwner)).mail.find(
    (mail) => mail.sender === "You",
  );
  assert.ok(sent);
  assert.ok(ideas.some((idea) => idea.input.messageId === incoming.id));
  assert.ok(!ideas.some((idea) => idea.input.messageId === sent.id));
});

test("a review for a task that was cancelled cannot be approved", async () => {
  const { task, action } = await documentTask();
  await controlLocal(server.agent, owner, task.id, "cancel");
  await assert.rejects(
    server.actions.decide(owner, action.id, action.hash, "approve"),
    /Resume the task/,
  );
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(owner, task.id)).status, "cancelled");
});
