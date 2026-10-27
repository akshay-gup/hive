import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { MemoryThreadStore } from "../apps/server/src/engine/threads.ts";
import {
  type AgentTask,
  type Channel,
  type ChannelThread,
  ORCHESTRATOR_CHANNEL_ID,
} from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown, method?: string) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(method === undefined && body === undefined
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
  directory = await mkdtemp(join(tmpdir(), "hive-channel-threads-"));
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
  server = await createApp(db, config, { threads: new MemoryThreadStore() });
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

test("creating a channel starts with no threads", async () => {
  const channel = await read<Channel>("/channels", { name: "Threaded project" }, 201);
  const threads = await read<ChannelThread[]>(`/channels/${channel.id}/threads`);
  assert.equal(threads.length, 0);
});

test("new threads get server-generated ids and sequential names", async () => {
  const channel = await read<Channel>("/channels", { name: "Numbered threads" }, 201);
  const first = await read<ChannelThread>(`/channels/${channel.id}/threads`, {}, 201);
  assert.ok(first.threadId);
  assert.equal(first.name, "Thread 1");
  const second = await read<ChannelThread>(`/channels/${channel.id}/threads`, {}, 201);
  assert.ok(second.threadId);
  assert.equal(second.name, "Thread 2");
  const named = await read<ChannelThread>(
    `/channels/${channel.id}/threads`,
    { name: "Research" },
    201,
  );
  assert.equal(named.name, "Research");
  const threads = await read<ChannelThread[]>(`/channels/${channel.id}/threads`);
  assert.equal(threads.length, 3);
  assert.deepEqual(
    threads.map((t) => t.name),
    ["Thread 1", "Thread 2", "Research"],
  );
});

test("creating a thread on a missing or archived channel 404s", async () => {
  test("threads forked from a message record their parent message id", async () => {
    const channel = await read<Channel>("/channels", { name: "Forked threads" }, 201);
    const reply = await read<ChannelThread>(
      `/channels/${channel.id}/threads`,
      { name: "Re: hello", parentMessageId: "user-123" },
      201,
    );
    assert.equal(reply.parentMessageId, "user-123");
    const plain = await read<ChannelThread>(`/channels/${channel.id}/threads`, {}, 201);
    assert.equal(plain.parentMessageId, undefined);
    const threads = await read<ChannelThread[]>(
      `/channels/${channel.id}/threads`,
      undefined,
      200,
      "GET",
    );
    assert.deepEqual(
      threads.map((t) => t.parentMessageId ?? null),
      ["user-123", null],
    );
  });
  await read("/channels/nope/threads", {}, 404);
  const channel = await read<Channel>("/channels", { name: "Doomed" }, 201);
  await read(`/channels/${channel.id}/threads`, { name: "Last words" }, 201);
  await read(`/channels/${channel.id}/archive`, {}, 200);
  await read(`/channels/${channel.id}/threads`, {}, 404);
  // History survives archiving: threads are still listed.
  const threads = await read<ChannelThread[]>(
    `/channels/${channel.id}/threads`,
    undefined,
    200,
    "GET",
  );
  assert.equal(threads.length, 1);
  assert.equal(threads[0].name, "Last words");
});

test("thread reverse lookup resolves the owning channel", async () => {
  const channel = await read<Channel>("/channels", { name: "Lookup" }, 201);
  const thread = await read<ChannelThread>(`/channels/${channel.id}/threads`, {}, 201);
  const binding = await read<ChannelThread>(`/threads/${thread.threadId}/channel`);
  assert.equal(binding.channelId, channel.id);
  await read(`/threads/does-not-exist/channel`, undefined, 404, "GET");
});

test("binding a client-known thread id is idempotent", async () => {
  const first = await read<ChannelThread>("/threads/bind", {
    threadId: "main-thread-id",
    channelId: ORCHESTRATOR_CHANNEL_ID,
    name: "Main chat",
  });
  assert.equal(first.threadId, "main-thread-id");
  const second = await read<ChannelThread>("/threads/bind", {
    threadId: "main-thread-id",
    channelId: ORCHESTRATOR_CHANNEL_ID,
  });
  assert.deepEqual(second, first);
  const resolved = await read<ChannelThread>("/threads/main-thread-id/channel");
  assert.equal(resolved.channelId, ORCHESTRATOR_CHANNEL_ID);
});

test("renaming a thread updates its display name only", async () => {
  const channel = await read<Channel>("/channels", { name: "Renames" }, 201);
  const thread = await read<ChannelThread>(`/channels/${channel.id}/threads`, {}, 201);
  const renamed = await read<ChannelThread>(
    `/threads/${thread.threadId}`,
    { name: "  Better name  " },
    200,
    "PATCH",
  );
  assert.equal(renamed.name, "Better name");
  assert.equal(renamed.threadId, thread.threadId);
  // The binding is untouched: reverse lookup still resolves the same channel.
  const binding = await read<ChannelThread>(`/threads/${thread.threadId}/channel`);
  assert.equal(binding.channelId, channel.id);
  assert.equal(binding.name, "Better name");
  const threads = await read<ChannelThread[]>(`/channels/${channel.id}/threads`);
  assert.equal(threads[0].name, "Better name");
});

test("renaming rejects blank names and unknown threads", async () => {
  const channel = await read<Channel>("/channels", { name: "Rename guard" }, 201);
  const thread = await read<ChannelThread>(`/channels/${channel.id}/threads`, {}, 201);
  await read(`/threads/${thread.threadId}`, { name: "   " }, 422, "PATCH");
  await read(`/threads/${thread.threadId}`, { name: "x".repeat(81) }, 422, "PATCH");
  await read(`/threads/does-not-exist`, { name: "Nope" }, 404, "PATCH");
});

test("LocalDiskThreadStore round-trips bindings on the local filesystem", async () => {
  const { LocalDiskThreadStore } = await import("../apps/server/src/engine/threads.ts");
  const base = await mkdtemp(join(tmpdir(), "hive-local-threads-"));
  try {
    const store = new LocalDiskThreadStore(base);
    const binding: ChannelThread = {
      threadId: "thread-1",
      channelId: "chan-1",
      name: "Thread 1",
      createdAt: new Date().toISOString(),
    };
    await store.write("owner", binding);
    const listed = await store.list("owner", "chan-1");
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], binding);
    // Reverse lookup across channels.
    const scanned = await store.scan("owner");
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].channelId, "chan-1");
    // Rename rewrites the same file.
    await store.write("owner", { ...binding, name: "Renamed" });
    const relisted = await store.list("owner", "chan-1");
    assert.equal(relisted.length, 1);
    assert.equal(relisted[0].name, "Renamed");
    // Unknown channels read as empty.
    assert.deepEqual(await store.list("owner", "nope"), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
