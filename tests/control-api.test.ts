import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { loadSigningKeys, type SigningKeys } from "../apps/control/src/signing.ts";
import {
  verifyRevocation,
  verifyWorkspaceToken,
} from "../packages/integrations/src/workspace-token.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

let db: ControlTestStore;
let directory: string;
let keys: SigningKeys;
let provisioner: FakeProvisioner;
let control: ReturnType<typeof createControlApp>;
const sent: { to: string; link: string; workspaceName: string }[] = [];
/** What the control plane told workspaces: whose sessions are over. */
const revoked: { url: string; token: string }[] = [];

const config = (over: Partial<ControlConfig> = {}): ControlConfig => ({
  mode: "sample",
  port: 8800,
  host: "127.0.0.1",
  publicUrl: "https://hive.example.test",
  dataDir: directory,
  allowedOrigins: ["https://other.example.test"],
  maxWorkspacesPerAccount: 3,
  clientIpHeader: "x-client-ip",
  googleRedirectUri: "https://hive.example.test/v1/auth/google/callback",
  ...over,
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-control-"));
  db = await createControlStore();
  keys = await loadSigningKeys(directory, {});
  provisioner = new FakeProvisioner();
  control = createControlApp(db, config(), {
    provisioner,
    keys,
    fetch: async (url, init) => {
      revoked.push({ url: String(url), token: JSON.parse(String(init?.body)).token });
      return new Response("{}");
    },
    mailer: {
      async sendInvite(mail) {
        sent.push(mail);
      },
    },
  });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

/** A signed-in person's calls. */
function person(token: string) {
  const call = (method: string, path: string, body?: unknown) =>
    control.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    token,
    get: (path: string) => call("GET", path),
    post: (path: string, body?: unknown) => call("POST", path, body ?? {}),
    patch: (path: string, body: unknown) => call("PATCH", path, body),
    del: (path: string) => call("DELETE", path),
  };
}
async function signIn(email: string, name?: string) {
  const response = await control.app.request("/v1/auth/dev", {
    method: "POST",
    // Each person comes from an address of their own, as they would in life.
    headers: { "Content-Type": "application/json", "X-Client-Ip": email },
    body: JSON.stringify({ email, name }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  return {
    ...person(session.token),
    account: session.account as { id: string; email: string; name: string },
  };
}
/** A workspace made and ready. */
async function readyWorkspace(owner: Awaited<ReturnType<typeof signIn>>, name = "Acme") {
  const response = await owner.post("/v1/workspaces", { name });
  assert.equal(response.status, 201);
  const workspace = await response.json();
  await control.workspaces.settled(workspace.id);
  return workspace.id as string;
}

test("people sign in without Google only on a sample control plane", async () => {
  const ada = await signIn("Ada@Example.com", "Ada Lovelace");
  assert.equal(ada.account.email, "ada@example.com");
  assert.equal(ada.account.name, "Ada Lovelace");
  // The same person again is the same account.
  const again = await signIn("ada@example.com");
  assert.equal(again.account.id, ada.account.id);
  assert.equal(again.account.name, "Ada Lovelace");
  const me = await (await ada.get("/v1/me")).json();
  assert.equal(me.account.id, ada.account.id);
  assert.deepEqual(me.workspaces, []);
  // The app is told how many workspaces a person may be in, so it offers no more.
  assert.equal(me.maxWorkspaces, 3);

  const live = createControlApp(db, config({ mode: "live" }), { provisioner, keys });
  const refused = await live.app.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "x@example.com" }),
  });
  assert.equal(refused.status, 404);
  assert.equal(
    (
      await control.app.request("/v1/auth/dev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not an email" }),
      })
    ).status,
    422,
  );
});

test("everything needs a session, and a session can end", async () => {
  assert.equal((await control.app.request("/v1/me")).status, 401);
  const forged = person("not-a-session");
  assert.equal((await forged.get("/v1/me")).status, 401);
  const grace = await signIn("grace@example.com");
  assert.equal((await grace.get("/v1/me")).status, 200);
  assert.equal((await grace.post("/v1/auth/logout")).status, 200);
  assert.equal((await grace.get("/v1/me")).status, 401);
});

