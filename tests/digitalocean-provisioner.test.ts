import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  cloudConfig,
  type DigitalOceanConfig,
  DigitalOceanProvisioner,
  digitalOceanConfigFromEnv,
} from "../apps/control/src/digitalocean.ts";
import { plans } from "../apps/control/src/plans.ts";
import { ProvisionError, type WorkspaceSpec } from "../apps/control/src/provisioner.ts";
import { provisionerFromEnv } from "../apps/control/src/provisioners.ts";
import { generateWorkspaceKeys } from "../packages/integrations/src/workspace-token.ts";
import { type FakeSize, fakeDigitalOcean } from "./helpers/fake-do.ts";

let digitalocean: Awaited<ReturnType<typeof fakeDigitalOcean>>;
const keys = generateWorkspaceKeys();
const ID = "w4k9t2mx7a";

const spec = (over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  workspaceId: ID,
  name: "Acme",
  plan: plans.free,
  controlPublicKey: keys.publicKey,
  allowedOrigins: ["https://app.example.test"],
  ...over,
});
const provisioner = (
  over: Partial<DigitalOceanConfig> = {},
  fake: Awaited<ReturnType<typeof fakeDigitalOcean>> = digitalocean,
) =>
  new DigitalOceanProvisioner({
    token: fake.token,
    image: "1234567",
    region: "nyc3",
    sizes: {},
    sshKeys: [],
    namePrefix: "hive",
    workspaceEnv: { MODEL: "anthropic/test-model" },
    apiUrl: fake.apiUrl,
    publicUrlTemplate: fake.publicUrlTemplate,
    firewall: true,
    edgeTag: "hive-edge",
    edgeAddresses: [],
    upstreamNetwork: "private",
    waitSeconds: 5,
    pollMs: 20,
    retryMs: 5,
    ...over,
  });
const calls = (method: string, path: RegExp) =>
  digitalocean.calls.filter((c) => c.method === method && path.test(c.path));

beforeEach(async () => {
  digitalocean = await fakeDigitalOcean();
});
afterEach(async () => {
  await digitalocean.close();
});

test("it says which step it is on as it goes, in the order they happen", async () => {
  const steps: string[] = [];
  await provisioner().create(spec(), (step) => steps.push(step));
  // With no tunnel there is no address to make.
  assert.deepEqual(steps, ["machine", "starting", "checking"]);
});

test("a workspace gets a Droplet of its own, from the workspace snapshot, and answers", async () => {
  const result = await provisioner().create(spec());
  assert.equal(result.url, digitalocean.publicUrlTemplate.replace("{id}", ID));

  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  assert.equal(droplet.name, `hive-${ID}`);
  assert.equal(droplet.region.slug, "nyc3");
  assert.equal(droplet.image.id, 1234567);
  assert.equal(droplet.status, "active");
  // Found again by tags: one for every workspace, one for this one, and the deployment's own.
  assert.deepEqual(droplet.tags, ["hive", "hive-workspace", `hive-ws-${ID}`]);
  assert.equal(droplet.monitoring, true);
  assert.deepEqual(droplet.sshKeys, []);

  // The request is what DigitalOcean's own client sends.
  const [made] = calls("POST", /^\/v2\/droplets$/);
  const body = made?.body as Record<string, unknown>;
  assert.equal(body.image, 1234567);
  assert.equal(body.ipv6, false);
  assert.equal(body.backups, false);
  assert.equal(typeof body.user_data, "string");
  assert.equal("vpc_uuid" in body, false);
});

