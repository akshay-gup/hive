import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  type DigitalOceanConfig,
  DigitalOceanProvisioner,
  digitalOceanConfigFromEnv,
} from "../apps/control/src/digitalocean.ts";
import { plans } from "../apps/control/src/plans.ts";
import { ProvisionError, type WorkspaceSpec } from "../apps/control/src/provisioner.ts";
import { generateWorkspaceKeys } from "../packages/integrations/src/workspace-token.ts";
import { fakeCloudflare } from "./helpers/fake-cloudflare.ts";
import { fakeDigitalOcean } from "./helpers/fake-do.ts";

let digitalocean: Awaited<ReturnType<typeof fakeDigitalOcean>>;
let cloudflare: Awaited<ReturnType<typeof fakeCloudflare>>;
const keys = generateWorkspaceKeys();
const ID = "w4k9t2mx7a";

const spec = (): WorkspaceSpec => ({
  workspaceId: ID,
  name: "Acme",
  plan: plans.free,
  controlPublicKey: keys.publicKey,
  allowedOrigins: ["https://app.example.test"],
});

/**
 * The workspace's address, which the stand-in DigitalOcean answers health checks at. Its host is an
 * address and not a name, so one workspace at a time is under test here; the tunnel code is tested
 * with several in cloudflare-tunnels.test.ts.
 */
const hostname = () => new URL(digitalocean.publicUrlTemplate.replace("{id}", ID)).hostname;

const provisioner = (over: Partial<DigitalOceanConfig> = {}) =>
  new DigitalOceanProvisioner({
    token: digitalocean.token,
    image: "1234567",
    region: "nyc3",
    sizes: {},
    sshKeys: [],
    namePrefix: "hive",
    workspaceEnv: { MODEL: "anthropic/test-model" },
    apiUrl: digitalocean.apiUrl,
    publicUrlTemplate: digitalocean.publicUrlTemplate,
    tunnel: {
      apiToken: cloudflare.token,
      accountId: cloudflare.accountId,
      zoneId: cloudflare.zoneId,
      apiUrl: cloudflare.apiUrl,
      namePrefix: "hive",
      service: "http://localhost:8787",
      retryMs: 5,
    },
    firewall: true,
    edgeTag: "hive-edge",
    edgeAddresses: [],
    upstreamNetwork: "private",
    waitSeconds: 5,
    pollMs: 20,
    retryMs: 5,
    ...over,
  });

beforeEach(async () => {
  cloudflare = await fakeCloudflare();
  digitalocean = await fakeDigitalOcean({
    activeDelayMs: 10,
    bootDelayMs: 10,
    actionDelayMs: 10,
    // What stands in front of the workspace's address is Cloudflare. A Droplet that is up runs
    // `cloudflared` with the token its first boot wrote; one that is off does not; and a visitor gets
    // through only if the address leads to a tunnel that has a connection.
    resolve: async (id) => {
      const droplet = digitalocean.dropletOf(id);
      const token = droplet && digitalocean.tunnelTokenOf(droplet);
      if (token) {
        if (droplet?.status === "active") cloudflare.connect(token);
        else cloudflare.disconnect(token);
      }
      const reached = cloudflare.reaches(hostname());
      return { known: reached, upstream: reached ? "tunnel" : null };
    },
  });
});
afterEach(async () => {
  await digitalocean.close();
  await cloudflare.close();
});

test("with a tunnel, a firewall that cannot be made is logged with the reason and the workspace still starts", async () => {
  const logged = mock.method(console, "error", () => {});
  try {
    digitalocean.failNext(/POST \/v2\/firewalls$/, 422, 1, undefined, "ports are not valid");
    await provisioner().create(spec());
    assert.ok(digitalocean.dropletOf(ID));
    assert.equal(digitalocean.firewalls.size, 0);
    const said = logged.mock.calls.map((call) => String(call.arguments[0])).join("\n");
    assert.match(said, /hive-workspaces could not be made/);
    assert.match(said, /ports are not valid/);
  } finally {
    logged.mock.restore();
  }
});