test("a web page from another origin is refused, and the app's own is allowed", async () => {
  const refused = await control.app.request("/health", {
    headers: { Origin: "https://evil.test" },
  });
  assert.equal(refused.status, 403);
  const ours = await control.app.request("/health", {
    headers: { Origin: "https://hive.example.test" },
  });
  assert.equal(ours.status, 200);
  const configured = await control.app.request("/health", {
    headers: { Origin: "https://other.example.test" },
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(await ours.json(), {
    ok: true,
    mode: "sample",
    google: false,
    provisioner: "fake",
  });
});

test("creating a workspace starts it, and it becomes ready with an address", async () => {
  const owner = await signIn("owner1@example.com", "Olive");
  let release: () => void = () => {};
  provisioner.hold = new Promise((resolve) => {
    release = resolve;
  });
  const created = await owner.post("/v1/workspaces", { name: "  Acme Inc  " });
  assert.equal(created.status, 201);
  const workspace = await created.json();
  assert.match(workspace.id, /^w[a-hj-km-np-tv-z2-9]{10}$/);
  assert.equal(workspace.name, "Acme Inc");
  assert.equal(workspace.status, "provisioning");
  assert.equal(workspace.role, "owner");
  assert.equal("url" in workspace, false);
  // Not ready: there is nothing to sign in to yet.
  assert.equal((await owner.post(`/v1/workspaces/${workspace.id}/token`)).status, 409);
  release();
  provisioner.hold = undefined;
  await control.workspaces.settled(workspace.id);
  const ready = await (await owner.get(`/v1/workspaces/${workspace.id}`)).json();
  assert.equal(ready.status, "ready");
  assert.equal(ready.url, `https://${workspace.id}.fake.test`);

  const spec = provisioner.created.find((s) => s.workspaceId === workspace.id);
  assert.ok(spec);
  assert.equal(spec.name, "Acme Inc");
  assert.equal(spec.controlPublicKey, keys.publicKey);
  assert.equal(spec.plan.id, "free");
  assert.deepEqual(spec.allowedOrigins, [
    "https://hive.example.test",
    "https://other.example.test",
  ]);
  const listed = (await (await owner.get("/v1/me")).json()).workspaces;
  assert.deepEqual(
    listed.map((w: { id: string }) => w.id),
    [workspace.id],
  );
});

const EDGE_TOKEN = "e".repeat(40);

test("the edge asks where a workspace is, with a token only it has", async () => {
  const edge = createControlApp(db, config({ edgeToken: EDGE_TOKEN }), { provisioner, keys });
  // `null` is no token at all; leaving it out is the right one.
  const ask = (id: string, token: string | null = EDGE_TOKEN) =>
    edge.app.request(`/internal/upstream/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  const owner = await signIn("edge-owner@example.com");
  const id = await readyWorkspace(owner, "Edge");

  // A control plane with no edge has no such route, whoever asks.
  const bare = await control.app.request(`/internal/upstream/${id}`, {
    headers: { Authorization: `Bearer ${EDGE_TOKEN}` },
  });
  assert.equal(bare.status, 404);
  // Nobody else gets an answer: not without a token, not with a wrong one, not with a person's session.
  assert.equal((await ask(id, null)).status, 401);
  assert.equal((await ask(id, "wrong")).status, 401);
  assert.equal((await ask(id, EDGE_TOKEN.slice(1))).status, 401);
  assert.equal((await ask(id, owner.token)).status, 401);
  assert.deepEqual(
    provisioner.upstreamAsked.filter((asked) => asked === id),
    [],
  );

  const found = await ask(id);
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { upstream: `http://${id}.upstream.test:8787` });
  assert.equal(found.headers.get("cache-control"), "no-store");

  // Made and ready, but stopped to save money: known, and not running.
  provisioner.stop(id);
  const stopped = await ask(id);
  assert.equal(stopped.status, 503);
  assert.match((await stopped.json()).error, /not running/);
  await provisioner.wake(id);
  assert.equal((await ask(id)).status, 200);
});

test("the host is asked where a workspace is only when it is being made or is ready", async () => {
  const edge = createControlApp(db, config({ edgeToken: EDGE_TOKEN }), { provisioner, keys });
  const ask = (id: string) =>
    edge.app.request(`/internal/upstream/${id}`, {
      headers: { Authorization: `Bearer ${EDGE_TOKEN}` },
    });
  const before = provisioner.upstreamAsked.length;
  assert.equal((await ask("wnobodyhas1")).status, 404);
  assert.equal((await ask("x".repeat(65))).status, 422);

  // One being made is looked for: making it ends when it answers at its address, through the edge.
  const owner = await signIn("edge-owner2@example.com");
  let release: () => void = () => {};
  provisioner.hold = new Promise((resolve) => {
    release = resolve;
  });
  const made = await (await owner.post("/v1/workspaces", { name: "Slow" })).json();
  assert.equal((await ask(made.id)).status, 503);
  release();
  provisioner.hold = undefined;
  await control.workspaces.settled(made.id);
  assert.equal((await ask(made.id)).status, 200);

  // One that failed is not.
  provisioner.failCreates = 1;
  const broken = await (await owner.post("/v1/workspaces", { name: "Broken" })).json();
  await control.workspaces.settled(broken.id);
  assert.equal((await ask(broken.id)).status, 404);
  assert.deepEqual(provisioner.upstreamAsked.slice(before), [made.id, made.id]);
});

test("with one workspace allowed, a person cannot make or join a second, and a refused link is not used up", async () => {
  const solo = createControlApp(db, config({ maxWorkspacesPerAccount: 1 }), { provisioner, keys });
  const as = (token: string, method: string, path: string, body?: unknown) =>
    solo.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const olive = await signIn("solo1@example.com");
  const sam = await signIn("solo2@example.com");

  const first = await (await as(olive.token, "POST", "/v1/workspaces", { name: "First" })).json();
  await solo.workspaces.settled(first.id);
  const second = await as(olive.token, "POST", "/v1/workspaces", { name: "Second" });
  assert.equal(second.status, 403);
  assert.match((await second.json()).error, /only one workspace/);

  // Joining counts the same as making.
  const other = await (await as(sam.token, "POST", "/v1/workspaces", { name: "Other" })).json();
  await solo.workspaces.settled(other.id);
  const link = (
    await (await as(sam.token, "POST", `/v1/workspaces/${other.id}/invites`, {})).json()
  ).link as string;
  const token = link.split("/").pop();
  const refused = await as(olive.token, "POST", `/v1/invites/${token}/accept`);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /only one workspace/);
  const invite = (await db.list("control", "invites")).find(
    (i) => (i as { workspaceId: string }).workspaceId === other.id,
  ) as { uses: number };
  assert.equal(invite.uses, 0);
  // Asking to join the one she is already in is not a second.
  const own = await (
    await as(olive.token, "POST", `/v1/workspaces/${first.id}/invites`, {})
  ).json();
  assert.equal(
    (await as(olive.token, "POST", `/v1/invites/${own.link.split("/").pop()}/accept`)).status,
    200,
  );

  // Deleting hers makes room for the other.
  assert.ok((await as(olive.token, "DELETE", `/v1/workspaces/${first.id}`)).ok);
  const joined = await as(olive.token, "POST", `/v1/invites/${token}/accept`);
  assert.equal(joined.status, 200);
  assert.equal((await joined.json()).id, other.id);
});

test("names are checked, and a person can have only so many workspaces", async () => {
  const owner = await signIn("owner2@example.com");
  for (const name of ["", "   ", "x".repeat(61), "bad\u0007name"])
    assert.equal((await owner.post("/v1/workspaces", { name })).status, 422, JSON.stringify(name));
  for (const name of ["One", "Two", "Three"]) await readyWorkspace(owner, name);
  const fourth = await owner.post("/v1/workspaces", { name: "Four" });
  assert.equal(fourth.status, 403);
  assert.match((await fourth.json()).error, /up to 3 workspaces/);
});

test("the token it gives is for that workspace, that person and their role", async () => {
  const owner = await signIn("owner3@example.com", "Olive");
  const id = await readyWorkspace(owner);
  const response = await owner.post(`/v1/workspaces/${id}/token`);
  assert.equal(response.status, 200);
  const { token, url, expiresAt } = await response.json();
  assert.equal(url, `https://${id}.fake.test`);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 61_000);
  const verified = verifyWorkspaceToken(keys.publicKey, token, { workspaceId: id });
  assert.equal(verified.sub, owner.account.id);
  assert.equal(verified.email, "owner3@example.com");
  assert.equal(verified.name, "Olive");
  assert.equal(verified.role, "owner");
  assert.throws(() => verifyWorkspaceToken(keys.publicKey, token, { workspaceId: "wother" }));
});

test("someone who is not in a workspace cannot see it, and it looks like it is not there", async () => {
  const owner = await signIn("owner4@example.com");
  const outsider = await signIn("outsider4@example.com");
  const id = await readyWorkspace(owner);
  for (const path of [
    `/v1/workspaces/${id}`,
    `/v1/workspaces/${id}/members`,
    `/v1/workspaces/${id}/invites`,
  ])
    assert.equal((await outsider.get(path)).status, 404, path);
  assert.equal((await outsider.post(`/v1/workspaces/${id}/token`)).status, 404);
  assert.equal((await outsider.post(`/v1/workspaces/${id}/invites`, {})).status, 404);
  assert.equal((await outsider.del(`/v1/workspaces/${id}`)).status, 404);
  assert.equal((await outsider.get("/v1/workspaces/wdoesnotexist")).status, 404);
});

test("a workspace being made says how far it has got, and stops saying so when it is done", async () => {
  const owner = await signIn("steps1@example.com", "Stella");
  let release: () => void = () => {};
  provisioner.hold = new Promise((resolve) => {
    release = resolve;
  });
  provisioner.reportSteps = ["address", "machine"];
  const created = await (await owner.post("/v1/workspaces", { name: "Steps" })).json();
  // Nothing is known the moment it is asked for.
  assert.equal("step" in created, false);
  let view: { status: string; step?: string } = created;
  for (let tries = 0; tries < 100 && view.step !== "machine"; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    view = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
  }
  assert.equal(view.status, "provisioning");
  assert.equal(view.step, "machine");
  release();
  provisioner.hold = undefined;
  provisioner.reportSteps = [];
  await control.workspaces.settled(created.id);
  const ready = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
  assert.equal(ready.status, "ready");
  assert.equal("step" in ready, false);
});

test("a workspace that fails, or is tried again, does not keep the step it stopped at", async () => {
  const owner = await signIn("steps2@example.com", "Stan");
  provisioner.reportSteps = ["address", "machine"];
  provisioner.failCreates = 1;
  const created = await (await owner.post("/v1/workspaces", { name: "Steps" })).json();
  await control.workspaces.settled(created.id);
  const failed = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
  assert.equal(failed.status, "failed");
  assert.equal("step" in failed, false);
  provisioner.reportSteps = [];
  const retried = await (await owner.post(`/v1/workspaces/${created.id}/retry`)).json();
  assert.equal(retried.status, "provisioning");
  assert.equal("step" in retried, false);
  await control.workspaces.settled(created.id);
});

test("a workspace the provider has no room for is tried again by the timer, not failed at once", async () => {
  const owner = await signIn("room1@example.com", "Rory");
  const logged = mock.method(console, "error", () => {});
  try {
    provisioner.failCapacity = 1;
    const created = await (await owner.post("/v1/workspaces", { name: "Crowded" })).json();
    await control.workspaces.settled(created.id);
    const waiting = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
    assert.equal(waiting.status, "provisioning");
    assert.equal("error" in waiting, false);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /no room for .* yet, trying again/);
    // The timer starts it again, and this time there is room.
    await control.workspaces.resume();
    await control.workspaces.settled(created.id);
    const ready = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
    assert.equal(ready.status, "ready");
  } finally {
    provisioner.failCapacity = 0;
    logged.mock.restore();
  }
});

