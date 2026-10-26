import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { channelWorkspaceDir } from "../apps/server/src/engine/threads.ts";
import type { AgentMemory, AgentTask, Channel } from "../packages/domain/src/agent.ts";

/**
 * What the agent's machine keeps for a channel it was mentioned in goes when the channel is deleted in the
 * chat service: its folder, its threads, its tasks and what the agent learned there. Only a channel the
 * machine holds as a stand-in is touched.
 */
let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-purge-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  server = await createApp(db, config);
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const now = () => new Date().toISOString();
const channelRecord = (id: string, createdBy: string): Channel => ({
  id,
  name: id,
  status: "active",
  createdBy,
  createdAt: now(),
  updatedAt: now(),
  workerPid: null,
  lastActiveAt: now(),
  visibility: "private",
});

async function keepSomething(id: string, createdBy: string) {
  await db.put("shared", "channels", channelRecord(id, createdBy));
  const folder = channelWorkspaceDir(directory, "shared", id);
  await mkdir(join(folder, "threads"), { recursive: true });
  await writeFile(join(folder, "uploads.txt"), "what the agent was shown");
  await writeFile(
    join(folder, "threads", "chat-1.json"),
    JSON.stringify({ threadId: "chat-1", channelId: id, name: "t", createdAt: now() }),
  );
  const task = await server.agent.createTask("shared", {
    title: `Task of ${id}`,
    kind: "manual",
    channelId: id,
    input: {},
  });
  await db.put("shared", "memories", {
    id: `memory-${id}`,
    text: "something learned",
    source: "test",
    createdAt: now(),
    channelId: id,
  } as AgentMemory);
  return { folder, task };
}

test("everything the machine kept for a deleted channel goes: folder, threads, tasks, what it learned, the record", async () => {
  const gone = await keepSomething("chat-gone", "chat");
  const kept = await keepSomething("chat-kept", "chat");
  assert.deepEqual((await server.agent.standInIds()).sort(), ["chat-gone", "chat-kept"]);

  await server.agent.purgeChannel("chat-gone");

  assert.equal(await db.get("shared", "channels", "chat-gone"), null);
  assert.equal(await db.get("shared", "tasks", gone.task.id), null);
  assert.equal(await db.get("shared", "memories", "memory-chat-gone"), null);
  await assert.rejects(readdir(gone.folder), "the folder is gone");
  // Another channel is left as it was.
  assert.ok(await db.get<AgentTask>("shared", "tasks", kept.task.id));
  assert.ok(await db.get("shared", "memories", "memory-chat-kept"));
  assert.ok((await readdir(kept.folder)).includes("uploads.txt"));
  assert.deepEqual(await server.agent.standInIds(), ["chat-kept"]);
});

test("a channel that is not a stand-in, and the orchestrator, are never purged", async () => {
  const own = await keepSomething("made-here", "someone");
  await server.agent.purgeChannel("made-here");
  assert.ok(await db.get("shared", "channels", "made-here"));
  assert.ok(await db.get("shared", "tasks", own.task.id));
  assert.ok((await readdir(own.folder)).includes("uploads.txt"));
  await server.agent.purgeChannel("orchestrator");
  // A channel that is not there is nothing to do.
  await server.agent.purgeChannel("never-existed");
});
