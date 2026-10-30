import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ORCHESTRATOR_CHANNEL_ID } from "../packages/domain/src/agent.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
let tokenA = "",
  tokenB = "";

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
const api = (token: string, path: string, body?: unknown, method?: string) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(token),
    ...(method === undefined && body === undefined
      ? {}
      : {
          method: method ?? "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-multitenant-"));
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
  tokenA = (await server.auth.sessionForOwner("google:aaa")).token;
  tokenB = (await server.auth.sessionForOwner("google:bbb")).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});

test("channels are shared: created by one user, visible to another", async () => {
  const created = await api(tokenA, "/channels", { name: "General" });
  assert.equal(created.status, 201);
  const channel = (await created.json()) as { id: string };
  assert.equal(channel.id, "general");

  const listed = await api(tokenB, "/channels", undefined, "GET");
  assert.equal(listed.status, 200);
  const channels = (await listed.json()) as { id: string }[];
  assert.ok(
    channels.some((c) => c.id === "general"),
    "user B sees user A's channel",
  );
  // A second "general" from user B is rejected: ids are global.
  const dup = await api(tokenB, "/channels", { name: "General" });
  assert.equal(dup.status, 409);
});

test("each user gets a private orchestrator", async () => {
  for (const token of [tokenA, tokenB]) {
    const listed = await api(token, "/channels", undefined, "GET");
    const channels = (await listed.json()) as { id: string }[];
    assert.ok(channels.some((c) => c.id === ORCHESTRATOR_CHANNEL_ID));
  }
  const a = await db.get("google:aaa", "channels", ORCHESTRATOR_CHANNEL_ID);
  const b = await db.get("google:bbb", "channels", ORCHESTRATOR_CHANNEL_ID);
  assert.ok(a && b && a !== b, "distinct orchestrator records per user");
});

test("disk layout: shared channels under shared owner, orchestrators per user", async () => {
  await stat(join(directory, "owners", "shared", "channels", "general"));
  await stat(join(directory, "owners", "google-aaa", "channels", "orchestrator"));
  await stat(join(directory, "owners", "google-bbb", "channels", "orchestrator"));
});

test("threads in shared channels are visible to all users", async () => {
  const thread = await server.agent.registerThread("google:aaa", "general", "hello");
  const listed = await server.agent.listChannelThreads("google:bbb", "general");
  assert.ok(
    listed.some((t) => t.threadId === thread.threadId),
    "user B sees user A's thread",
  );
  // Reverse lookup works for both users.
  assert.equal(
    (await server.agent.channelOfThread("google:bbb", thread.threadId))?.channelId,
    "general",
  );
});
