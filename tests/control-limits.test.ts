import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { RateLimiter } from "../apps/control/src/limits.ts";
import { loadSigningKeys } from "../apps/control/src/signing.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

let db: ControlTestStore;
let directory: string;

const config = (over: Partial<ControlConfig> = {}): ControlConfig => ({
  mode: "sample",
  port: 8800,
  host: "127.0.0.1",
  publicUrl: "https://hive.example.test",
  dataDir: "",
  allowedOrigins: [],
  maxWorkspacesPerAccount: 3,
  googleRedirectUri: "https://hive.example.test/v1/auth/google/callback",
  ...over,
});
const app = async (over: Partial<ControlConfig> = {}) =>
  createControlApp(db, config(over), {
    provisioner: new FakeProvisioner(),
    keys: await loadSigningKeys(directory, {}),
  }).app;
const signIn = (control: Awaited<ReturnType<typeof app>>, headers: Record<string, string> = {}) =>
  control.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email: "ada@example.com" }),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-control-limits-"));
  db = await createControlStore();
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("sign-in attempts are limited per visitor, so one cannot lock the others out", async () => {
  const control = await app({ clientIpHeader: "x-client-ip" });
  for (let i = 0; i < 20; i++)
    assert.equal((await signIn(control, { "X-Client-Ip": "noisy" })).status, 200);
  const refused = await signIn(control, { "X-Client-Ip": "noisy" });
  assert.equal(refused.status, 429);
  assert.match((await refused.json()).error, /Too many/);
  assert.equal((await signIn(control, { "X-Client-Ip": "someone-else" })).status, 200);
});

test("without a header naming the visitor, they are all counted as one", async () => {
  const control = await app();
  for (let i = 0; i < 20; i++) assert.equal((await signIn(control)).status, 200);
  assert.equal((await signIn(control)).status, 429);
  // A header that is not the one configured does not make anyone a new visitor.
  assert.equal((await signIn(control, { "X-Client-Ip": "other" })).status, 429);
});

test("the limiter counts in windows and forgets the oldest visitors when it is full", () => {
  const limiter = new RateLimiter(2, 1000, 3);
  assert.deepEqual(
    [0, 10, 20].map((at) => limiter.allow("a", at)),
    [true, true, false],
  );
  assert.equal(limiter.allow("a", 1000), true); // a new window
  assert.equal(limiter.allow("a", 1001), true);
  assert.equal(limiter.allow("a", 1002), false); // used up again
  // Over capacity, the oldest visitor is forgotten rather than the memory growing.
  for (const key of ["b", "c", "d"]) assert.equal(limiter.allow(key, 1100), true);
  assert.equal(limiter.allow("a", 1200), true);
});