test("a workspace the provider keeps having no room for fails after fifteen minutes, in words that fit", async () => {
  const owner = await signIn("room2@example.com", "Ronnie");
  const logged = mock.method(console, "error", () => {});
  try {
    provisioner.failCapacity = 5;
    const created = await (await owner.post("/v1/workspaces", { name: "Packed" })).json();
    await control.workspaces.settled(created.id);
    // Not yet, however many times it is tried.
    await control.workspaces.resume();
    await control.workspaces.settled(created.id);
    assert.equal(
      (await (await owner.get(`/v1/workspaces/${created.id}`)).json()).status,
      "provisioning",
    );
    // Pretend it has been waiting a long time.
    await db.compareAndSwap(
      "control",
      "workspaces",
      created.id,
      { status: "provisioning" },
      { updatedAt: new Date(Date.now() - 16 * 60_000).toISOString() },
    );
    await control.workspaces.resume();
    await control.workspaces.settled(created.id);
    const failed = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /out of room/);
  } finally {
    provisioner.failCapacity = 0;
    logged.mock.restore();
  }
});

test("the timer asks the provider for its upkeep every time, and a failure there stops nothing", async () => {
  const before = provisioner.maintained;
  await control.workspaces.resume();
  assert.equal(provisioner.maintained, before + 1);

  const owner = await signIn("room3@example.com", "Robin");
  const logged = mock.method(console, "error", () => {});
  try {
    provisioner.failCapacity = 1;
    const created = await (await owner.post("/v1/workspaces", { name: "Upkeep" })).json();
    await control.workspaces.settled(created.id);
    provisioner.failMaintain = true;
    await control.workspaces.resume();
    await control.workspaces.settled(created.id);
    assert.equal((await (await owner.get(`/v1/workspaces/${created.id}`)).json()).status, "ready");
    assert.match(
      logged.mock.calls.map((call) => String(call.arguments[0])).join("\n"),
      /provider upkeep failed/,
    );
  } finally {
    provisioner.failMaintain = false;
    provisioner.failCapacity = 0;
    logged.mock.restore();
  }
});

