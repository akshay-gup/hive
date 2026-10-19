import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { MANAGED_SESSION_MS } from "../apps/server/src/managed.ts";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../packages/integrations/src/workspace-token.ts";

const keys = generateWorkspaceKeys();
const workspaceId = "w1abc";
let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let directory: string;

const token = (
  over: { role?: WorkspaceRole; id?: string; now?: number; workspace?: string } = {},
) =>
  signWorkspaceToken(keys.privateKey, {
    workspaceId: over.workspace ?? workspaceId,
    sub: over.id ?? "acct_ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: over.role ?? "member",
    now: over.now,
  });
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const signIn = (value: string) => post("/api/auth/managed", { token: value });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-managed-"));
  db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://w1abc.example.test",
    dataDir: directory,
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "https://w1abc.example.test/api/google/callback",
    allowedOrigins: ["https://app.example.test"],
    managed: { workspaceId, controlPublicKey: keys.publicKey },
  };
  ({ app } = await createApp(db, config));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a person the control plane vouches for gets a session in this workspace", async () => {
  const response = await signIn(token());
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.mode, "live");
  // It says when the session ends, so the app can renew it in time.
  assert.ok(Math.abs(session.expiresAt - (Date.now() + MANAGED_SESSION_MS)) < 5000);
  assert.deepEqual(session.user, {
    id: "acct:acct_ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "member",
  });
  const check = await app.request("/api/auth/session", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(check.status, 200);
  assert.deepEqual(await check.json(), { authenticated: true });
});

test("the session lasts an hour, so a person removed from the workspace loses access soon", async () => {
  const session = await (await signIn(token({ id: "acct_hour" }))).json();
  const stored = await db.get<{ expiresAt: number }>(
    "system",
    "sessions",
    createHash("sha256").update(session.token).digest("hex"),
  );
  assert.ok(stored);
  const left = stored.expiresAt - Date.now();
  assert.ok(left > MANAGED_SESSION_MS - 10_000 && left <= MANAGED_SESSION_MS, `${left} ms left`);
});

test("the person and their role are kept, and a new role is picked up at the next sign-in", async () => {
  await signIn(token({ id: "acct_grace", role: "member" }));
  const first = await db.get<{ role: string; createdAt: string; email: string }>(
    "system",
    "users",
    "acct:acct_grace",
  );
  assert.equal(first?.role, "member");
  assert.equal(first?.email, "ada@example.com");
  await signIn(token({ id: "acct_grace", role: "admin" }));
  const second = await db.get<{ role: string; createdAt: string }>(
    "system",
    "users",
    "acct:acct_grace",
  );
  assert.equal(second?.role, "admin");
  assert.equal(second?.createdAt, first?.createdAt);
});

test("a token works once", async () => {
  const value = token({ id: "acct_once" });
  assert.equal((await signIn(value)).status, 200);
  const again = await signIn(value);
  assert.equal(again.status, 401);
  assert.match((await again.json()).error, /already used/);
});

test("a token that is forged, for another workspace, or out of date is refused", async () => {
  const other = generateWorkspaceKeys();
  const forged = signWorkspaceToken(other.privateKey, {
    workspaceId,
    sub: "acct_mallory",
    email: "m@example.com",
    name: "Mallory",
    role: "owner",
  });
  assert.equal((await signIn(forged)).status, 401);
  const elsewhere = await signIn(token({ workspace: "w2xyz" }));
  assert.equal(elsewhere.status, 401);
  assert.match((await elsewhere.json()).error, /different workspace/);
  const stale = await signIn(token({ now: Date.now() - 10 * 60_000 }));
  assert.equal(stale.status, 401);
  assert.match((await stale.json()).error, /expired/);
  assert.equal((await signIn("not.a.token")).status, 401);
  assert.equal((await post("/api/auth/managed", {})).status, 422);
  assert.equal((await post("/api/auth/managed", { token: "x".repeat(5000) })).status, 422);
});

test("a managed workspace has no other way in", async () => {
  assert.equal((await post("/api/session", {})).status, 401);
  const google = await app.request("/api/auth/google/url");
  assert.equal(google.status, 404);
  assert.match((await google.json()).error, /Hive account/);
  assert.equal((await app.request("/api/workspace")).status, 401);
});

test("health says which workspace this is", async () => {
  const health = await (await app.request("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.version, "string");
  assert.ok(health.features.includes("notifications-dismiss"));
  assert.equal(health.managed, true);
  assert.equal(health.workspace, workspaceId);
});

test("a workspace that is not managed has no managed sign-in, and says nothing of it", async () => {
  const plainDir = await mkdtemp(join(tmpdir(), "hive-plain-"));
  const plainDb = await createStore();
  try {
    const { app: plain } = await createApp(plainDb, {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: plainDir,
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
    });
    const response = await plain.request("/api/auth/managed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token() }),
    });
    assert.equal(response.status, 404);
    const health = await (await plain.request("/api/health")).json();
    assert.equal("managed" in health, false);
    assert.equal("workspace" in health, false);
  } finally {
    await plainDb.close();
    await rm(plainDir, { recursive: true, force: true });
  }
});
