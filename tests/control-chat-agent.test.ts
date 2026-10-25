import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import type { GatewaySettings } from "../apps/control/src/gateway.ts";
import { loadSigningKeys, type SigningKeys } from "../apps/control/src/signing.ts";
import {
  CHAT_RUNNER_SECONDS,
  verifyChatRunner,
  verifyChatToken,
} from "../packages/integrations/src/workspace-token.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

const WAKE_KEY = "wake-key-shared-with-the-chat-service";

let db: ControlTestStore;
let directory: string;
let keys: SigningKeys;
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
const gateway: GatewaySettings = {
  providers: {
    anthropic: { baseUrl: "https://api.anthropic.test/v1", key: "sk-real", auth: "x-api-key" },
  },
  model: "anthropic/claude-test",
  presenceMs: 0,
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-control-chat-agent-"));
  db = await createControlStore();
  keys = await loadSigningKeys(directory, {});
  provisioner = new FakeProvisioner();
  control = createControlApp(
    db,
    config({ chatUrl: "https://chat.example.test", chatWakeKey: WAKE_KEY }),
    { provisioner, keys, gateway },
  );
  bare = createControlApp(db, config(), { provisioner, keys, gateway });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

let emails = 0;
/** A ready workspace and the key it was given for the gateway, which is also how it proves itself. */
async function workspace() {
  const email = `agent${++emails}@example.com`;
  const signed = await control.app.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Ip": email },
    body: JSON.stringify({ email }),
  });
  const { token: session } = await signed.json();
  const made = await control.app.request("/v1/workspaces", {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Agent" }),
  });
  const { id } = await made.json();
  await control.workspaces.settled(id);
  const given = JSON.parse(
    provisioner.created.filter((s) => s.workspaceId === id).at(-1)?.modelEnv
      ?.OPENCODE_CONFIG_CONTENT ?? "{}",
  );
  return { id: id as string, key: given.provider.anthropic.options.apiKey as string };
}
const runnerToken = (app: typeof control, id: string, key?: string) =>
  app.app.request(`/v1/release/${id}/runner-token`, {
    method: "POST",
    headers: { "x-client-ip": id, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  });
const wake = (app: typeof control, id: string, over: { at?: number; key?: string } = {}) => {
  const at = String(over.at ?? Date.now());
  const mac = createHmac("sha256", over.key ?? WAKE_KEY)
    .update(`wake\n${id}\n${at}`)
    .digest("hex");
  return app.app.request(`/internal/chat/wake/${id}`, {
    method: "POST",
    headers: { "x-hive-at": at, "x-hive-mac": mac, "x-client-ip": id },
  });
};

test("a workspace's machine is given a token to connect to the chat service with, by proving it is that workspace", async () => {
  const mine = await workspace();
  const other = await workspace();
  const response = await runnerToken(control, mine.id, mine.key);
  assert.equal(response.status, 200);
  const given = (await response.json()) as { token: string; url: string; expiresAt: number };
  assert.equal(given.url, `wss://chat.example.test/w/${mine.id}/agent/v1/connect`);
  assert.ok(given.expiresAt - Date.now() <= CHAT_RUNNER_SECONDS * 1000);
  const verified = verifyChatRunner(keys.publicKey, given.token, { workspaceId: mine.id });
  assert.ok(verified.expiresAt > Date.now());
  // It is the runner's alone: not for another workspace, and not a person's chat token.
  assert.throws(() => verifyChatRunner(keys.publicKey, given.token, { workspaceId: other.id }));
  assert.throws(() => verifyChatToken(keys.publicKey, given.token, { workspaceId: mine.id }));
  // Another workspace's key, or none, gets nothing.
  assert.equal((await runnerToken(control, mine.id, other.key)).status, 401);
  assert.equal((await runnerToken(control, mine.id)).status, 401);
  assert.equal((await runnerToken(control, mine.id, "hwk_nope.nope")).status, 401);
});

test("without a chat service there is no runner token", async () => {
  const mine = await workspace();
  assert.equal((await runnerToken(bare, mine.id, mine.key)).status, 404);
});

test("the chat service can have a stopped workspace started, once it proves it is the chat service", async () => {
  const mine = await workspace();
  const before = provisioner.woken.length;
  const ok = await wake(control, mine.id);
  assert.equal(ok.status, 200);
  assert.equal(provisioner.woken.length, before + 1);
  assert.equal(provisioner.woken.at(-1), mine.id);
  // Not with another key, an old request played again, another workspace's, or a missing proof.
  assert.equal((await wake(control, mine.id, { key: "not-the-key" })).status, 401);
  assert.equal((await wake(control, mine.id, { at: Date.now() - 5 * 60_000 })).status, 401);
  const forged = await control.app.request(`/internal/chat/wake/${mine.id}`, { method: "POST" });
  assert.equal(forged.status, 401);
  const other = await workspace();
  const mac = createHmac("sha256", WAKE_KEY)
    .update(`wake\n${mine.id}\n${Date.now()}`)
    .digest("hex");
  const elsewhere = await control.app.request(`/internal/chat/wake/${other.id}`, {
    method: "POST",
    headers: { "x-hive-at": String(Date.now()), "x-hive-mac": mac },
  });
  assert.equal(elsewhere.status, 401);
  assert.equal(provisioner.woken.length, before + 1);
  // A workspace that is not there is not woken.
  assert.equal((await wake(control, "wnotthere")).status, 409);
});

test("with no wake key set the route is not there", async () => {
  const mine = await workspace();
  assert.equal((await wake(bare, mine.id)).status, 404);
});

test("wakes are rate limited per workspace", async () => {
  const mine = await workspace();
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await wake(control, mine.id)).status);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
});
