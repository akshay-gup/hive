import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { DigitalOceanProvisioner } from "../apps/control/src/digitalocean.ts";
import { loadSigningKeys } from "../apps/control/src/signing.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { fakeDigitalOcean } from "./helpers/fake-do.ts";

const EDGE_TOKEN = "e".repeat(40);
let db: Store;
let directory: string;
let fake: Awaited<ReturnType<typeof fakeDigitalOcean>>;
let control: ReturnType<typeof createControlApp>;
let provisioner: DigitalOceanProvisioner;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-control-do-"));
  db = await createStore();
  // The address a workspace answers at has the edge in front of it, which asks the control plane.
  fake = await fakeDigitalOcean({
    activeDelayMs: 30,
    bootDelayMs: 30,
    actionDelayMs: 20,
    resolve: (id) => control.workspaces.upstream(id),
  });
  provisioner = new DigitalOceanProvisioner({
    token: fake.token,
    image: "1234567",
    region: "nyc3",
    sizes: {},
    sshKeys: [],
    namePrefix: "hive",
    workspaceEnv: {},
    apiUrl: fake.apiUrl,
    publicUrlTemplate: fake.publicUrlTemplate,
    firewall: true,
    edgeTag: "hive-edge",
    edgeAddresses: [],
    upstreamNetwork: "private",
    waitSeconds: 10,
    pollMs: 20,
    retryMs: 5,
  });
  const config: ControlConfig = {
    mode: "sample",
    port: 8800,
    host: "127.0.0.1",
    publicUrl: "https://hive.example.test",
    dataDir: directory,
    allowedOrigins: [],
    maxWorkspacesPerAccount: 3,
    googleRedirectUri: "https://hive.example.test/v1/auth/google/callback",
    edgeToken: EDGE_TOKEN,
  };
  control = createControlApp(db, config, {
    provisioner,
    keys: await loadSigningKeys(directory, {}),
  });
});
afterEach(async () => {
  await fake.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function signIn(email: string) {
  const response = await control.app.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Ip": email },
    body: JSON.stringify({ email }),
  });
  const { token } = await response.json();
  return (method: string, path: string, body?: unknown) =>
    control.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
const whereIs = (id: string) =>
  control.app.request(`/internal/upstream/${id}`, {
    headers: { Authorization: `Bearer ${EDGE_TOKEN}` },
  });

test("a workspace is made, and found by the edge while it is made and after, then not when it is stopped", async () => {
  const asOwner = await signIn("owner@example.com");
  const made = await asOwner("POST", "/v1/workspaces", { name: "Acme" });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  // Making it ends when it answers at its address, which is behind something that asks the control
  // plane where it is: so the control plane has to be able to say, while it is still being made.
  await control.workspaces.settled(id);
  const view = await (await asOwner("GET", `/v1/workspaces/${id}`)).json();
  assert.equal(view.status, "ready", view.error);
  assert.equal(view.url, fake.publicUrlTemplate.replace("{id}", id));

  const droplet = fake.dropletOf(id);
  assert.ok(droplet);
  assert.deepEqual(await (await whereIs(id)).json(), {
    upstream: `http://${droplet.networks.v4.find((n) => n.type === "private")?.ip_address}:8787`,
  });

  // Stopped, it is still the workspace's, with no address to connect to.
  await provisioner.stop(id);
  assert.equal((await whereIs(id)).status, 503);
  // Woken by the control plane, which waits for it to answer at its address, it is found again.
  const woken = await asOwner("POST", `/v1/workspaces/${id}/wake`);
  assert.equal(woken.status, 200);
  assert.equal((await whereIs(id)).status, 200);

  // Removed, it is nobody's.
  assert.equal((await asOwner("DELETE", `/v1/workspaces/${id}`)).status, 200);
  await control.workspaces.settled(id);
  assert.equal(fake.dropletOf(id), undefined);
  assert.equal((await whereIs(id)).status, 404);
});