test("a workspace that fails to start says so, and the owner can try again", async () => {
  const owner = await signIn("owner5@example.com");
  const member = await signIn("member5@example.com");
  provisioner.failCreates = 1;
  const created = await (await owner.post("/v1/workspaces", { name: "Flaky" })).json();
  await control.workspaces.settled(created.id);
  const failed = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "We could not start this workspace.");
  assert.equal("url" in failed, false);
  assert.equal((await member.post(`/v1/workspaces/${created.id}/retry`)).status, 404);
  const retried = await owner.post(`/v1/workspaces/${created.id}/retry`);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).status, "provisioning");
  await control.workspaces.settled(created.id);
  const ready = await (await owner.get(`/v1/workspaces/${created.id}`)).json();
  assert.equal(ready.status, "ready");
  assert.equal("error" in ready, false);
  // It did not fail, so there is nothing to retry.
  assert.equal((await owner.post(`/v1/workspaces/${created.id}/retry`)).status, 409);
});

test("a restart picks up a workspace that was still being made", async () => {
  const owner = await signIn("owner6@example.com");
  const now = new Date().toISOString();
  await db.put("control", "workspaces", {
    id: "wresumed001",
    name: "Interrupted",
    plan: "free",
    status: "provisioning",
    createdBy: owner.account.id,
    createdAt: now,
    updatedAt: now,
  });
  await db.put("control", "members", {
    id: `wresumed001:${owner.account.id}`,
    workspaceId: "wresumed001",
    accountId: owner.account.id,
    role: "owner",
    joinedAt: now,
  });
  await control.workspaces.resume();
  await control.workspaces.settled("wresumed001");
  const view = await (await owner.get("/v1/workspaces/wresumed001")).json();
  assert.equal(view.status, "ready");
});

test("waking a workspace starts its machine and reports where it is", async () => {
  const owner = await signIn("owner7@example.com");
  const id = await readyWorkspace(owner);
  provisioner.stop(id);
  const woken = await owner.post(`/v1/workspaces/${id}/wake`);
  assert.equal(woken.status, 200);
  assert.deepEqual(await woken.json(), { state: "running" });
  assert.ok(provisioner.woken.includes(id));
});

