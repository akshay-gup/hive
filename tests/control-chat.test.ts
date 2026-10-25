import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { plans } from "../apps/control/src/plans.ts";
import { loadSigningKeys, type SigningKeys } from "../apps/control/src/signing.ts";
import {
  verifyChatPeople,
  verifyChatPurge,
  verifyChatRevocation,
  verifyChatToken,
} from "../packages/integrations/src/workspace-token.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

let db: ControlTestStore;
let directory: string;
let keys: SigningKeys;
let control: ReturnType<typeof createControlApp>;
let bare: ReturnType<typeof createControlApp>;
/** What the control plane told the chat service. */
const toChat: { workspace: string; action: string; token: string; body: unknown }[] = [];
let chatDown = false;

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
  directory = await mkdtemp(join(tmpdir(), "hive-control-chat-"));
  db = await createControlStore();
  keys = await loadSigningKeys(directory, {});
  const provisioner = new FakeProvisioner();
  const fetcher: typeof fetch = async (url, init) => {
    const match = /^https:\/\/chat-internal\.example\.test\/w\/([^/]+)\/internal\/(\w+)$/.exec(
      String(url),
    );
    if (!match) return new Response("{}");
    if (chatDown) throw new Error("offline");
    toChat.push({
      workspace: match[1] ?? "",
      action: match[2] ?? "",
      token: String((init?.headers as Record<string, string> | undefined)?.authorization).slice(7),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response("{}");
  };
  control = createControlApp(
    db,
    config({
      chatUrl: "https://chat.example.test",
      chatInternalUrl: "https://chat-internal.example.test",
    }),
    { provisioner, keys, fetch: fetcher },
  );
  bare = createControlApp(db, config(), { provisioner, keys });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function signIn(app: typeof control, email: string, name?: string) {
  const response = await app.app.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Ip": email },
    body: JSON.stringify({ email, name }),
  });
  const session = await response.json();
  const call = (method: string, path: string, body?: unknown) =>
    app.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    account: session.account as { id: string; email: string; name: string },
    post: (path: string, body?: unknown) => call("POST", path, body ?? {}),
    del: (path: string) => call("DELETE", path),
  };
}
type Person = Awaited<ReturnType<typeof signIn>>;

async function workspace(owner: Person) {
  const made = await owner.post("/v1/workspaces", { name: "Acme" });
  const { id } = await made.json();
  await control.workspaces.settled(id);
  return id as string;
}
/** The people the control plane said were in a workspace. */
const rosterOf = (call: { body: unknown } | undefined) =>
  ((call?.body ?? { people: [] }) as { people: { email: string; role: string }[] }).people;
const chatTo = (workspace: string, action: string) =>
  toChat.filter((c) => c.workspace === workspace && c.action === action);

test("a member gets a chat token for the chat service, with their role and the plan's limits", async () => {
  const owner = await signIn(control, "chat-owner@example.com", "Olive");
  const id = await workspace(owner);
  const response = await owner.post(`/v1/workspaces/${id}/chat-token`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url, `https://chat.example.test/w/${id}`);
  assert.equal(body.wsUrl, `wss://chat.example.test/w/${id}/v1/ws`);
  const claims = verifyChatToken(keys.publicKey, body.token, { workspaceId: id });
  assert.deepEqual([claims.sub, claims.role], [owner.account.id, "owner"]);
  assert.deepEqual(claims.limits, {
    maxFileBytes: plans.free.maxFileBytes,
    storageBytes: plans.free.storageBytes,
  });
  assert.equal(plans.free.maxFileBytes, 25 * 1024 ** 2);
  assert.equal(plans.free.storageBytes, 10 * 1024 ** 3);
});

test("someone who is not in the workspace gets no chat token", async () => {
  const owner = await signIn(control, "chat-owner2@example.com", "Olive");
  const stranger = await signIn(control, "chat-stranger@example.com", "Sam");
  const id = await workspace(owner);
  assert.equal((await stranger.post(`/v1/workspaces/${id}/chat-token`)).status, 404);
});

