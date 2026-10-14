import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME } from "../apps/control/src/accounts.ts";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { D1Store } from "../apps/control/src/d1-store.ts";
import { generateWorkspaceKeys } from "../packages/integrations/src/workspace-token.ts";
import { memoryD1 } from "./helpers/d1-shim.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

/**
 * Several copies of the control plane can run at once on Cloudflare, over one database, and any of
 * them may find a workspace unfinished. These tests are two copies over one store, handed
 * workspaces the way a workflow hands them (not started inside the request).
 */
const config: ControlConfig = {
  mode: "sample",
  port: 8800,
  host: "127.0.0.1",
  publicUrl: "https://hive.example.test",
  dataDir: "unused",
  allowedOrigins: [],
  maxWorkspacesPerAccount: 3,
  clientIpHeader: "x-client-ip",
  googleRedirectUri: "https://hive.example.test/v1/auth/google/callback",
};

interface WorkspaceRow {
  id: string;
  status: string;
  leaseUntil?: number;
  url?: string;
  error?: string;
}

function copies() {
  const db = new D1Store(memoryD1());
  const keys = generateWorkspaceKeys();
  const started: { copy: string; id: string }[] = [];
  const make = (copy: string) => {
    const provisioner = new FakeProvisioner();
    const control = createControlApp(db, config, {
      provisioner,
      keys,
      startProvisioning: (id) => {
        started.push({ copy, id });
      },
    });
    return { control, provisioner };
  };
  return { db, started, a: make("a"), b: make("b") };
}
type Copy = ReturnType<typeof copies>["a"];

async function signIn(copy: Copy, email: string) {
  const response = await copy.control.app.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Ip": email },
    body: JSON.stringify({ email }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return (method: string, path: string, body?: unknown) =>
    copy.control.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
async function makeWorkspace(copy: Copy, email = "ada@example.com") {
  const call = await signIn(copy, email);
  const response = await call("POST", "/v1/workspaces", { name: "Acme" });
  assert.equal(response.status, 201);
  return { id: (await response.json()).id as string, call };
}
const row = async (db: D1Store, id: string) =>
  (await db.get<WorkspaceRecordShape>(HOME, "workspaces", id)) as WorkspaceRecordShape;
type WorkspaceRecordShape = WorkspaceRow;
const created = (...copy: Copy[]) => copy.reduce((n, c) => n + c.provisioner.created.length, 0);

test("making a workspace is handed on, not done inside the request", async () => {
  const { db, started, a } = copies();
  const { id } = await makeWorkspace(a);
  assert.deepEqual(started, [{ copy: "a", id }]);
  assert.equal(created(a), 0);
  const record = await row(db, id);
  assert.equal(record.status, "provisioning");
  assert.equal(record.leaseUntil, 0);
});

test("two copies that find the same workspace unfinished make it once", async () => {
  const { db, a, b } = copies();
  const { id, call } = await makeWorkspace(a);
  let release: () => void = () => {};
  a.provisioner.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.provisioner.hold = a.provisioner.hold;
  const both = Promise.all([
    a.control.workspaces.provisionNow(id),
    b.control.workspaces.provisionNow(id),
  ]);
  // One has the workspace and is waiting on the provider; the other has found it taken and left.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(created(a, b), 1);
  assert.ok(
    ((await row(db, id)).leaseUntil ?? 0) > Date.now(),
    "the copy making it holds the lease",
  );
  release();
  await both;
  assert.equal(created(a, b), 1);
  const done = await row(db, id);
  assert.equal(done.status, "ready");
  assert.equal(done.leaseUntil, 0);
  const seen = await (await call("GET", `/v1/workspaces/${id}`)).json();
  assert.equal(seen.status, "ready");
  assert.match(seen.url, /^https:\/\/w[a-z0-9]+\.fake\.test$/);
});

test("many copies at once still make a workspace once", async () => {
  const { a, b } = copies();
  const { id } = await makeWorkspace(a);
  await Promise.all([
    a.control.workspaces.provisionNow(id),
    b.control.workspaces.provisionNow(id),
    a.control.workspaces.provisionNow(id),
    b.control.workspaces.provisionNow(id),
  ]);
  assert.equal(created(a, b), 1);
});

test("a workspace another copy is making is left alone until that copy's time runs out", async () => {
  const { db, a, b } = copies();
  const { id } = await makeWorkspace(a);
  // A copy took it and died: the lease is still in the future.
  await db.compareAndSwap(HOME, "workspaces", id, {}, { leaseUntil: Date.now() + 60_000 });
  await b.control.workspaces.provisionNow(id);
  assert.equal(created(a, b), 0);
  assert.equal((await row(db, id)).status, "provisioning");
  // Its time has run out, so another copy takes over.
  await db.compareAndSwap(HOME, "workspaces", id, {}, { leaseUntil: Date.now() - 1 });
  await b.control.workspaces.provisionNow(id);
  assert.equal(created(b), 1);
  assert.equal((await row(db, id)).status, "ready");
});

test("resume starts only the workspaces nobody is making", async () => {
  const { db, started, a, b } = copies();
  const free = (await makeWorkspace(a, "free@example.com")).id;
  const taken = (await makeWorkspace(a, "taken@example.com")).id;
  const done = (await makeWorkspace(a, "done@example.com")).id;
  await db.compareAndSwap(HOME, "workspaces", taken, {}, { leaseUntil: Date.now() + 60_000 });
  await a.control.workspaces.provisionNow(done);
  started.length = 0;
  await b.control.workspaces.resume();
  assert.deepEqual(started, [{ copy: "b", id: free }]);
});

test("a copy that was not given the workspace says nothing of it; the one that was records a failure and lets go", async () => {
  const { db, a, b } = copies();
  const { id, call } = await makeWorkspace(a);
  a.provisioner.failCreates = 1;
  await Promise.all([a.control.workspaces.provisionNow(id), b.control.workspaces.provisionNow(id)]);
  const failed = await row(db, id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.leaseUntil, 0);
  assert.ok(failed.error);
  assert.equal(created(a, b), 1);
  const retried = await call("POST", `/v1/workspaces/${id}/retry`);
  assert.equal(retried.status, 200);
  await b.control.workspaces.provisionNow(id);
  assert.equal((await row(db, id)).status, "ready");
});

test("deleting a workspace waits for the copy still making it, then takes it down", async () => {
  const { db, a, b } = copies();
  const { id } = await makeWorkspace(a);
  let release: () => void = () => {};
  a.provisioner.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const making = a.control.workspaces.provisionNow(id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The request to delete it reaches the other copy, which knows nothing of the job under way in this one.
  const callOnB = await signIn(b, "ada@example.com");
  const removal = await callOnB("DELETE", `/v1/workspaces/${id}`);
  assert.equal(removal.status, 200);
  // Taking it down now would leave behind the machine that copy is about to start.
  assert.equal(b.provisioner.destroyed.length, 0);
  assert.equal((await row(db, id)).status, "deleting");
  release();
  await making;
  assert.equal((await row(db, id)).status, "deleting", "making it did not bring it back");
  await b.control.workspaces.resume();
  assert.deepEqual(b.provisioner.destroyed, [id]);
  assert.equal(await db.get(HOME, "workspaces", id), null);
});