test("an invitation link brings someone in as a member, and shows them what it is for", async () => {
  const owner = await signIn("owner8@example.com", "Olive");
  const guest = await signIn("guest8@example.com", "Gus");
  const id = await readyWorkspace(owner, "Design team");
  const made = await owner.post(`/v1/workspaces/${id}/invites`, {});
  assert.equal(made.status, 201);
  const { invite, link } = await made.json();
  assert.equal(invite.role, "member");
  assert.equal(invite.maxUses, 50);
  assert.match(link, /^https:\/\/hive\.example\.test\/join\/[\w-]{32}$/);
  const token = link.split("/").pop();
  // Anyone holding the link can see what it is for, before they sign in.
  const preview = await control.app.request(`/v1/invites/${token}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    workspaceName: "Design team",
    inviterName: "Olive",
    role: "member",
  });
  assert.equal((await control.app.request("/v1/invites/nope")).status, 404);

  const joined = await guest.post(`/v1/invites/${token}/accept`);
  assert.equal(joined.status, 200);
  const view = await joined.json();
  assert.equal(view.id, id);
  assert.equal(view.role, "member");
  assert.equal(view.url, `https://${id}.fake.test`);
  // Again: nothing changes, and the use is not counted twice.
  assert.equal((await guest.post(`/v1/invites/${token}/accept`)).status, 200);
  const listed = await (await owner.get(`/v1/workspaces/${id}/invites`)).json();
  assert.equal(listed[0].uses, 1);
  const members = await (await owner.get(`/v1/workspaces/${id}/members`)).json();
  assert.deepEqual(
    members.map((m: { name: string; role: string }) => [m.name, m.role]),
    [
      ["Olive", "owner"],
      ["Gus", "member"],
    ],
  );
  // And what they sign in to the workspace as follows from it.
  const { token: signed } = await (await guest.post(`/v1/workspaces/${id}/token`)).json();
  assert.equal(verifyWorkspaceToken(keys.publicKey, signed, { workspaceId: id }).role, "member");
});

test("an invitation to an email address is for that person, and goes to them", async () => {
  const owner = await signIn("owner9@example.com", "Olive");
  const right = await signIn("right9@example.com");
  const wrong = await signIn("wrong9@example.com");
  const id = await readyWorkspace(owner);
  const made = await (
    await owner.post(`/v1/workspaces/${id}/invites`, { email: " Right9@Example.com " })
  ).json();
  assert.equal(made.invite.email, "right9@example.com");
  assert.equal(made.invite.maxUses, 1);
  assert.deepEqual(
    sent
      .filter((m) => m.to === "right9@example.com")
      .map((m) => [m.workspaceName, m.link === made.link]),
    [["Acme", true]],
  );
  const token = made.link.split("/").pop();
  const refused = await wrong.post(`/v1/invites/${token}/accept`);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /right9@example.com/);
  assert.equal((await right.post(`/v1/invites/${token}/accept`)).status, 200);
  // Already in: inviting them again is refused rather than sent.
  const again = await owner.post(`/v1/workspaces/${id}/invites`, { email: "right9@example.com" });
  assert.equal(again.status, 409);
});

test("an invitation can run out, expire, or be revoked", async () => {
  const owner = await signIn("owner10@example.com");
  const first = await signIn("first10@example.com");
  const second = await signIn("second10@example.com");
  const id = await readyWorkspace(owner);
  const token = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link
    .split("/")
    .pop();
  const hash = (await db.list("control", "invites")).find(
    (i) => (i as { workspaceId: string }).workspaceId === id,
  ) as { id: string; maxUses: number };
  // One use left, and two people arrive at once.
  await db.compareAndSwap("control", "invites", hash.id, {}, { maxUses: 1 });
  const results = await Promise.all([
    first.post(`/v1/invites/${token}/accept`),
    second.post(`/v1/invites/${token}/accept`),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 410]);
  assert.equal((await (await owner.get(`/v1/workspaces/${id}/members`)).json()).length, 2);

  const expired = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link
    .split("/")
    .pop();
  const row = (await db.list("control", "invites")).find(
    (i) =>
      (i as { uses: number; maxUses: number }).uses === 0 &&
      (i as { workspaceId: string }).workspaceId === id,
  ) as { id: string };
  await db.compareAndSwap("control", "invites", row.id, {}, { expiresAt: Date.now() - 1000 });
  const late = await first.get(`/v1/invites/${expired}`);
  assert.equal(late.status, 410);

  const revoked = await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json();
  assert.equal((await owner.del(`/v1/workspaces/${id}/invites/${revoked.invite.id}`)).status, 200);
  const gone = await control.app.request(`/v1/invites/${revoked.link.split("/").pop()}`);
  assert.equal(gone.status, 404);
  assert.equal((await owner.get(`/v1/workspaces/${id}/invites`)).status, 200);
});

