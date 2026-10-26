import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import {
  type AgentTask,
  type Channel,
  ORCHESTRATOR_CHANNEL_ID,
} from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
async function read<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await request(path, body);
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-channels-"));
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

test("the orchestrator channel always exists and cannot be archived", async () => {
  const channels = await read<Channel[]>("/channels");
  assert.ok(channels.some((c) => c.id === ORCHESTRATOR_CHANNEL_ID));
  assert.equal((await request(`/channels/${ORCHESTRATOR_CHANNEL_ID}/archive`, {})).status, 409);
});

test("channels can be created, listed, and archived", async () => {
  const created = await read<Channel>("/channels", { name: "Web App" }, 201);
  assert.equal(created.name, "Web App");
  assert.equal(created.status, "active");
  assert.ok((await read<Channel[]>("/channels")).some((c) => c.id === created.id));
  assert.equal((await request("/channels", { name: "Web App" })).status, 409);
  const archived = await read<Channel>(`/channels/${created.id}/archive`, {});
  assert.equal(archived.status, "archived");
});

test("tasks land in channels and channel views show delegated work", async () => {
  const channel = await read<Channel>("/channels", { name: "API" }, 201);
  const inChannel = await read<AgentTask>(
    "/tasks",
    { prompt: "Ship the endpoint", channelId: channel.id },
    201,
  );
  assert.equal(inChannel.channelId, channel.id);
  assert.equal(inChannel.originChannelId, channel.id);
  const defaulted = await read<AgentTask>("/tasks", { prompt: "Triage inbox" }, 201);
  assert.equal(defaulted.channelId, ORCHESTRATOR_CHANNEL_ID);
  assert.equal((await request("/tasks", { prompt: "Nope", channelId: "missing" })).status, 404);
  // Delegated elsewhere but requested here: still visible in the origin channel.
  await db.put("local-user", "tasks", {
    ...inChannel,
    channelId: ORCHESTRATOR_CHANNEL_ID,
    delegatedTo: ORCHESTRATOR_CHANNEL_ID,
  });
  const visible = await read<AgentTask[]>(`/channels/${channel.id}/tasks`);
  assert.ok(visible.some((t) => t.id === inChannel.id));
  const orch = await read<AgentTask[]>(`/channels/${ORCHESTRATOR_CHANNEL_ID}/tasks`);
  assert.ok(orch.some((t) => t.id === inChannel.id));
  assert.ok(orch.some((t) => t.id === defaulted.id));
});

test("delegation moves execution but keeps origin visibility", async () => {
  const channel = await read<Channel>("/channels", { name: "Delegate Me" }, 201);
  const task = await read<AgentTask>(
    "/tasks",
    { prompt: "Do the thing", channelId: channel.id },
    201,
  );
  const moved = await read<AgentTask>(`/tasks/${task.id}/delegate`, {
    target: ORCHESTRATOR_CHANNEL_ID,
    reason: "needs the computer",
  });
  assert.equal(moved.channelId, ORCHESTRATOR_CHANNEL_ID);
  assert.equal(moved.originChannelId, channel.id);
  assert.equal(moved.delegatedTo, ORCHESTRATOR_CHANNEL_ID);
  assert.equal(moved.delegationReason, "needs the computer");
  assert.equal(moved.status, "queued");
  const inOrigin = await read<AgentTask[]>(`/channels/${channel.id}/tasks`);
  assert.ok(inOrigin.some((t) => t.id === task.id));
  const inOrch = await read<AgentTask[]>(`/channels/${ORCHESTRATOR_CHANNEL_ID}/tasks`);
  assert.ok(inOrch.some((t) => t.id === task.id));
});

test("delegation rejects unknown targets and live-running tasks", async () => {
  const task = await read<AgentTask>("/tasks", { prompt: "Another thing" }, 201);
  assert.equal((await request(`/tasks/${task.id}/delegate`, { target: "nope" })).status, 404);
  await db.put("local-user", "tasks", {
    ...task,
    status: "running",
    leaseId: "lease-1",
    leaseUntil: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(
    (await request(`/tasks/${task.id}/delegate`, { target: ORCHESTRATOR_CHANNEL_ID })).status,
    409,
  );
});

test("delegating to a channel revives it and fails for archived ones", async () => {
  const channel = await read<Channel>("/channels", { name: "Revive Me" }, 201);
  await read<Channel>(`/channels/${channel.id}/archive`, {});
  const task = await read<AgentTask>("/tasks", { prompt: "Revival task" }, 201);
  assert.equal((await request(`/tasks/${task.id}/delegate`, { target: channel.id })).status, 404);
});

test("channel workers only claim their own channel's tasks", async () => {
  const wdb = await createStore();
  try {
    const mk = (id: string, channelId?: string): AgentTask => ({
      id,
      title: id,
      prompt: id,
      kind: "agent",
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
      ...(channelId === undefined ? {} : { channelId }),
    });
    await wdb.put("owner", "tasks", mk("t-a", "alpha"));
    await wdb.put("owner", "tasks", mk("t-b", "beta"));
    await wdb.put("owner", "tasks", mk("t-plain"));
    const claimed: string[] = [];
    const handler = async (_owner: string, task: AgentTask) => {
      claimed.push(task.id);
      return { status: "succeeded" as const };
    };
    await new TaskWorker(wdb, handler, { channelId: "alpha" }).tick();
    assert.deepEqual(claimed, ["t-a"]);
    await new TaskWorker(wdb, handler, { channelId: ORCHESTRATOR_CHANNEL_ID }).tick();
    assert.deepEqual(claimed, ["t-a", "t-plain"]);
    // Unfiltered worker keeps the legacy claim-everything behavior.
    await new TaskWorker(wdb, handler).tick();
    assert.deepEqual(claimed, ["t-a", "t-plain", "t-b"]);
  } finally {
    await wdb.close();
  }
});