test("the Droplet's first boot writes the workspace's settings where only root can read them, and nothing secret", async () => {
  await provisioner().create(spec());
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  assert.match(droplet.userData, /^#cloud-config\n/);
  assert.match(droplet.userData, /path: \/etc\/hive\/workspace\.json/);
  assert.match(droplet.userData, /permissions: "0600"/);
  assert.match(droplet.userData, /owner: root:root/);
  assert.match(droplet.userData, /systemctl, start, --no-block, hive-workspace\.service/);

  const settings = digitalocean.settingsOf(droplet) ?? {};
  assert.equal(settings.WORKSPACE_MODE, "live");
  assert.equal(settings.WORKSPACE_ID, ID);
  assert.equal(settings.CONTROL_PLANE_PUBLIC_KEY, keys.publicKey);
  assert.equal(settings.ALLOWED_ORIGINS, "https://app.example.test");
  assert.equal(settings.PUBLIC_API_URL, digitalocean.publicUrlTemplate.replace("{id}", ID));
  assert.equal(settings.HOST, "0.0.0.0");
  assert.equal(settings.PORT, "8787");
  assert.equal(settings.DATA_DIR, "/data/hive");
  // Whatever the deployment gives every workspace is passed on.
  assert.equal(settings.MODEL, "anthropic/test-model");
  // The workspace makes its own keys on its disk; none are sent from here.
  for (const name of ["TOKEN_ENCRYPTION_KEY", "OPENCODE_SERVER_PASSWORD", "WORKER_TOKEN"])
    assert.equal(name in settings, false, name);
  // Nor does any request carry the API token anywhere in its body.
  for (const call of digitalocean.calls)
    assert.equal(JSON.stringify(call.body ?? "").includes(digitalocean.token), false);
});

test("settings with quotes, newlines and non-ASCII text survive the trip through user data", async () => {
  const tricky = 'a "quoted" key\nwith a second line, \\ and é ✓';
  await provisioner({ workspaceEnv: { ANTHROPIC_API_KEY: tricky } }).create(spec());
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  assert.equal(digitalocean.settingsOf(droplet)?.ANTHROPIC_API_KEY, tricky);
  assert.equal(cloudConfig({ A: "b" }).includes("\t"), false);
});

test("a firewall that lets only the edge reach the workspace is made first, once", async () => {
  const p = provisioner();
  await p.create(spec());
  await p.create(spec({ workspaceId: "wsecond0001" }));
  assert.equal(digitalocean.firewalls.size, 1);
  const [firewall] = [...digitalocean.firewalls.values()];
  assert.equal(firewall?.name, "hive-workspaces");
  assert.deepEqual(firewall?.tags, ["hive-workspace"]);
  assert.deepEqual(firewall?.inbound_rules, [
    { protocol: "tcp", ports: "8787", sources: { tags: ["hive-edge"] } },
  ]);
  // Outbound is open, or the agent could reach nothing.
  assert.deepEqual(
    firewall?.outbound_rules.map((rule) => rule.protocol),
    ["tcp", "udp", "icmp"],
  );
  // It exists before the Droplet does.
  const order = digitalocean.calls
    .filter((c) => c.method === "POST")
    .map((c) => (c.path === "/v2/firewalls" ? "firewall" : "droplet"));
  assert.deepEqual(order.slice(0, 2), ["firewall", "droplet"]);
});

test("addresses the edge connects from are allowed as well as its tag, and a firewall already there is left alone", async () => {
  await provisioner({ edgeAddresses: ["198.51.100.7/32"] }).create(spec());
  const [firewall] = [...digitalocean.firewalls.values()];
  assert.deepEqual(firewall?.inbound_rules[0]?.sources, {
    tags: ["hive-edge"],
    addresses: ["198.51.100.7/32"],
  });
  // An administrator's firewall is not rewritten by a deployment that would have made it differently.
  const before = digitalocean.calls.length;
  await provisioner({ edgeTag: "elsewhere", edgeAddresses: [] }).create(
    spec({ workspaceId: "wsecond0001" }),
  );
  assert.deepEqual(
    digitalocean.calls
      .slice(before)
      .filter((c) => c.path === "/v2/firewalls" && c.method !== "GET"),
    [],
  );
  assert.deepEqual(firewall?.inbound_rules[0]?.sources.tags, ["hive-edge"]);
});

test("a deployment that manages its own firewall is not given one", async () => {
  await provisioner({ firewall: false }).create(spec());
  assert.equal(digitalocean.firewalls.size, 0);
  assert.equal(calls("GET", /^\/v2\/firewalls/).length, 0);
});

test("two creations racing to make the firewall both succeed", async () => {
  // The other creation's firewall appears just as this one's request is refused for the name.
  digitalocean.failNext(
    /POST \/v2\/firewalls$/,
    422,
    1,
    undefined,
    "Name has already been taken",
    () =>
      digitalocean.firewalls.set("fw-other", {
        id: "fw-other",
        name: "hive-workspaces",
        status: "succeeded",
        inbound_rules: [],
        outbound_rules: [],
        droplet_ids: [],
        tags: ["hive-workspace"],
      }),
  );
  await provisioner().create(spec());
  assert.ok(digitalocean.dropletOf(ID));
  assert.equal(digitalocean.firewalls.size, 1);
});

test("a firewall that cannot be made stops the workspace, and says why, rather than leaving it open", async () => {
  digitalocean.failNext(/POST \/v2\/firewalls$/, 422, 1, undefined, "ports are not valid");
  await assert.rejects(
    provisioner().create(spec()),
    (error) =>
      error instanceof ProvisionError &&
      /hive-workspaces could not be made/.test(error.message) &&
      /ports are not valid/.test(error.message),
  );
  assert.equal(digitalocean.firewalls.size, 0);
  assert.equal(digitalocean.droplets.size, 0);
});

test("creating a workspace that exists finishes it rather than making a second", async () => {
  const p = provisioner();
  await p.create(spec());
  const before = digitalocean.calls.length;
  const again = await p.create(spec());
  assert.match(again.url, new RegExp(ID));
  assert.equal(digitalocean.droplets.size, 1);
  // The second pass only looked: it made nothing.
  assert.deepEqual(
    digitalocean.calls.slice(before).filter((c) => c.method === "POST"),
    [],
  );
});

test("a creation that stopped half way is picked up where it was", async () => {
  // The Droplet was made, and the control plane lost its way before the workspace answered.
  digitalocean.failNext(/GET \/v2\/droplets\/\d+$/, 400, 1);
  await assert.rejects(provisioner().create(spec()), /answered 400/);
  assert.equal(digitalocean.droplets.size, 1);
  await provisioner().create(spec());
  assert.equal(digitalocean.droplets.size, 1);
  assert.equal(calls("POST", /^\/v2\/droplets$/).length, 1);
  assert.equal(digitalocean.dropletOf(ID)?.status, "active");
});

test("a Droplet that is off when a creation is repeated is started", async () => {
  const p = provisioner();
  await p.create(spec());
  await p.stop(ID);
  assert.equal(digitalocean.dropletOf(ID)?.status, "off");
  await p.create(spec());
  assert.equal(digitalocean.dropletOf(ID)?.status, "active");
  assert.equal(digitalocean.droplets.size, 1);
});

test("a Droplet that takes a while to boot is waited for", async () => {
  await digitalocean.close();
  digitalocean = await fakeDigitalOcean({ activeDelayMs: 80, bootDelayMs: 120 });
  const started = Date.now();
  await provisioner().create(spec());
  assert.ok(Date.now() - started >= 150);
  assert.equal(digitalocean.dropletOf(ID)?.status, "active");
});

test("a workspace that never answers fails with a message for the person, and the cause for the log", async () => {
  await digitalocean.close();
  digitalocean = await fakeDigitalOcean({ bootDelayMs: 60_000 });
  await assert.rejects(provisioner({ waitSeconds: 1 }).create(spec()), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /did not answer/);
    assert.match(error.userMessage, /Try again/);
    assert.equal(error.userMessage.includes("127.0.0.1"), false);
    return true;
  });
});