test("who may invite whom, and who may see or change what", async () => {
  const owner = await signIn("owner11@example.com", "Olive");
  const admin = await signIn("admin11@example.com", "Ada");
  const member = await signIn("member11@example.com", "Max");
  const id = await readyWorkspace(owner);
  const link = (await (await owner.post(`/v1/workspaces/${id}/invites`, { role: "admin" })).json())
    .link;
  assert.equal((await admin.post(`/v1/invites/${link.split("/").pop()}/accept`)).status, 200);
  const memberLink = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link;
  assert.equal(
    (await member.post(`/v1/invites/${memberLink.split("/").pop()}/accept`)).status,
    200,
  );

  // A member cannot invite or look at invites; an admin can invite members but not admins.
  assert.equal((await member.post(`/v1/workspaces/${id}/invites`, {})).status, 403);
  assert.equal((await member.get(`/v1/workspaces/${id}/invites`)).status, 403);
  assert.equal((await admin.post(`/v1/workspaces/${id}/invites`, {})).status, 201);
  assert.equal((await admin.post(`/v1/workspaces/${id}/invites`, { role: "admin" })).status, 403);
  // Only the owner changes roles or deletes.
  assert.equal(
    (await admin.patch(`/v1/workspaces/${id}/members/${member.account.id}`, { role: "admin" }))
      .status,
    403,
  );
  assert.equal(
    (await owner.patch(`/v1/workspaces/${id}/members/${member.account.id}`, { role: "admin" }))
      .status,
    200,
  );
  const { token } = await (await member.post(`/v1/workspaces/${id}/token`)).json();
  assert.equal(verifyWorkspaceToken(keys.publicKey, token, { workspaceId: id }).role, "admin");
  assert.equal(
    (await owner.patch(`/v1/workspaces/${id}/members/${owner.account.id}`, { role: "member" }))
      .status,
    409,
  );
  assert.equal((await admin.del(`/v1/workspaces/${id}`)).status, 403);
});

test("a guest is invited as one, is shown only themselves, and signs in as a guest", async () => {
  const owner = await signIn("owner31@example.com", "Olive");
  const admin = await signIn("admin31@example.com", "Ada");
  const guest = await signIn("guest31@example.com", "Gus");
  const member = await signIn("member31@example.com", "Max");
  const id = await readyWorkspace(owner);
  const adminLink = (
    await (await owner.post(`/v1/workspaces/${id}/invites`, { role: "admin" })).json()
  ).link;
  assert.equal((await admin.post(`/v1/invites/${adminLink.split("/").pop()}/accept`)).status, 200);

  // An admin can invite a guest, and the link says that is what it is for.
  const made = await admin.post(`/v1/workspaces/${id}/invites`, { role: "guest" });
  assert.equal(made.status, 201);
  const { invite, link } = await made.json();
  assert.equal(invite.role, "guest");
  const token = link.split("/").pop();
  assert.equal((await (await control.app.request(`/v1/invites/${token}`)).json()).role, "guest");
  const joined = await guest.post(`/v1/invites/${token}/accept`);
  assert.equal(joined.status, 200);
  assert.equal((await joined.json()).role, "guest");

  // They are shown who they are here, and not who else is.
  const own = await (await guest.get(`/v1/workspaces/${id}/members`)).json();
  assert.deepEqual(
    own.map((m: { name: string; role: string }) => [m.name, m.role]),
    [["Gus", "guest"]],
  );
  const team = await (await owner.get(`/v1/workspaces/${id}/members`)).json();
  assert.deepEqual(
    team.map((m: { name: string; role: string }) => [m.name, m.role]),
    [
      ["Olive", "owner"],
      ["Ada", "admin"],
      ["Gus", "guest"],
    ],
  );
  // A guest cannot invite or look at invites, and the workspace signs them in as a guest.
  assert.equal((await guest.post(`/v1/workspaces/${id}/invites`, {})).status, 403);
  assert.equal((await guest.get(`/v1/workspaces/${id}/invites`)).status, 403);
  const { token: signed } = await (await guest.post(`/v1/workspaces/${id}/token`)).json();
  assert.equal(verifyWorkspaceToken(keys.publicKey, signed, { workspaceId: id }).role, "guest");

  // The owner can make a member a guest, and a guest a member. An admin cannot change roles.
  const memberLink = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link;
  assert.equal(
    (await member.post(`/v1/invites/${memberLink.split("/").pop()}/accept`)).status,
    200,
  );
  assert.equal(
    (await admin.patch(`/v1/workspaces/${id}/members/${member.account.id}`, { role: "guest" }))
      .status,
    403,
  );
  assert.equal(
    (await owner.patch(`/v1/workspaces/${id}/members/${member.account.id}`, { role: "guest" }))
      .status,
    200,
  );
  const { token: demoted } = await (await member.post(`/v1/workspaces/${id}/token`)).json();
  assert.equal(verifyWorkspaceToken(keys.publicKey, demoted, { workspaceId: id }).role, "guest");
  // An admin removes a guest, as they would a member.
  assert.equal((await admin.del(`/v1/workspaces/${id}/members/${guest.account.id}`)).status, 200);
  assert.equal((await guest.post(`/v1/workspaces/${id}/token`)).status, 404);
});

