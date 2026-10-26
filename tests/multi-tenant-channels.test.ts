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

test("shared channel transcripts stamp author names across users", async () => {
  // User records as created by Google sign-in.
  await db.put("system", "users", {
    id: "google:aaa",
    name: "Alice",
    email: "alice@example.com",
  });
  await db.put("system", "users", {
    id: "google:bbb",
    name: "Bob",
    email: "bob@example.com",
  });
  const conv = (token: string, method: string, body?: unknown) =>
    server.app.request("/api/conversation?threadId=channel:general", {
      method,
      headers: headers(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  type Seen = { messages: { id: string; role: string; name?: string }[] };

  // A writes without a name; the server stamps it.
  assert.equal(
    (await conv(tokenA, "PUT", { messages: [{ id: "m1", role: "user", content: "hello" }] }))
      .status,
    200,
  );
  // B reads the shared transcript and sees A's name on A's message.
  const seenByB = (await (await conv(tokenB, "GET")).json()) as Seen;
  assert.equal(seenByB.messages.length, 1);
  assert.equal(seenByB.messages[0].name, "Alice");

  // B appends; merge keeps both messages with their own authors.
  assert.equal(
    (
      await conv(tokenB, "PUT", {
        messages: [
          { id: "m1", role: "user", content: "hello", name: "Alice" },
          { id: "m2", role: "user", content: "hi back" },
        ],
      })
    ).status,
    200,
  );
  const seenByA = (await (await conv(tokenA, "GET")).json()) as Seen;
  assert.deepEqual(
    seenByA.messages.map((m) => [m.id, m.name]),
    [
      ["m1", "Alice"],
      ["m2", "Bob"],
    ],
  );

  // The orchestrator transcript stays private per user.
  const orch = (token: string, method: string, body?: unknown) =>
    server.app.request("/api/conversation?threadId=channel:orchestrator", {
      method,
      headers: headers(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal(
    (await orch(tokenA, "PUT", { messages: [{ id: "o1", role: "user", content: "secret" }] }))
      .status,
    200,
  );
  const orchByB = (await (await orch(tokenB, "GET")).json()) as Seen;
  assert.deepEqual(orchByB.messages, []);
});

test("writers with identical names keep distinct authorship in the database", async () => {
  await db.put("system", "users", { id: "google:aaa", name: "Alex", email: "a1@example.com" });
  await db.put("system", "users", { id: "google:bbb", name: "Alex", email: "a2@example.com" });
  const conv = (token: string, method: string, body?: unknown) =>
    server.app.request("/api/conversation?threadId=channel:names", {
      method,
      headers: headers(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal(
    (await conv(tokenA, "PUT", { messages: [{ id: "n1", role: "user", content: "one" }] })).status,
    200,
  );
  assert.equal(
    (await conv(tokenB, "PUT", { messages: [{ id: "n2", role: "user", content: "two" }] })).status,
    200,
  );
  const seen = (await (await conv(tokenA, "GET")).json()) as {
    messages: { id: string; name?: string }[];
  };
  // Same display name, but the sidecar records two distinct writers.
  assert.deepEqual(
    seen.messages.map((m) => [m.id, m.name]),
    [
      ["n1", "Alex"],
      ["n2", "Alex"],
    ],
  );
  const sidecar =
    (await db.get<{ authors?: Record<string, string> }>(
      "shared",
      "conversation-authors",
      "channel:names",
    )) ?? {};
  assert.deepEqual(sidecar.authors, { n1: "google:aaa", n2: "google:bbb" });
});