test("a Droplet that never becomes active is reported as that", async () => {
  await digitalocean.close();
  digitalocean = await fakeDigitalOcean({ activeDelayMs: 60_000 });
  await assert.rejects(provisioner({ waitSeconds: 1 }).create(spec()), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /did not become active/);
    assert.match(error.message, /it is new/);
    return true;
  });
});

test("a workspace that answers as a different one is refused", async () => {
  const p = provisioner({ waitSeconds: 1 });
  await p.create(spec());
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  // The Droplet's settings now name another workspace.
  droplet.userData = cloudConfig({ WORKSPACE_ID: "wsomeoneels" });
  await assert.rejects(p.create(spec()), /different workspace/);
});

test("DigitalOcean being busy or having a bad moment is tried again", async () => {
  digitalocean.failNext(/POST \/v2\/droplets$/, 429, 2, {
    "RateLimit-Reset": String(Date.now() / 1000 + 0.05),
  });
  digitalocean.failNext(/GET \/v2\/sizes$/, 503, 1);
  await provisioner().create(spec());
  assert.equal(digitalocean.droplets.size, 1);
  // A request that is refused for good is not tried again.
  digitalocean.failNext(/POST \/v2\/droplets$/, 403, 5);
  await assert.rejects(provisioner().create(spec({ workspaceId: "wother00001" })), /answered 403/);
  assert.equal(calls("POST", /^\/v2\/droplets$/).length, 4);
});

test("the error from DigitalOcean names the call and what it said but never the token", async () => {
  await digitalocean.close();
  digitalocean = await fakeDigitalOcean({ token: "right-token" });
  const wrong = provisioner({ token: "wrong-token-secret-value" });
  await assert.rejects(wrong.create(spec()), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /401/);
    assert.match(error.message, /Unable to authenticate you/);
    assert.equal(error.message.includes("wrong-token-secret-value"), false);
    assert.equal(error.userMessage.includes("401"), false);
    return true;
  });
});

// Sizes.

const sizeOf = (id: string) => digitalocean.dropletOf(id)?.size_slug;