test("removing someone ends their access, and people can leave except the owner", async () => {
  const owner = await signIn("owner12@example.com");
  const admin = await signIn("admin12@example.com");
  const other = await signIn("other12@example.com");
  const leaver = await signIn("leaver12@example.com");
  const id = await readyWorkspace(owner);
  const join = async (who: Awaited<ReturnType<typeof signIn>>, role?: string) => {
    const l = (
      await (await owner.post(`/v1/workspaces/${id}/invites`, role ? { role } : {})).json()
    ).link;
    assert.equal((await who.post(`/v1/invites/${l.split("/").pop()}/accept`)).status, 200);
  };
  await join(admin, "admin");
  await join(other);
  await join(leaver);

  // An admin removes members, but not the owner, and not other admins.
  assert.equal((await admin.del(`/v1/workspaces/${id}/members/${owner.account.id}`)).status, 409);
  assert.equal((await other.del(`/v1/workspaces/${id}/members/${leaver.account.id}`)).status, 403);
  assert.equal((await admin.del(`/v1/workspaces/${id}/members/${other.account.id}`)).status, 200);
  // Once removed, they cannot get a token, or see the workspace, and the workspace is told their
  // sessions there are over, so it does not wait for the hour to run out.
  const told = revoked.at(-1);
  assert.equal(told?.url, `https://${id}.fake.test/api/auth/revoke`);
  assert.equal(
    verifyRevocation(keys.publicKey, told?.token ?? "", { workspaceId: id }),
    other.account.id,
  );
  assert.equal((await other.post(`/v1/workspaces/${id}/token`)).status, 404);
  assert.equal((await other.get(`/v1/workspaces/${id}`)).status, 404);
  // Leaving is the same as being removed.
  assert.equal((await leaver.del(`/v1/workspaces/${id}/members/${leaver.account.id}`)).status, 200);
  assert.equal((await leaver.post(`/v1/workspaces/${id}/token`)).status, 404);
  // The owner cannot leave: they delete the workspace.
  assert.equal((await owner.del(`/v1/workspaces/${id}/members/${owner.account.id}`)).status, 409);
  assert.equal((await owner.del(`/v1/workspaces/${id}/members/${other.account.id}`)).status, 404);
});

test("deleting a workspace removes its servers and every trace of it", async () => {
  const owner = await signIn("owner13@example.com");
  const guest = await signIn("guest13@example.com");
  const id = await readyWorkspace(owner);
  const link = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link;
  await guest.post(`/v1/invites/${link.split("/").pop()}/accept`);

  provisioner.failDestroys = 1;
  const failed = await owner.del(`/v1/workspaces/${id}`);
  assert.equal(failed.status, 502);
  // It is on its way out: not usable, and the delete can be asked for again.
  assert.equal((await owner.post(`/v1/workspaces/${id}/token`)).status, 404);
  assert.equal(provisioner.destroyed.includes(id), false);
  // Gone from the list too, but the records are kept until the servers are.
  assert.deepEqual((await (await guest.get("/v1/me")).json()).workspaces, []);
  assert.ok(await db.get("control", "workspaces", id));

  // The control plane finishes removals it started, at its next sweep.
  await control.workspaces.resume();
  assert.equal(provisioner.destroyed.includes(id), true);
  assert.equal(await db.get("control", "workspaces", id), null);
  assert.equal(
    (await db.list("control", "members")).some(
      (m) => (m as { workspaceId: string }).workspaceId === id,
    ),
    false,
  );
  assert.equal(
    (await db.list("control", "invites")).some(
      (i) => (i as { workspaceId: string }).workspaceId === id,
    ),
    false,
  );
  assert.equal((await control.app.request(`/v1/invites/${link.split("/").pop()}`)).status, 404);
});

test("deleting an account ends its sessions everywhere and takes it out of its workspace", async () => {
  const owner = await signIn("owner21@example.com", "Olive");
  const leaver = await signIn("leaver21@example.com", "Lee");
  const phone = await signIn("leaver21@example.com");
  const id = await readyWorkspace(owner);
  const link = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link;
  assert.equal((await leaver.post(`/v1/invites/${link.split("/").pop()}/accept`)).status, 200);
  const before = await (await owner.get(`/v1/workspaces/${id}/members`)).json();
  assert.equal(before.length, 2);

  assert.equal((await leaver.del("/v1/account")).status, 200);

  // Both devices are signed out, and the workspace carries on without them.
  assert.equal((await leaver.get("/v1/me")).status, 401);
  assert.equal((await phone.get("/v1/me")).status, 401);
  const after = await (await owner.get(`/v1/workspaces/${id}/members`)).json();
  assert.deepEqual(
    after.map((m: { accountId: string }) => m.accountId),
    [owner.account.id],
  );
  assert.equal((await owner.get(`/v1/workspaces/${id}`)).status, 200);

  // The same address signing in again gets a fresh account, in no workspace.
  const again = await signIn("leaver21@example.com");
  const me = await (await again.get("/v1/me")).json();
  assert.deepEqual(me.workspaces, []);
  assert.equal((await again.post(`/v1/workspaces/${id}/token`)).status, 404);
});

test("an owner has to delete their workspace before their account, and then can", async () => {
  const owner = await signIn("owner22@example.com", "Olive");
  const member = await signIn("member22@example.com");
  const id = await readyWorkspace(owner, "Acme");
  const link = (await (await owner.post(`/v1/workspaces/${id}/invites`, {})).json()).link;
  assert.equal((await member.post(`/v1/invites/${link.split("/").pop()}/accept`)).status, 200);

  const refused = await owner.del("/v1/account");
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /You own Acme\. Delete it before/);
  // Nothing was taken: they are still signed in, and still the owner.
  assert.equal((await owner.get(`/v1/workspaces/${id}`)).status, 200);

  assert.equal((await owner.del(`/v1/workspaces/${id}`)).status, 200);
  assert.equal((await owner.del("/v1/account")).status, 200);
  assert.equal((await owner.get("/v1/me")).status, 401);
  // The member was not touched by any of it.
  assert.equal((await member.get("/v1/me")).status, 200);
});

