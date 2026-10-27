import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Accounts } from "../apps/control/src/accounts.ts";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { loadSigningKeys } from "../apps/control/src/signing.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

let db: ControlTestStore;
let directory: string;
const KEY = "a-long-test-passphrase-for-hive";

const app = async (testSignInKey?: string) =>
  createControlApp(
    db,
    {
      mode: "live",
      port: 8800,
      host: "127.0.0.1",
      publicUrl: "https://hive.example.test",
      dataDir: "",
      allowedOrigins: [],
      maxWorkspacesPerAccount: 3,
      googleRedirectUri: "https://hive.example.test/v1/auth/google/callback",
      testSignInKey,
    } satisfies ControlConfig,
    { provisioner: new FakeProvisioner(), keys: await loadSigningKeys(directory, {}) },
  ).app;
const testSignIn = (control: Awaited<ReturnType<typeof app>>, body: object) =>
  control.request("/v1/auth/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-control-test-signin-"));
  db = await createControlStore();
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a passphrase signs in an email address, and says so in the health check", async () => {
  const control = await app(KEY);
  assert.equal((await (await control.request("/health")).json()).testSignIn, true);
  const response = await testSignIn(control, { email: "Tester@Example.com", key: KEY });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.account.email, "tester@example.com");
  const me = await control.request("/v1/me", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(me.status, 200);
});

test("a wrong passphrase, or none set, is refused", async () => {
  const control = await app(KEY);
  assert.equal((await testSignIn(control, { email: "a@example.com", key: "nope" })).status, 401);
  const off = await app();
  assert.equal((await (await off.request("/health")).json()).testSignIn, false);
  assert.equal((await testSignIn(off, { email: "a@example.com", key: KEY })).status, 404);
});

test("an account that has signed in with Google cannot be taken this way", async () => {
  await new Accounts(db).upsert({ email: "real@example.com", googleSub: "google-123" });
  const control = await app(KEY);
  assert.equal((await testSignIn(control, { email: "real@example.com", key: KEY })).status, 403);
});
