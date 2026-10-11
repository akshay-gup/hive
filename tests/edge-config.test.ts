import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedAddress, parseCidr, readEdgeConfig } from "../apps/edge/src/config.ts";

const environment = () => ({
  EDGE_DOMAIN: "ws.test",
  EDGE_CONTROL_URL: "http://127.0.0.1:8800",
  EDGE_TOKEN: "t".repeat(40),
  EDGE_TLS_CERT: "/certs/fullchain.pem",
  EDGE_TLS_KEY: "/certs/privkey.pem",
});

test("the edge's settings come from the environment, and say what is missing", () => {
  assert.throws(() => readEdgeConfig({}), /EDGE_DOMAIN/);
  const base: Record<string, string | undefined> = environment();
  assert.throws(() => readEdgeConfig({ ...base, EDGE_CONTROL_URL: undefined }), /EDGE_CONTROL_URL/);
  assert.throws(() => readEdgeConfig({ ...base, EDGE_TOKEN: undefined }), /EDGE_TOKEN/);
  assert.throws(() => readEdgeConfig({ ...base, EDGE_TOKEN: "short" }), /at least 32 characters/);
  assert.throws(() => readEdgeConfig({ ...base, EDGE_DOMAIN: "nodots" }), /domain name/);
  assert.throws(() => readEdgeConfig({ ...base, EDGE_CONTROL_URL: "ftp://x" }), /http or https/);
  assert.throws(
    () => readEdgeConfig({ ...base, EDGE_TLS_KEY: undefined }),
    /EDGE_TLS_CERT and EDGE_TLS_KEY/,
  );
  assert.throws(() => readEdgeConfig({ ...base, EDGE_HTTPS_PORT: "x" }), /port number/);
  assert.throws(
    () => readEdgeConfig({ ...base, EDGE_UPSTREAM_ALLOW: "10.0.0.0/8, 300.1.1.1/8" }),
    /not an IPv4 range/,
  );
  const config = readEdgeConfig({ ...base, EDGE_DOMAIN: "*.WS.Example.com." });
  assert.equal(config.domain, "ws.example.com");
  assert.equal(config.httpsPort, 443);
  assert.equal(config.httpPort, 80);
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(config.upstreamAllow, ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
  assert.equal(config.cacheMs, 60_000);
  assert.equal(readEdgeConfig({ ...base, EDGE_HTTP_PORT: "off" }).httpPort, null);
});

test("an address is in a range only when it is", () => {
  const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
  for (const inside of [
    "10.1.2.3",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
  ])
    assert.equal(allowedAddress(inside, privateRanges), true, inside);
  for (const outside of [
    "127.0.0.1",
    "11.0.0.1",
    "172.32.0.1",
    "172.15.255.255",
    "169.254.169.254",
    "8.8.8.8",
    "10.0.0.256",
    "localhost",
    "::1",
    "",
    "10.0.0",
  ])
    assert.equal(allowedAddress(outside, privateRanges), false, outside);
  assert.equal(allowedAddress("1.2.3.4", ["0.0.0.0/0"]), true);
  assert.equal(allowedAddress("1.2.3.4", ["1.2.3.4/32"]), true);
  assert.equal(allowedAddress("1.2.3.5", ["1.2.3.4/32"]), false);
  assert.deepEqual(parseCidr("10.0.0.0/8"), { base: 0x0a000000, mask: 0xff000000 });
  assert.throws(() => parseCidr("10.0.0.0"), /not an IPv4 range/);
  assert.throws(() => parseCidr("10.0.0.0/33"), /not an IPv4 range/);
});