test("without a size named, a plan gets the cheapest available one that fits it", async () => {
  await provisioner().create(spec());
  // Free is 2 shared vCPUs, 4 GB and 5 GB of disk: the premium AMD size is cheaper than the plain one.
  assert.equal(sizeOf(ID), "s-2vcpu-4gb-amd");
  // A dedicated plan asks for a dedicated-CPU family.
  const dedicated = {
    ...plans.team,
    guest: { cpuKind: "performance" as const, cpus: 2, memoryMb: 8192 },
  };
  await provisioner().create(spec({ workspaceId: "wdedicated01", plan: dedicated }));
  assert.equal(sizeOf("wdedicated01"), "g-2vcpu-8gb");
});

test("a size that is unavailable, in the wrong region or in the wrong family is never picked", async () => {
  await digitalocean.close();
  const sizes: FakeSize[] = [
    ...digitalocean.sizes.filter((s) => s.slug === "s-4vcpu-8gb" || s.slug === "gpu-h100x1-80gb"),
  ];
  digitalocean = await fakeDigitalOcean({ sizes });
  // Nothing available fits, and the message says so and says what to do.
  await assert.rejects(provisioner().create(spec()), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /no available size in nyc3/);
    assert.match(error.message, /DO_SIZE/);
    return true;
  });
  assert.equal(digitalocean.droplets.size, 0);
});

test("a region that offers no sizes at all is said to be out of capacity, not blamed on the size", async () => {
  await digitalocean.close();
  // What DigitalOcean listed for nyc3 one afternoon: the region is there and every size is somewhere else.
  const elsewhere: FakeSize[] = digitalocean.sizes.map((size) => ({ ...size, regions: ["sfo3"] }));
  digitalocean = await fakeDigitalOcean({ sizes: elsewhere });
  await assert.rejects(provisioner().create(spec()), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /offers no sizes in nyc3/);
    assert.match(error.message, /DO_REGION/);
    assert.doesNotMatch(error.message, /DO_SIZE/);
    return true;
  });
  assert.equal(digitalocean.droplets.size, 0);
});

test("a size named for a plan is used, and named for all plans when none is for this one", async () => {
  const p = provisioner({ size: "s-1vcpu-2gb", sizes: { team: "s-2vcpu-4gb" } });
  await p.create(spec());
  await p.create(spec({ workspaceId: "wteam000001", plan: plans.team }));
  assert.equal(sizeOf(ID), "s-1vcpu-2gb");
  assert.equal(sizeOf("wteam000001"), "s-2vcpu-4gb");
});

test("a size that does not exist, or is not available where the workspace is going, is an error", async () => {
  await assert.rejects(
    provisioner({ size: "s-9vcpu-1gb" }).create(spec()),
    /has no size s-9vcpu-1gb/,
  );
  await assert.rejects(
    provisioner({ size: "s5-1vcpu-1gb-30gb" }).create(spec()),
    /not available in nyc3/,
  );
  await assert.rejects(
    provisioner({ size: "s-4vcpu-8gb" }).create(spec()),
    /not available in nyc3/,
  );
  assert.equal(digitalocean.droplets.size, 0);
});

test("sizes that fill several pages are all considered", async () => {
  // One size to a page, and the only one that fits comes last.
  const all = digitalocean.sizes;
  const sizes = [
    ...all.filter((s) => s.slug !== "s-2vcpu-4gb" && s.slug !== "s-2vcpu-4gb-amd"),
    ...all.filter((s) => s.slug === "s-2vcpu-4gb"),
  ];
  await digitalocean.close();
  digitalocean = await fakeDigitalOcean({ pageSize: 1, sizes });
  await provisioner().create(spec());
  assert.equal(sizeOf(ID), "s-2vcpu-4gb");
  assert.ok(calls("GET", /^\/v2\/sizes/).length >= sizes.length);
});

// The image.

test("an image that is not where the workspace is going is refused before anything is made", async () => {
  await assert.rejects(provisioner({ region: "fra1" }).create(spec()), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /image 1234567 is not in fra1 yet \(it is in nyc3, sfo3\)/);
    return true;
  });
  assert.equal(digitalocean.droplets.size, 0);
  await assert.rejects(provisioner({ image: "999" }).create(spec()), /has no image 999/);
  // One still being made, or too big for the size, is no good either.
  const image = digitalocean.images.get(1234567);
  assert.ok(image);
  image.status = "new";
  await assert.rejects(provisioner().create(spec()), /is new, not available/);
  image.status = "available";
  image.min_disk_size = 500;
  await assert.rejects(provisioner().create(spec()), /needs 500 GB/);
});

test("a workspace can say where it runs", async () => {
  await provisioner().create(spec({ region: "sfo3" }));
  assert.equal(digitalocean.dropletOf(ID)?.region.slug, "sfo3");
});

