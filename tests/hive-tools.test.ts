import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { conversationTools } from "../apps/server/src/engine/tools.ts";
import { HiveToolBridge } from "../apps/server/src/opencode/hive-tools.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { localBoard } from "./helpers/local-task.ts";

let directory: string,
  db: Awaited<ReturnType<typeof createStore>>,
  server: Awaited<ReturnType<typeof createApp>>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-tool-bridge-"));
  db = await createStore({ dataDir: join(directory, "postgres") });
  server = await createApp(db, {
    mode: "sample",
    host: "127.0.0.1",
    port: 8787,
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("MCP exposes shared tools and creates five real manual timeline tasks in the originating channel", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Bridge tasks" });
  const thread = await server.agent.registerThread("alice", channel.id);
  const abort = new AbortController();
  const tools = conversationTools(
    server.agent,
    "alice",
    {
      threadId: thread.threadId,
      runId: "test-run",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    {
      signal: abort.signal,
      requestKey: "test-run",
      channelId: channel.id,
      // The board is the chat service's; here the machine's own copies of tasks stand in for it.
      work: localBoard(server.agent).forPerson("alice"),
    },
  );
  const bridge = new HiveToolBridge("http://localhost:8787/api/hive-tools");
  const lease = bridge.lease(tools, abort.signal);
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await bridge.routes.request("/", {
      method: "POST",
      headers: { Authorization: `Bearer ${lease.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const listed = await rpc("tools/list");
  assert.deepEqual(
    listed.result.tools.map((t: { name: string }) => t.name),
    tools.map((t) => t.name),
  );
  assert.ok(
    listed.result.tools.find((t: { name: string }) => t.name === "create_issue").inputSchema
      .properties.startAt,
  );
  for (let i = 0; i < 5; i++) {
    const result = await rpc("tools/call", {
      name: "create_issue",
      arguments: {
        title: `Dummy ${i + 1}`,
        startAt: "2026-10-05",
        dueAt: "2026-10-16",
        owner: "bob",
      },
    });
    assert.equal(result.result.isError, undefined);
    const task = JSON.parse(result.result.content[0].text);
    assert.equal(task.kind, "manual");
    assert.equal(task.status, "queued");
    assert.equal(task.channelId, channel.id);
    assert.equal(task.threadId, thread.threadId);
  }
  // Tasks are shared by the workspace; the tool files each one under the person running it,
  // whatever owner the model asks for.
  const tasks = await db.list<AgentTask>("alice", "tasks");
  assert.equal(tasks.length, 5);
  assert.ok(tasks.every((task) => task.createdBy === "alice"));
  await rpc("tools/call", {
    name: "create_issue",
    arguments: { title: "Dummy 1", startAt: "2026-10-05", dueAt: "2026-10-16" },
  });
  assert.equal((await db.list("alice", "tasks")).length, 5, "retries are idempotent");
  const invalid = await rpc("tools/call", {
    name: "create_issue",
    arguments: { title: "Invalid", startAt: "2026-10-16", dueAt: "2026-10-05" },
  });
  assert.equal(invalid.result.isError, true);
  lease.release();
  assert.equal(
    (
      await bridge.routes.request("/", {
        method: "POST",
        headers: { Authorization: `Bearer ${lease.token}` },
      })
    ).status,
    401,
  );
  const second = bridge.lease(tools, abort.signal);
  abort.abort();
  assert.equal(
    (
      await bridge.routes.request("/", {
        method: "POST",
        headers: { Authorization: `Bearer ${second.token}` },
      })
    ).status,
    401,
  );
});

test("MCP registration enables only the current run's Hive tools and fails closed", async () => {
  const bridge = new HiveToolBridge("http://localhost:8787/api/hive-tools");
  const abort = new AbortController();
  const { z } = await import("zod");
  const tools = [
    {
      name: "create_issue",
      description: "Create an issue",
      parameters: z.object({ title: z.string() }),
      execute: async () => ({ ok: true }),
    },
  ];
  let registeredName = "";
  const pool = {
    forDirectory: () => ({
      mcp: {
        add: async (params: { name: string }) => {
          registeredName = params.name;
          return {
            data: { [params.name]: { status: "connected" }, hive_other: { status: "connected" } },
          };
        },
      },
    }),
  };
  const lease = await bridge.connect(
    pool as never,
    "/tmp/workspace",
    "thread-a",
    tools,
    abort.signal,
  );
  assert.equal(lease.flags[`${registeredName}_create_issue`], true);
  assert.equal(lease.flags.hive_other_create_issue, false);
  assert.equal(lease.flags["hive_*"], false);
  lease.release();
  await assert.rejects(
    bridge.connect(
      { forDirectory: () => ({ mcp: { add: async () => ({ error: {} }) } }) } as never,
      "/tmp/workspace",
      "thread-b",
      tools,
      abort.signal,
    ),
    /could not connect/,
  );
  const unauth = await server.app.request("/api/hive-tools", { method: "POST" });
  assert.equal(unauth.status, 401);
  assert.deepEqual(await unauth.json(), { error: "Inactive tool session" });
});
