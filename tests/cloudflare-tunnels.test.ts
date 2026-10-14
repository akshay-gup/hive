import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CloudflareApi } from "../apps/control/src/cloudflare-api.ts";
import {
  CloudflareTunnels,
  cloudflareTunnelConfigFromEnv,
} from "../apps/control/src/cloudflare-tunnels.ts";
import { ProvisionError } from "../apps/control/src/provisioner.ts";
import { fakeCloudflare } from "./helpers/fake-cloudflare.ts";

let fake: Awaited<ReturnType<typeof fakeCloudflare>>;
let tunnels: CloudflareTunnels;
const config = (apiToken = "cf-test-token") => ({
  apiToken,
  accountId: fake.accountId,
  zoneId: fake.zoneId,
  apiUrl: fake.apiUrl,
  namePrefix: "hive",
  service: "http://localhost:8787",
  retryMs: 5,
});

beforeEach(async () => {
  fake = await fakeCloudflare();
  tunnels = new CloudflareTunnels(config());
});
afterEach(async () => {
  await fake.close();
});

const host = (id: string) => `ws-${id}.example.test`;

test("a workspace gets a tunnel that routes its address to its port, and a token to run it with", async () => {
  const { token } = await tunnels.ensure("wabc", host("wabc"));

  const [tunnel] = fake.liveTunnels();
  assert.equal(fake.liveTunnels().length, 1);
  assert.equal(tunnel?.name, "hive-ws-wabc");
  // Its routes are kept by Cloudflare, so the machine needs only the token.
  assert.equal(tunnel?.config_src, "cloudflare");
  assert.deepEqual(fake.configs.get(tunnel?.id as string), [
    { hostname: host("wabc"), service: "http://localhost:8787" },
    { service: "http_status:404" },
  ]);
  const [record] = [...fake.records.values()];
  assert.equal(fake.records.size, 1);
  assert.equal(record?.type, "CNAME");
  assert.equal(record?.name, host("wabc"));
  assert.equal(record?.content, `${tunnel?.id}.cfargotunnel.com`);
  assert.equal(record?.proxied, true);
  // It is the token of this tunnel and no other, so a machine that runs it is the tunnel's end.
  assert.equal(token, fake.tokenOf(tunnel?.id as string));
  assert.equal(fake.connect(token), true);
  assert.equal(fake.reaches(host("wabc")), true);
});

test("ensuring again changes nothing, and gives the same token", async () => {
  const first = await tunnels.ensure("wabc", host("wabc"));
  const second = await tunnels.ensure("wabc", host("wabc"));
  assert.equal(second.token, first.token);
  assert.equal(fake.liveTunnels().length, 1);
  assert.equal(fake.records.size, 1);
  const writes = fake.calls.filter((c) => c.method === "POST" && !c.path.includes("/token"));
  assert.equal(writes.length, 2, "one tunnel and one record were made, once");
});

test("two calls at once make one tunnel", async () => {
  const [a, b] = await Promise.all([
    tunnels.ensure("wabc", host("wabc")),
    tunnels.ensure("wabc", host("wabc")),
  ]);
  assert.equal(a.token, b.token);
  assert.equal(fake.liveTunnels().length, 1);
  assert.equal(fake.records.size, 1);
});

test("an address left pointing at a tunnel that is gone is pointed at the new one", async () => {
  await tunnels.ensure("wabc", host("wabc"));
  const [old] = fake.liveTunnels();
  (old as { deleted_at: string | null }).deleted_at = new Date().toISOString();

  const { token } = await tunnels.ensure("wabc", host("wabc"));
  const [now] = fake.liveTunnels();
  assert.notEqual(now?.id, old?.id);
  assert.equal(fake.records.size, 1);
  assert.equal([...fake.records.values()][0]?.content, `${now?.id}.cfargotunnel.com`);
  assert.equal(token, fake.tokenOf(now?.id as string));
});