test("an owner whose workspace is still being deleted is told to wait, not that they own it", async () => {
  const owner = await signIn("owner23@example.com");
  const id = await readyWorkspace(owner, "Going");
  await db.compareAndSwap("control", "workspaces", id, {}, { status: "deleting" });
  const refused = await owner.del("/v1/account");
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Going is still being deleted/);
});

test("deleting an account clears the invitations it sent and the ones sent to it", async () => {
  const owner = await signIn("owner24@example.com");
  const admin = await signIn("admin24@example.com");
  const guest = await signIn("guest24@example.com");
  const id = await readyWorkspace(owner);
  const adminLink = (
    await (await owner.post(`/v1/workspaces/${id}/invites`, { role: "admin" })).json()
  ).link;
  assert.equal((await admin.post(`/v1/invites/${adminLink.split("/").pop()}/accept`)).status, 200);
  // One the admin sends, and one the owner sends to the guest's address.
  assert.equal((await admin.post(`/v1/workspaces/${id}/invites`, {})).status, 201);
  assert.equal(
    (await owner.post(`/v1/workspaces/${id}/invites`, { email: "guest24@example.com" })).status,
    201,
  );
  const invitesOf = async () =>
    (await db.list("control", "invites")).filter(
      (invite) => (invite as { workspaceId: string }).workspaceId === id,
    ) as { createdBy: string; email?: string }[];
  const count = (await invitesOf()).length;

  assert.equal((await admin.del("/v1/account")).status, 200);
  assert.equal((await invitesOf()).filter((i) => i.createdBy === admin.account.id).length, 0);
  assert.equal((await guest.del("/v1/account")).status, 200);
  assert.equal((await invitesOf()).filter((i) => i.email === "guest24@example.com").length, 0);
  assert.ok((await invitesOf()).length < count, "the others' invitations are kept");
});

test("sweeping clears expired sessions, sign-in codes and Google sign-ins, and nothing else", async () => {
  const ada = await signIn("sweeper25@example.com");
  const now = Date.now();
  const past = now - 1000;
  const future = now + 60_000;
  for (const kind of ["sessions", "login-codes", "oauth"]) {
    await db.put("control", kind, {
      id: `${kind}-old`,
      accountId: ada.account.id,
      expiresAt: past,
    });
    await db.put("control", kind, {
      id: `${kind}-live`,
      accountId: ada.account.id,
      expiresAt: future,
    });
  }
  // A record with no usable expiry is not for the sweep to judge, nor is another kind's expiry.
  await db.put("control", "sessions", { id: "sessions-odd", accountId: ada.account.id });
  await db.put("control", "sessions", { id: "sessions-text", expiresAt: "1" });
  await db.put("control", "invites", { id: "invite-old", workspaceId: "w", expiresAt: past });
  await db.put("other-owner", "sessions", { id: "sessions-elsewhere", expiresAt: past });

  const removed = await control.accounts.sweep(now);
  assert.ok(removed >= 3, `at least the three expired ones went (${removed})`);
  for (const kind of ["sessions", "login-codes", "oauth"]) {
    assert.equal(await db.get("control", kind, `${kind}-old`), null, `${kind} expired`);
    assert.ok(await db.get("control", kind, `${kind}-live`), `${kind} still good`);
  }
  assert.ok(await db.get("control", "sessions", "sessions-odd"));
  assert.ok(await db.get("control", "sessions", "sessions-text"));
  assert.ok(
    await db.get("control", "invites", "invite-old"),
    "an expired invitation keeps its message",
  );
  assert.ok(await db.get("other-owner", "sessions", "sessions-elsewhere"));
  // The person who is signed in is still signed in, and a second sweep finds nothing to do.
  assert.equal((await ada.get("/v1/me")).status, 200);
  assert.equal(await control.accounts.sweep(now), 0);
});

test("an invite link opens the web app, which is a site of its own, and an older link on the control plane goes on to it", async () => {
  const split = createControlApp(db, config({ appUrl: "https://app.example.test" }), {
    provisioner,
    keys,
    mailer: { async sendInvite() {} },
  });
  const owner = await signIn("apphost@example.com");
  const id = await readyWorkspace(owner);
  const call = (method: string, path: string, body?: unknown) =>
    split.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const made = (await (await call("POST", `/v1/workspaces/${id}/invites`, {})).json()) as {
    link: string;
  };
  const token = made.link.split("/").pop() as string;
  assert.equal(made.link, `https://app.example.test/join/${token}`);
  // A link made before this, on the control plane's own address, is sent on to the app.
  const old = await split.app.request(`/join/${token}`);
  assert.equal(old.status, 302);
  assert.equal(old.headers.get("location"), `https://app.example.test/join/${token}`);
  // Where the control plane is the web app itself, links stay on it and nothing is redirected.
  assert.equal((await control.app.request(`/join/${token}`)).status, 404);
});