test("it says which step it is on as it goes, starting with the address", async () => {
  const steps: string[] = [];
  await provisioner().create(spec(), (step) => steps.push(step));
  assert.deepEqual(steps, ["address", "machine", "starting", "checking"]);
});

test("a workspace is reached through a tunnel its Droplet runs, and answers only through it", async () => {
  const result = await provisioner().create(spec());
  assert.equal(result.url, digitalocean.publicUrlTemplate.replace("{id}", ID));

  const [tunnel] = cloudflare.liveTunnels();
  assert.equal(cloudflare.liveTunnels().length, 1);
  assert.equal(tunnel?.name, `hive-ws-${ID}`);
  const [record] = [...cloudflare.records.values()];
  assert.equal(record?.content, `${tunnel?.id}.cfargotunnel.com`);
  assert.equal(record?.name, hostname());

  // The Droplet was given this tunnel's token, in a file of its own that only root can read.
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  assert.equal(digitalocean.tunnelTokenOf(droplet), cloudflare.tokenOf(tunnel?.id as string));
  assert.match(
    droplet.userData,
    /path: \/etc\/hive\/tunnel-token\n {4}owner: root:root\n {4}permissions: "0600"/,
  );
  assert.match(droplet.userData, /systemctl, start, --no-block, hive-tunnel\.service/);
  assert.match(droplet.userData, /systemctl, start, --no-block, hive-workspace\.service/);

  // The workspace's settings, which its processes are given, do not hold it, and the server
  // listens for nothing but the tunnel's connector on the machine itself.
  const settings = digitalocean.settingsOf(droplet) ?? {};
  assert.equal(settings.HOST, "127.0.0.1");
  assert.equal(
    JSON.stringify(settings).includes(digitalocean.tunnelTokenOf(droplet) as string),
    false,
  );
  assert.equal(settings.PUBLIC_API_URL, result.url);

  // Nothing is let in: no rule for the edge, no rule for anyone.
  const [firewall] = [...digitalocean.firewalls.values()];
  assert.deepEqual(firewall?.inbound_rules, []);
  assert.ok((firewall?.outbound_rules.length ?? 0) > 0);
});

test("each service is given only its own credential", async () => {
  await provisioner().create(spec());
  for (const call of digitalocean.calls)
    assert.equal(JSON.stringify(call.body ?? "").includes(cloudflare.token), false);
  for (const call of cloudflare.calls)
    assert.equal(JSON.stringify(call.body ?? "").includes(digitalocean.token), false);
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  assert.equal(Buffer.from(droplet.userData).includes(cloudflare.token), false);
  assert.equal(droplet.userData.includes(cloudflare.token), false);
});

test("a workspace whose Droplet has another tunnel's token is not reached", async () => {
  const p = provisioner({ waitSeconds: 1 });
  // A Droplet made with the wrong token: the address leads to the right tunnel, which no one connects to.
  const tunnels = (
    p as unknown as { tunnels: { ensure: (id: string, host: string) => Promise<unknown> } }
  ).tunnels;
  const real = tunnels.ensure.bind(tunnels);
  tunnels.ensure = async (id, host) => {
    await real(id, host);
    return { token: Buffer.from(JSON.stringify({ a: "x", t: "y", s: "z" })).toString("base64") };
  };
  await assert.rejects(
    () => p.create(spec()),
    (error: Error) => error instanceof ProvisionError && /did not answer/.test(error.message),
  );
});

test("creating again finds the Droplet and the tunnel and makes no more", async () => {
  const p = provisioner();
  await p.create(spec());
  const before = digitalocean.droplets.size;
  await p.create(spec());
  assert.equal(digitalocean.droplets.size, before);
  assert.equal(cloudflare.liveTunnels().length, 1);
  assert.equal(cloudflare.records.size, 1);
  assert.equal(
    digitalocean.tunnelTokenOf(digitalocean.dropletOf(ID) as never),
    cloudflare.tokenOf(cloudflare.liveTunnels()[0]?.id as string),
  );
});