test("a record of something else at the address is refused and left alone", async () => {
  const api = new CloudflareApi({ token: fake.token, apiUrl: fake.apiUrl });
  await api.call("POST", `/zones/${fake.zoneId}/dns_records`, {
    type: "CNAME",
    name: host("wabc"),
    content: "www.example.com",
    proxied: true,
    ttl: 1,
  });
  await assert.rejects(
    () => tunnels.ensure("wabc", host("wabc")),
    (error: Error) => error instanceof ProvisionError && error.message.includes(host("wabc")),
  );
  assert.equal([...fake.records.values()][0]?.content, "www.example.com");
});

test("removing takes the address, the connection and the tunnel away, and only this workspace's", async () => {
  const mine = await tunnels.ensure("wabc", host("wabc"));
  await tunnels.ensure("wxyz", host("wxyz"));
  fake.connect(mine.token);
  assert.equal(fake.reaches(host("wabc")), true);

  await tunnels.remove("wabc", host("wabc"));
  assert.equal(fake.reaches(host("wabc")), false);
  assert.deepEqual(
    fake.liveTunnels().map((t) => t.name),
    ["hive-ws-wxyz"],
  );
  assert.deepEqual(
    [...fake.records.values()].map((r) => r.name),
    [host("wxyz")],
  );

  // Gone already is not an error.
  await tunnels.remove("wabc", host("wabc"));
  await tunnels.remove("wnever", host("wnever"));
});

test("removing does not delete a record that is not a tunnel's", async () => {
  const api = new CloudflareApi({ token: fake.token, apiUrl: fake.apiUrl });
  await api.call("POST", `/zones/${fake.zoneId}/dns_records`, {
    type: "CNAME",
    name: host("wabc"),
    content: "www.example.com",
    ttl: 1,
  });
  await tunnels.remove("wabc", host("wabc"));
  assert.equal(fake.records.size, 1);
});

test("a busy or failing Cloudflare is tried again", async () => {
  fake.failNext(/token$/, 502, 1);
  fake.failNext(/\/cfd_tunnel$/, 429, 1);
  const { token } = await tunnels.ensure("wabc", host("wabc"));
  assert.equal(token, fake.tokenOf(fake.liveTunnels()[0]?.id as string));
});

test("a refusal says who refused, and never shows the API token", async () => {
  const wrong = new CloudflareTunnels(config("cf-the-wrong-token"));
  await assert.rejects(
    () => wrong.ensure("wabc", host("wabc")),
    (error: Error) =>
      error instanceof ProvisionError &&
      error.message.startsWith("Cloudflare: ") &&
      error.message.includes("403") &&
      !error.message.includes("cf-the-wrong-token") &&
      !JSON.stringify(error).includes("cf-the-wrong-token"),
  );
  assert.equal(fake.liveTunnels().length, 0);
});

test("lists are read page by page", async () => {
  await fake.close();
  fake = await fakeCloudflare({ pageSize: 1 });
  const api = new CloudflareApi({ token: fake.token, apiUrl: fake.apiUrl });
  for (const name of ["a", "b", "c"])
    await api.call("POST", `/zones/${fake.zoneId}/dns_records`, {
      type: "CNAME",
      name: `${name}.example.test`,
      content: "x.example.com",
    });
  const found = await api.all<{ name: string }>(`/zones/${fake.zoneId}/dns_records`);
  assert.deepEqual(found.map((r) => r.name).sort(), [
    "a.example.test",
    "b.example.test",
    "c.example.test",
  ]);
});

test("the settings come from CLOUDFLARE_*, and the first one missing is named", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ACCOUNT_ID: "a",
    CLOUDFLARE_ZONE_ID: "z",
  };
  const made = cloudflareTunnelConfigFromEnv(env, "hive", "http://localhost:8787");
  assert.equal(made.apiUrl, "https://api.cloudflare.com/client/v4");
  assert.equal(made.zoneId, "z");
  for (const name of Object.keys(env))
    assert.throws(
      () => cloudflareTunnelConfigFromEnv({ ...env, [name]: " " }, "hive", "http://localhost:8787"),
      new RegExp(name),
    );
});