test("SSH keys and a private network are given to the Droplet when the deployment has them", async () => {
  await provisioner({ sshKeys: ["12345", "ab:cd:ef:01"], vpcUuid: "vpc-abc" }).create(spec());
  const droplet = digitalocean.dropletOf(ID);
  assert.deepEqual(droplet?.sshKeys, [12345, "ab:cd:ef:01"]);
  assert.equal(droplet?.vpc_uuid, "vpc-abc");
});

// Waking, stopping, state.

test("state says what the Droplet is doing, and missing when there is none", async () => {
  const p = provisioner();
  assert.equal(await p.state(ID), "missing");
  await p.create(spec());
  assert.equal(await p.state(ID), "running");
  await p.stop(ID);
  assert.equal(await p.state(ID), "stopped");
});

test("waking powers on a Droplet that is off and waits for the workspace to answer", async () => {
  const p = provisioner();
  await p.create(spec());
  await p.stop(ID);
  await p.wake(ID);
  assert.equal(await p.state(ID), "running");
  assert.equal(
    calls("POST", /\/actions$/).filter((c) => (c.body as { type: string }).type === "power_on")
      .length,
    1,
  );
  // One that is already running is only waited for.
  await p.wake(ID);
  assert.equal(
    calls("POST", /\/actions$/).filter((c) => (c.body as { type: string }).type === "power_on")
      .length,
    1,
  );
});

test("a Droplet someone else has just powered on is only waited for", async () => {
  const p = provisioner();
  await p.create(spec());
  await p.stop(ID);
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  // It comes on between our looking and our asking.
  setTimeout(() => {
    droplet.status = "active";
  }, 60);
  digitalocean.failNext(
    /POST \/v2\/droplets\/\d+\/actions$/,
    422,
    1,
    undefined,
    "Droplet is already powered on.",
  );
  await p.wake(ID);
  assert.equal(await p.state(ID), "running");
  // Any other refusal is an error.
  await p.stop(ID);
  digitalocean.failNext(
    /POST \/v2\/droplets\/\d+\/actions$/,
    422,
    1,
    undefined,
    "Droplet is locked.",
  );
  await assert.rejects(p.wake(ID), /answered 422: Droplet is locked/);
});

test("waking a workspace with no Droplet says so", async () => {
  await assert.rejects(provisioner().wake("wnothere001"), (error: unknown) => {
    assert.ok(error instanceof ProvisionError);
    assert.match(error.message, /has no Droplet to start/);
    return true;
  });
});

test("stopping shuts the Droplet down cleanly and leaves one that is already off alone", async () => {
  const p = provisioner();
  await p.create(spec());
  await p.stop(ID);
  const [asked] = calls("POST", /\/actions$/);
  assert.deepEqual(asked?.body, { type: "shutdown" });
  assert.equal(digitalocean.droplets.size, 1);
  const before = calls("POST", /\/actions$/).length;
  await p.stop(ID);
  await p.stop("wnothere001");
  assert.equal(calls("POST", /\/actions$/).length, before);
});

test("a Droplet that will not shut down in time is powered off", async () => {
  const p = provisioner({ shutdownSeconds: 0.2 });
  await p.create(spec());
  digitalocean.hang("shutdown");
  await p.stop(ID);
  const asked = calls("POST", /\/actions$/).map((c) => (c.body as { type: string }).type);
  assert.deepEqual(asked, ["shutdown", "power_off"]);
  assert.equal(digitalocean.dropletOf(ID)?.status, "off");
});

// Destroying and finding.

test("destroying removes the Droplet by the tag only it has, and can be done again", async () => {
  const p = provisioner();
  await p.create(spec());
  await p.create(spec({ workspaceId: "wother00001" }));
  await p.destroy(ID);
  assert.equal(digitalocean.dropletOf(ID), undefined);
  assert.ok(digitalocean.dropletOf("wother00001"));
  const [deleted] = calls("DELETE", /^\/v2\/droplets/);
  assert.equal(deleted?.path, `/v2/droplets?tag_name=hive-ws-${ID}`);
  // Gone is gone: asking again, or for something that never was, is not an error.
  await p.destroy(ID);
  await p.destroy("wnever00001");
});

test("the edge is told where a running workspace is, on the private network unless told otherwise", async () => {
  const p = provisioner();
  assert.equal(await p.upstream(ID), null);
  await p.create(spec());
  const droplet = digitalocean.dropletOf(ID);
  const privateIp = droplet?.networks.v4.find((n) => n.type === "private")?.ip_address;
  const publicIp = droplet?.networks.v4.find((n) => n.type === "public")?.ip_address;
  assert.equal(await p.upstream(ID), `http://${privateIp}:8787`);
  assert.equal(
    await provisioner({ upstreamNetwork: "public" }).upstream(ID),
    `http://${publicIp}:8787`,
  );
});