test("stopped, it is not reached; woken, it is, through the same tunnel", async () => {
  const p = provisioner();
  await p.create(spec());
  const [tunnel] = cloudflare.liveTunnels();

  await p.stop(ID);
  assert.equal(await p.state(ID), "stopped");
  // The Droplet's connector goes down with it.
  const token = digitalocean.tunnelTokenOf(digitalocean.dropletOf(ID) as never) as string;
  cloudflare.disconnect(token);
  assert.equal(cloudflare.reaches(hostname()), false);

  await p.wake(ID);
  assert.equal(cloudflare.reaches(hostname()), true);
  assert.equal(cloudflare.liveTunnels().length, 1);
  assert.equal(cloudflare.liveTunnels()[0]?.id, tunnel?.id);
});

test("nothing listens on the Droplet's network, so there is no upstream to give", async () => {
  const p = provisioner();
  await p.create(spec());
  assert.equal(await p.upstream(ID), null);
});

test("destroying takes the Droplet, then the tunnel and its address, and can be repeated", async () => {
  const p = provisioner();
  await p.create(spec());
  assert.equal(cloudflare.reaches(hostname()), true);

  // Cloudflare fails every try of one call (it is tried four times): the Droplet is gone, the tunnel is not, and a second call finishes it.
  cloudflare.failNext(/^DELETE \/accounts\/[^/]+\/cfd_tunnel\/[\w-]+$/, 500, 4);
  await assert.rejects(
    () => p.destroy(ID),
    (error: Error) => error instanceof ProvisionError && error.message.startsWith("Cloudflare: "),
  );
  assert.equal(digitalocean.dropletOf(ID), undefined);
  assert.equal(cloudflare.liveTunnels().length, 1);

  await p.destroy(ID);
  assert.equal(cloudflare.liveTunnels().length, 0);
  assert.equal(cloudflare.records.size, 0);
  await p.destroy(ID);
});

test("without a tunnel, the Droplet is made for the edge as before", async () => {
  await provisioner({ tunnel: undefined })
    .create(spec())
    .catch(() => undefined);
  const droplet = digitalocean.dropletOf(ID);
  assert.ok(droplet);
  assert.equal(droplet.userData.includes("tunnel-token"), false);
  assert.equal(droplet.userData.includes("hive-tunnel"), false);
  assert.equal(digitalocean.settingsOf(droplet)?.HOST, "0.0.0.0");
  assert.equal(cloudflare.calls.length, 0);
  const [firewall] = [...digitalocean.firewalls.values()];
  assert.equal(firewall?.inbound_rules.length, 1);
});

test("DO_ACCESS=tunnel takes its settings from CLOUDFLARE_*, and refuses what cannot work", () => {
  const base = {
    DO_API_TOKEN: "t",
    DO_IMAGE: "1",
    DO_PUBLIC_URL_TEMPLATE: "https://ws-{id}.example.com",
    CLOUDFLARE_API_TOKEN: "c",
    CLOUDFLARE_ACCOUNT_ID: "a",
    CLOUDFLARE_ZONE_ID: "z",
  };
  // Left alone, workspaces are reached through the edge.
  assert.equal(digitalOceanConfigFromEnv(base).tunnel, undefined);

  const made = digitalOceanConfigFromEnv({ ...base, DO_ACCESS: "tunnel", DO_NAME_PREFIX: "Acme" });
  assert.deepEqual(
    { ...made.tunnel },
    {
      apiToken: "c",
      accountId: "a",
      zoneId: "z",
      apiUrl: "https://api.cloudflare.com/client/v4",
      namePrefix: "acme",
      service: "http://localhost:8787",
    },
  );
  assert.throws(
    () => digitalOceanConfigFromEnv({ ...base, DO_ACCESS: "tunnel", CLOUDFLARE_ZONE_ID: "" }),
    /CLOUDFLARE_ZONE_ID/,
  );
  assert.throws(
    () => digitalOceanConfigFromEnv({ ...base, DO_ACCESS: "tunnel", DO_READY_CHECK: "droplet" }),
    /DO_READY_CHECK/,
  );
  assert.throws(() => digitalOceanConfigFromEnv({ ...base, DO_ACCESS: "vpn" }), /DO_ACCESS/);
});
