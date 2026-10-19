import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { cloudConfig } from "../apps/control/src/digitalocean.ts";
import { loadSigningKeys } from "../apps/control/src/signing.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

const TOKEN = "r".repeat(40);
const A = { tag: "sha-1111111", digest: `sha256:${"1".repeat(64)}` };
const B = { tag: "sha-2222222", digest: `sha256:${"2".repeat(64)}` };

let db: ControlTestStore;
let directory: string;
let provisioner: FakeProvisioner;
let control: ReturnType<typeof createControlApp>;
let bare: ReturnType<typeof createControlApp>;

const config = (over: Partial<ControlConfig> = {}): ControlConfig => ({
  mode: "sample",
  port: 8800,
  host: "127.0.0.1",
  publicUrl: "https://hive.example.test",
  dataDir: directory,
  allowedOrigins: [],
  maxWorkspacesPerAccount: 3,
  clientIpHeader: "x-client-ip",
  googleRedirectUri: "https://hive.example.test/v1/auth/google/callback",
  ...over,
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-release-"));
  db = await createControlStore();
  const keys = await loadSigningKeys(directory, {});
  provisioner = new FakeProvisioner();
  const mailer = { async sendInvite() {} };
  control = createControlApp(db, config({ releaseToken: TOKEN }), { provisioner, keys, mailer });
  bare = createControlApp(db, config(), { provisioner, keys, mailer });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const operator = (method: string, path: string, body?: unknown, token = TOKEN) =>
  control.app.request(`/internal/release${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const asked = async (workspace: string) =>
  (
    await control.app.request(`/v1/release/${workspace}`, {
      headers: { "x-client-ip": workspace },
    })
  ).json();

test("there is no way to publish a build without a release token", async () => {
  const response = await bare.app.request("/internal/release", {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(A),
  });
  assert.equal(response.status, 404);
});

test("a wrong or missing token is refused", async () => {
  assert.equal((await operator("PUT", "", A, "x".repeat(40))).status, 401);
  const none = await control.app.request("/internal/release", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(A),
  });
  assert.equal(none.status, 401);
});

test("a machine is told nothing until a build is published", async () => {
  assert.deepEqual(await asked("wfirst"), {});
});

test("a published build is what every workspace is told to run", async () => {
  assert.equal((await operator("PUT", "", A)).status, 200);
  assert.deepEqual(await asked("wone"), { ...A, force: false });
  assert.deepEqual(await asked("wtwo"), { ...A, force: false });
});

test("a build that is not well formed is refused, and the one before stays", async () => {
  assert.equal((await operator("PUT", "", { tag: "../x", digest: A.digest })).status, 422);
  assert.equal((await operator("PUT", "", { tag: "ok", digest: "sha256:short" })).status, 422);
  assert.equal((await operator("PUT", "", {})).status, 422);
  assert.deepEqual(await asked("wone"), { ...A, force: false });
});

test("pausing tells every machine without a build of its own nothing, and a push does not undo it", async () => {
  assert.equal((await operator("PUT", "/paused", { paused: true })).status, 200);
  assert.deepEqual(await asked("wone"), {});
  await operator("PUT", "", B);
  assert.deepEqual(await asked("wone"), {}, "still paused after a newer build");
  await operator("PUT", "/paused", { paused: false });
  assert.deepEqual(await asked("wone"), { ...B, force: false });
});

test("a workspace can be given a build of its own, which a push does not move and a pause does not hold", async () => {
  await operator("PUT", "/workspaces/wpinned", A);
  assert.deepEqual(await asked("wpinned"), { ...A, force: false });
  await operator("PUT", "", B);
  assert.deepEqual(await asked("wpinned"), { ...A, force: false });
  assert.deepEqual(await asked("wother"), { ...B, force: false });
  await operator("PUT", "/paused", { paused: true });
  assert.deepEqual(await asked("wpinned"), { ...A, force: false }, "a pin ignores the pause");
  assert.deepEqual(await asked("wother"), {});
  await operator("PUT", "/paused", { paused: false });
  const overview = await (await operator("GET", "")).json();
  assert.deepEqual(overview.default.tag, B.tag);
  assert.deepEqual(
    overview.pins.map((pin: { id: string }) => pin.id),
    ["pin:wpinned"],
  );
  await operator("DELETE", "/workspaces/wpinned");
  assert.deepEqual(await asked("wpinned"), { ...B, force: false }, "back to everyone's build");
});

test("a workspace that is made is told where to ask", async () => {
  const session = await (
    await control.app.request("/v1/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Ip": "owner" },
      body: JSON.stringify({ email: "owner@example.com" }),
    })
  ).json();
  const made = await (
    await control.app.request("/v1/workspaces", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    })
  ).json();
  await control.workspaces.settled(made.id);
  const spec = provisioner.created.at(-1);
  assert.equal(spec?.updateUrl, `https://hive.example.test/v1/release/${made.id}`);
});

test("the machine's first boot writes where it asks, and only when it is told", () => {
  const url = "https://hive.example.test/v1/release/wabc";
  const withUrl = cloudConfig({ A: "b" }, { updateUrl: url });
  assert.ok(withUrl.includes("/etc/hive/updater.json"));
  const written = withUrl.match(/path: \/etc\/hive\/updater.json[\s\S]*?content: (\S+)/)?.[1] ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(written, "base64").toString("utf8")), { wantedUrl: url });
  assert.equal(cloudConfig({ A: "b" }).includes("updater.json"), false);
});
