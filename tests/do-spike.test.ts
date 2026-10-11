import assert from "node:assert/strict";
import { createServer } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { DigitalOceanProvisioner } from "../apps/control/src/digitalocean.ts";
import { DigitalOceanApi } from "../apps/control/src/digitalocean-api.ts";
import {
  countCalls,
  main,
  portIsClosed,
  runDigitalOceanSpike,
  SPIKE_PREFIX,
} from "../apps/control/tools/do-spike.ts";
import type { WorkspaceProbe } from "../apps/control/tools/fly-spike.ts";
import { fakeDigitalOcean } from "./helpers/fake-do.ts";

let fake: Awaited<ReturnType<typeof fakeDigitalOcean>>;
beforeEach(async () => {
  fake = await fakeDigitalOcean({ activeDelayMs: 20, bootDelayMs: 20, actionDelayMs: 20 });
});
afterEach(async () => {
  await fake.close();
});

const provisioner = () =>
  new DigitalOceanProvisioner({
    token: fake.token,
    image: "1234567",
    region: "nyc3",
    sizes: {},
    sshKeys: [],
    namePrefix: SPIKE_PREFIX,
    workspaceEnv: {},
    apiUrl: fake.apiUrl,
    publicUrlTemplate: fake.publicUrlTemplate,
    firewall: true,
    edgeTag: "hive-edge",
    edgeAddresses: ["198.51.100.7/32"],
    upstreamNetwork: "public",
    waitSeconds: 5,
    pollMs: 20,
    retryMs: 5,
  });
const api = () => new DigitalOceanApi({ token: fake.token, apiUrl: fake.apiUrl, retryMs: 5 });
/** A workspace that remembers what it was given, as one with a disk does. */
function probe(keeps = true): WorkspaceProbe & { calls: string[] } {
  let kept = false;
  const calls: string[] = [];
  return {
    calls,
    async write(url) {
      calls.push(`write ${url}`);
      kept = true;
    },
    async read(url) {
      calls.push(`read ${url}`);
      return kept && keeps;
    },
  };
}
const names = (report: { steps: { name: string; ok: boolean }[] }) =>
  report.steps.map((step) => `${step.ok ? "ok" : "FAILED"} ${step.name.split(":")[0]}`);

test("the spike makes a workspace, stops and wakes it, finds what it kept, and leaves nothing", async () => {
  const lines: string[] = [];
  const p = probe();
  const report = await runDigitalOceanSpike({
    provisioner: provisioner(),
    probe: p,
    api: api(),
    workspaceId: "wspike1",
    log: (line) => lines.push(line),
    closed: async () => true,
  });
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(names(report), [
    "ok create",
    "ok create again",
    "ok state after create",
    "ok the firewall is on",
    "ok sign in and keep a channel",
    "ok stop",
    "ok state after stop",
    "ok wake",
    "ok what was kept is still there after the stop and start",
    "ok destroy",
    "ok nothing is left",
    "ok the spike's firewall is removed",
  ]);
  // It signs in at the Droplet's own address, not at the public one, which has no edge here.
  assert.ok(
    p.calls.every((call) => /^(write|read) http:\/\/203\.0\.113\.\d+:8787$/.test(call)),
    p.calls.join(),
  );
  assert.equal(fake.droplets.size, 0);
  assert.equal(fake.firewalls.size, 0);
  assert.ok(
    lines.some((line) => /create: .*calls to DigitalOcean/.test(line)),
    lines.join("\n"),
  );
});

test("everything it made is under its own names, and the firewall opens to the address it was given", async () => {
  const report = await runDigitalOceanSpike({
    provisioner: provisioner(),
    probe: probe(),
    api: api(),
    workspaceId: "wspike2",
    keep: true,
    closed: async () => true,
  });
  assert.equal(report.ok, true);
  const droplet = fake.dropletOf("wspike2");
  assert.equal(droplet?.name, `${SPIKE_PREFIX}-wspike2`);
  assert.deepEqual(droplet?.tags, [
    SPIKE_PREFIX,
    `${SPIKE_PREFIX}-workspace`,
    `${SPIKE_PREFIX}-ws-wspike2`,
  ]);
  const [firewall] = [...fake.firewalls.values()];
  assert.equal(firewall?.name, `${SPIKE_PREFIX}-workspaces`);
  assert.deepEqual(firewall?.inbound_rules[0]?.sources.addresses, ["198.51.100.7/32"]);
  // Kept, it is still there afterwards.
  assert.equal(fake.droplets.size, 1);
});