test("a control plane that can reach the Droplet waits for the workspace at the Droplet's own address", async () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  // The Droplets' addresses are not real here: what is asked at one is answered as the workspace would.
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (/^http:\/\/(10\.116\.0|203\.0\.113)\.\d+:8787\/api\/health$/.test(url)) {
      asked.push(url);
      return realFetch(`${digitalocean.publicUrlTemplate.replace("{id}", ID)}/api/health`, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const nobody = "https://nobody-answers-here.invalid/{id}";
    const p = provisioner({ readyCheck: "droplet", publicUrlTemplate: nobody });
    // The apps are still given the public address; it was only not where the wait was.
    assert.equal((await p.create(spec())).url, nobody.replace("{id}", ID));
    assert.ok(asked.length > 0);
    assert.ok(
      asked.every((url) => /^http:\/\/10\.116\.0\.\d+:8787\//.test(url)),
      asked.join(),
    );

    asked.length = 0;
    await p.stop(ID);
    await p.wake(ID);
    assert.ok(asked.length > 0, "waking did not wait at the Droplet");

    // On the public network, it is the public address that is asked.
    asked.length = 0;
    await provisioner({
      readyCheck: "droplet",
      upstreamNetwork: "public",
      publicUrlTemplate: nobody,
    }).wake(ID);
    assert.ok(
      asked.every((url) => /^http:\/\/203\.0\.113\.\d+:8787\//.test(url)),
      asked.join(),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a workspace's address is remembered, so busy workspaces do not cost an API call each time", async () => {
  const p = provisioner();
  await p.create(spec());
  const first = await p.upstream(ID);
  const asked = digitalocean.calls.length;
  for (let i = 0; i < 50; i++) assert.equal(await p.upstream(ID), first);
  assert.equal(digitalocean.calls.length, asked);
  // Stopping, or destroying, forgets it.
  await p.stop(ID);
  assert.equal(await p.upstream(ID), null);
  await p.wake(ID);
  assert.equal(await p.upstream(ID), first);
  await p.destroy(ID);
  assert.equal(await p.upstream(ID), null);
});

test("names and tags are what DigitalOcean accepts", () => {
  const p = provisioner();
  assert.equal(p.dropletName("W4K9T2MX7A"), "hive-w4k9t2mx7a");
  assert.match(p.dropletName(ID), /^[a-z0-9-]+$/);
  assert.match(p.tagFor(ID), /^[a-z0-9:_-]{1,255}$/);
});

// Settings.

test("the DigitalOcean settings come from the environment, and say what is missing", () => {
  const full = {
    DO_API_TOKEN: "t",
    DO_IMAGE: "1234567",
    DO_PUBLIC_URL_TEMPLATE: "https://{id}.ws.example.com",
  };
  assert.throws(() => digitalOceanConfigFromEnv({}), /DO_API_TOKEN/);
  assert.throws(() => digitalOceanConfigFromEnv({ ...full, DO_IMAGE: " " }), /DO_IMAGE/);
  assert.throws(
    () => digitalOceanConfigFromEnv({ ...full, DO_PUBLIC_URL_TEMPLATE: undefined }),
    /DO_PUBLIC_URL_TEMPLATE/,
  );
  for (const bad of ["http://{id}.example.com", "https://example.com"])
    assert.throws(
      () => digitalOceanConfigFromEnv({ ...full, DO_PUBLIC_URL_TEMPLATE: bad }),
      /https address with \{id\}/,
    );
  assert.throws(
    () => digitalOceanConfigFromEnv({ ...full, DO_UPSTREAM_NETWORK: "lan" }),
    /private or public/,
  );
  assert.throws(
    () => digitalOceanConfigFromEnv({ ...full, DO_READY_CHECK: "edge" }),
    /public or droplet/,
  );
  assert.equal(
    digitalOceanConfigFromEnv({ ...full, DO_READY_CHECK: "droplet" }).readyCheck,
    "droplet",
  );
  const config = digitalOceanConfigFromEnv({
    ...full,
    HIVE_WORKSPACE_ENV: '{"MODEL":"m"}',
    DO_SIZE_TEAM: "s-2vcpu-4gb",
    DO_SSH_KEYS: "1, ab:cd ,",
    DO_EDGE_ADDRESSES: "198.51.100.7/32",
    DO_FIREWALL: "off",
  });
  assert.equal(config.region, "nyc3");
  assert.equal(config.namePrefix, "hive");
  assert.equal(config.apiUrl, "https://api.digitalocean.com/v2");
  assert.equal(config.edgeTag, "hive-edge");
  assert.equal(config.upstreamNetwork, "private");
  assert.equal(config.readyCheck, "public");
  assert.equal(config.waitSeconds, 300);
  assert.equal(config.firewall, false);
  assert.deepEqual(config.sizes, { team: "s-2vcpu-4gb" });
  assert.deepEqual(config.sshKeys, ["1", "ab:cd"]);
  assert.deepEqual(config.edgeAddresses, ["198.51.100.7/32"]);
  assert.deepEqual(config.workspaceEnv, { MODEL: "m" });
  assert.equal(digitalOceanConfigFromEnv(full).firewall, true);
});

test("PROVISIONER=digitalocean picks this provisioner, and says what to set otherwise", () => {
  const env = {
    PROVISIONER: "digitalocean",
    DO_API_TOKEN: "t",
    DO_IMAGE: "1",
    DO_PUBLIC_URL_TEMPLATE: "https://{id}.ws.example.com",
  };
  assert.equal(provisionerFromEnv(env).name, "digitalocean");
  assert.throws(() => provisionerFromEnv({ PROVISIONER: "nowhere" }), /fly or digitalocean/);
  assert.throws(() => provisionerFromEnv({ PROVISIONER: "digitalocean" }), /DO_API_TOKEN/);
});

// Regions: where a new workspace goes when one is full.

/** What DigitalOcean listed for nyc3 one afternoon: the region is there and none of its sizes are. */
const noRoomInNyc3 = () => {
  for (const size of digitalocean.sizes)
    size.regions = size.regions.filter((region) => region !== "nyc3");
};
/** The workspace image, in nyc3 only, as the snapshot was made. */
const imageInNyc3Only = () => {
  const image = digitalocean.images.get(1234567);
  assert.ok(image);
  image.regions = ["nyc3"];
  return image;
};

test("the first region is used while it has room", async () => {
  await provisioner({ regions: ["nyc3", "sfo3"] }).create(spec());
  assert.equal(digitalocean.dropletOf(ID)?.region.slug, "nyc3");
});

test("a workspace goes to the first region, in order, that has a size for it and the image", async () => {
  noRoomInNyc3();
  await provisioner({ regions: ["nyc3", "sfo3"] }).create(spec());
  assert.equal(digitalocean.dropletOf(ID)?.region.slug, "sfo3");
});

test("a region the image has not reached yet is passed over, and when none will do it is a matter of room", async () => {
  noRoomInNyc3();
  imageInNyc3Only();
  await assert.rejects(
    provisioner({ regions: ["nyc3", "sfo3"] }).create(spec()),
    (error: unknown) => {
      assert.ok(error instanceof ProvisionError);
      assert.equal(error.capacity, true);
      assert.match(error.message, /offers no sizes in nyc3/);
      assert.match(error.message, /not in sfo3 yet/);
      assert.match(error.userMessage, /out of room/);
      return true;
    },
  );
  assert.equal(digitalocean.droplets.size, 0);
});

test("a workspace that exists stays where it is, whatever the regions have become", async () => {
  const p = provisioner({ regions: ["nyc3", "sfo3"] });
  await p.create(spec());
  noRoomInNyc3();
  await p.create(spec());
  assert.equal(digitalocean.droplets.size, 1);
  assert.equal(digitalocean.dropletOf(ID)?.region.slug, "nyc3");
});

test("upkeep copies the image to the other regions, so a full region stops mattering", async () => {
  noRoomInNyc3();
  const image = imageInNyc3Only();
  const p = provisioner({ regions: ["nyc3", "sfo3"] });
  await p.maintain();
  assert.equal(calls("POST", /^\/v2\/images\/1234567\/actions$/).length, 1);
  assert.deepEqual([...image.regions].sort(), ["nyc3", "sfo3"]);
  await p.create(spec());
  assert.equal(digitalocean.dropletOf(ID)?.region.slug, "sfo3");
});

test("a copy that is under way is not asked for again, and once it is done upkeep only looks", async () => {
  await digitalocean.close();
  digitalocean = await fakeDigitalOcean({ holdTransfers: true });
  imageInNyc3Only();
  const p = provisioner({ regions: ["nyc3", "sfo3", "fra1"] }, digitalocean);
  await p.maintain();
  // Both missing regions were asked for at once; DigitalOcean does not say where a copy is going,
  // so until they are done nothing more is asked.
  assert.equal(calls("POST", /\/actions$/).length, 2);
  await p.maintain();
  await p.maintain();
  assert.equal(calls("POST", /\/actions$/).length, 2);
  digitalocean.finishTransfers();
  const before = digitalocean.calls.length;
  await p.maintain();
  assert.deepEqual(
    digitalocean.calls.slice(before).map((call) => call.method),
    ["GET"],
  );
});

test("with one region upkeep does nothing at all", async () => {
  const before = digitalocean.calls.length;
  await provisioner().maintain();
  assert.equal(digitalocean.calls.length, before);
});

test("a copy DigitalOcean refuses is logged, and not asked for again straight away", async () => {
  const logged = mock.method(console, "error", () => {});
  try {
    imageInNyc3Only();
    digitalocean.failNext(
      /POST \/v2\/images\/\d+\/actions$/,
      422,
      5,
      undefined,
      "that region is not open to you",
    );
    const p = provisioner({ regions: ["nyc3", "sfo3"] });
    await p.maintain();
    await p.maintain();
    assert.equal(calls("POST", /\/actions$/).length, 1);
    assert.match(
      String(logged.mock.calls[0]?.arguments[0]),
      /copy the workspace image to sfo3.*that region is not open to you/,
    );
  } finally {
    logged.mock.restore();
  }
});

test("DO_REGIONS lists the regions in order, DO_REGION stands alone, and a VPC fits one region only", () => {
  const full = {
    DO_API_TOKEN: "t",
    DO_IMAGE: "1234567",
    DO_PUBLIC_URL_TEMPLATE: "https://{id}.ws.example.com",
  };
  const one = digitalOceanConfigFromEnv({ ...full, DO_REGION: "sfo3" });
  assert.deepEqual([one.region, one.regions], ["sfo3", ["sfo3"]]);
  const many = digitalOceanConfigFromEnv({
    ...full,
    DO_REGIONS: " NYC3, tor1 ,ric1",
    DO_REGION: "sfo3",
  });
  assert.deepEqual([many.region, many.regions], ["nyc3", ["nyc3", "tor1", "ric1"]]);
  assert.throws(
    () => digitalOceanConfigFromEnv({ ...full, DO_REGIONS: "nyc3,tor1", DO_VPC_UUID: "vpc-1" }),
    /DO_VPC_UUID/,
  );
  assert.equal(
    digitalOceanConfigFromEnv({ ...full, DO_REGIONS: "nyc3", DO_VPC_UUID: "vpc-1" }).vpcUuid,
    "vpc-1",
  );
});

test("backups are asked for with the plan said outright, and not at all when off", async () => {
  await provisioner().create(spec());
  const [plain] = calls("POST", /^\/v2\/droplets$/);
  assert.ok(plain);
  assert.equal((plain.body as Record<string, unknown>).backups, false);
  assert.equal("backup_policy" in (plain.body as object), false);
  await digitalocean.close();

  digitalocean = await fakeDigitalOcean();
  await provisioner({ backups: "daily" }).create(spec());
  const [daily] = calls("POST", /^\/v2\/droplets$/);
  assert.ok(daily);
  const dailyBody = daily.body as Record<string, unknown>;
  assert.equal(dailyBody.backups, true);
  // Daily, in the window that starts at 08:00 UTC unless told otherwise, with no weekday.
  assert.deepEqual(dailyBody.backup_policy, { plan: "daily", hour: 8 });
  await digitalocean.close();

  digitalocean = await fakeDigitalOcean();
  await provisioner({ backups: "weekly", backupHour: 4 }).create(spec());
  const [weekly] = calls("POST", /^\/v2\/droplets$/);
  assert.ok(weekly);
  assert.deepEqual((weekly.body as Record<string, unknown>).backup_policy, {
    plan: "weekly",
    hour: 4,
    weekday: "SUN",
  });
});

test("DO_BACKUPS says which plan, DO_BACKUP_HOUR when, and anything else is off or refused", () => {
  const full = {
    DO_API_TOKEN: "t",
    DO_IMAGE: "1234567",
    DO_PUBLIC_URL_TEMPLATE: "https://{id}.ws.example.com",
  };
  assert.equal(digitalOceanConfigFromEnv(full).backups, undefined);
  for (const daily of ["on", "ON", "true", "1", " yes ", "daily"])
    assert.equal(digitalOceanConfigFromEnv({ ...full, DO_BACKUPS: daily }).backups, "daily", daily);
  assert.equal(digitalOceanConfigFromEnv({ ...full, DO_BACKUPS: "Weekly" }).backups, "weekly");
  for (const off of ["off", "false", "0", "", "maybe"])
    assert.equal(digitalOceanConfigFromEnv({ ...full, DO_BACKUPS: off }).backups, undefined, off);
  assert.equal(digitalOceanConfigFromEnv({ ...full, DO_BACKUP_HOUR: "12" }).backupHour, 12);
  for (const bad of ["7", "24", "noon"])
    assert.throws(
      () => digitalOceanConfigFromEnv({ ...full, DO_BACKUP_HOUR: bad }),
      /DO_BACKUP_HOUR/,
      bad,
    );
});