test("without a chat service there is no chat token", async () => {
  const owner = await signIn(bare, "chat-bare@example.com", "Olive");
  const made = await owner.post("/v1/workspaces", { name: "Bare" });
  const { id } = await made.json();
  await bare.workspaces.settled(id);
  assert.equal((await owner.post(`/v1/workspaces/${id}/chat-token`)).status, 404);
});

test("the chat service is told who is in the workspace the first time, and again when that changes", async () => {
  const owner = await signIn(control, "chat-owner3@example.com", "Olive");
  const guest = await signIn(control, "chat-guest3@example.com", "Gus");
  const id = await workspace(owner);
  assert.equal(chatTo(id, "people").length, 0, "nothing until someone opens chat");
  await owner.post(`/v1/workspaces/${id}/chat-token`);
  await owner.post(`/v1/workspaces/${id}/chat-token`);
  assert.equal(chatTo(id, "people").length, 1, "once");
  const first = chatTo(id, "people")[0];
  assert.doesNotThrow(() =>
    verifyChatPeople(keys.publicKey, first?.token ?? "", { workspaceId: id }),
  );
  assert.deepEqual(
    rosterOf(first).map((p) => [p.email, p.role]),
    [["chat-owner3@example.com", "owner"]],
  );
  // Someone who joins is added to what it knows.
  const made = await (await owner.post(`/v1/workspaces/${id}/invites`, { role: "guest" })).json();
  await guest.post(`/v1/invites/${String(made.link).split("/").pop()}/accept`);
  const latest = chatTo(id, "people").at(-1);
  assert.deepEqual(
    rosterOf(latest)
      .map((p) => p.email)
      .sort(),
    ["chat-guest3@example.com", "chat-owner3@example.com"],
  );
});

test("removing someone ends their chat access and updates who is known", async () => {
  const owner = await signIn(control, "chat-owner4@example.com", "Olive");
  const member = await signIn(control, "chat-member4@example.com", "Max");
  const id = await workspace(owner);
  const made = await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json();
  await member.post(`/v1/invites/${String(made.link).split("/").pop()}/accept`);
  const before = chatTo(id, "revoke").length;
  assert.equal((await owner.del(`/v1/workspaces/${id}/members/${member.account.id}`)).status, 200);
  const revoke = chatTo(id, "revoke");
  assert.equal(revoke.length, before + 1);
  assert.equal(
    verifyChatRevocation(keys.publicKey, revoke.at(-1)?.token ?? "", { workspaceId: id }).sub,
    member.account.id,
  );
  assert.deepEqual(
    rosterOf(chatTo(id, "people").at(-1)).map((p) => p.email),
    ["chat-owner4@example.com"],
  );
  // And they cannot get another token.
  assert.equal((await member.post(`/v1/workspaces/${id}/chat-token`)).status, 404);
});

test("deleting a workspace clears its chat out", async () => {
  const owner = await signIn(control, "chat-owner5@example.com", "Olive");
  const id = await workspace(owner);
  assert.equal((await owner.del(`/v1/workspaces/${id}`)).status, 200);
  const purge = chatTo(id, "purge");
  assert.equal(purge.length, 1);
  assert.doesNotThrow(() =>
    verifyChatPurge(keys.publicKey, purge[0]?.token ?? "", { workspaceId: id }),
  );
});

test("a chat service that cannot be reached does not stop people being removed", async () => {
  const owner = await signIn(control, "chat-owner6@example.com", "Olive");
  const member = await signIn(control, "chat-member6@example.com", "Max");
  const id = await workspace(owner);
  const made = await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json();
  await member.post(`/v1/invites/${String(made.link).split("/").pop()}/accept`);
  chatDown = true;
  try {
    assert.equal(
      (await owner.del(`/v1/workspaces/${id}/members/${member.account.id}`)).status,
      200,
    );
  } finally {
    chatDown = false;
  }
});

test("the key the control plane's tokens are checked with is public, and is the one it signs with", async () => {
  const response = await control.app.request("/v1/public-key");
  assert.equal(response.status, 200);
  const { publicKey } = (await response.json()) as { publicKey: string };
  assert.equal(publicKey, keys.publicKey);
  assert.equal(
    JSON.stringify(await (await control.app.request("/v1/public-key")).json()).includes("PRIVATE"),
    false,
  );
});