test("a workspace that forgets what it was given fails the spike, and the clean-up still happens", async () => {
  const report = await runDigitalOceanSpike({
    provisioner: provisioner(),
    probe: probe(false),
    api: api(),
    workspaceId: "wspike3",
    closed: async () => true,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(names(report).slice(-4), [
    "FAILED what was kept is still there after the stop and start",
    "ok destroy",
    "ok nothing is left",
    "ok the spike's firewall is removed",
  ]);
  assert.match(report.steps.find((step) => !step.ok)?.note ?? "", /the channel was not there/);
  assert.equal(fake.droplets.size, 0);
  assert.equal(fake.firewalls.size, 0);
});

test("a firewall that lets ssh through fails the spike", async () => {
  const report = await runDigitalOceanSpike({
    provisioner: provisioner(),
    probe: probe(),
    api: api(),
    workspaceId: "wspike4",
    closed: async () => false,
  });
  assert.equal(report.ok, false);
  assert.match(
    report.steps.find((step) => !step.ok)?.note ?? "",
    /port 22 on 203\.0\.113\.\d+ answers/,
  );
  assert.equal(fake.droplets.size, 0);
});

test("a firewall an earlier run left is replaced, since it would not open to this machine", async () => {
  await api().call("POST", "/firewalls", {
    name: `${SPIKE_PREFIX}-workspaces`,
    inbound_rules: [{ protocol: "tcp", ports: "8787", sources: { addresses: ["192.0.2.1/32"] } }],
    outbound_rules: [],
    tags: [`${SPIKE_PREFIX}-workspace`],
  });
  const report = await runDigitalOceanSpike({
    provisioner: provisioner(),
    probe: probe(),
    api: api(),
    workspaceId: "wspike5",
    keep: true,
    closed: async () => true,
  });
  assert.equal(report.ok, true);
  const firewalls = [...fake.firewalls.values()];
  assert.equal(firewalls.length, 1);
  assert.deepEqual(firewalls[0]?.inbound_rules[0]?.sources.addresses, ["198.51.100.7/32"]);
});

test("the calls made to DigitalOcean are counted, with the least the allowance had left", async () => {
  const before = globalThis.fetch;
  const counter = countCalls(fake.apiUrl);
  assert.notEqual(globalThis.fetch, before);
  try {
    await runDigitalOceanSpike({
      provisioner: provisioner(),
      probe: probe(),
      api: api(),
      workspaceId: "wspike6",
      calls: counter.calls,
      closed: async () => true,
    });
    // Every call DigitalOcean got, and none of the workspace's own answers.
    assert.equal(counter.calls(), fake.calls.length);
    assert.ok(counter.calls() > 10);
    assert.equal(counter.remaining(), 4990);
  } finally {
    counter.restore();
  }
  assert.equal(globalThis.fetch, before);
});

test("a port is closed when nothing answers and open when something does", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  assert.equal(await portIsClosed("127.0.0.1", port, 500), false);
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  assert.equal(await portIsClosed("127.0.0.1", port, 500), true);
});

test("the command needs this machine's address for the firewall, and the settings the provisioner needs", async () => {
  const env = { DO_API_TOKEN: "t", DO_IMAGE: "1" };
  await assert.rejects(main(env), /DO_EDGE_ADDRESSES is needed/);
  await assert.rejects(
    main({ ...env, DO_API_TOKEN: undefined, DO_EDGE_ADDRESSES: "1.2.3.4/32" }),
    /DO_API_TOKEN/,
  );
});
