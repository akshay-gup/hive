import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentMachineView } from "../packages/domain/src/agent.ts";
import { localBoard } from "./helpers/local-task.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
let config: Config;
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
  directory = await mkdtemp(join(tmpdir(), "hive-agent-api-"));
  db = await createStore({ dataDir: join(directory, "db") });
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  // The board is the chat service's: here it is played by the machine's own copies of the tasks.
  server.agent.board = localBoard(server.agent);
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

test("agent API requires a session and reports the actual worker state", async () => {
  assert.equal((await server.app.request("/api/agent")).status, 401);
  assert.equal(
    (
      await server.app.request("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Plan the week" }),
      })
    ).status,
    401,
  );
  const workspace = await read<AgentMachineView>("");
  assert.equal(workspace.worker.running, false);
  assert.equal(workspace.identity.name, "Hive");
  assert.equal(workspace.identity.tone, "warm");
});

test("agent request validation rejects malformed input with useful JSON errors", async () => {
  for (const [path, body] of [["/identity", { name: "Hive", tone: "angry" }]] satisfies [
    string,
    unknown,
  ][]) {
    const response = await request(path, body);
    assert.equal(response.status, 422, path);
    assert.equal(typeof (await response.json()).error, "string", path);
  }
});

test("the agent's identity changes persist and are the team's", async () => {
  await read("/identity", {
    name: "Nova",
    tone: "concise",
    avatar: "lilac",
    showChatUpdates: false,
  });
  const snapshot = await read<AgentMachineView>("");
  assert.equal(snapshot.identity.name, "Nova");
  assert.equal(snapshot.identity.tone, "concise");
  assert.equal(snapshot.identity.avatar, "lilac");
  assert.equal(snapshot.identity.showChatUpdates, false);
  assert.equal(
    (await request("/identity", { name: "Nova", tone: "warm", avatar: "invalid" })).status,
    422,
  );
  // The agent's personality is the team's too.
  assert.equal(
    (await db.get<{ name: string }>("other-user", "agent-settings", "identity"))?.name,
    "Nova",
  );
});

test("ideas are delivered to chat instead of being stored or decided on the machine", async () => {
  let count = 0;
  server.agent.publishIdeas = async (batch) => {
    count = batch.ideas.length;
  };
  assert.deepEqual(await read("/ideas/refresh", {}), { queued: true });
  assert.ok(count >= 2);
  assert.deepEqual((await read<AgentMachineView>("")).ideas, []);
  assert.equal((await db.list("shared", "ideas")).length, 0);
  assert.equal((await request("/ideas/missing", { action: "accept" })).status, 404);
});

test("saved sessions validate and logout revokes only the current token", async () => {
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const separateToken = (await session.json()).token;
  const authHeaders = { Authorization: `Bearer ${separateToken}` };
  assert.equal(
    (await server.app.request("/api/auth/session", { headers: authHeaders })).status,
    200,
  );
  assert.equal((await server.app.request("/api/auth/session")).status, 401);
  assert.equal(
    (await server.app.request("/api/auth/logout", { method: "POST", headers: authHeaders })).status,
    200,
  );
  assert.equal(
    (await server.app.request("/api/auth/session", { headers: authHeaders })).status,
    401,
  );
  assert.equal((await server.app.request("/api/auth/session", { headers: headers() })).status, 200);
});
