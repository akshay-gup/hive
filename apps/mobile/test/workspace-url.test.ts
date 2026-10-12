import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalHost, normalizeWorkspaceUrl, workspaceLabel } from "../src/workspace-url.ts";

const accepted: [string, string][] = [
  ["hive.example.com", "https://hive.example.com"],
  ["  https://hive.example.com/  ", "https://hive.example.com"],
  ["https://hive.example.com/some/path?x=1#y", "https://hive.example.com"],
  ["HIVE.Example.com:8443", "https://hive.example.com:8443"],
  ["https://hive.example.com:443", "https://hive.example.com"],
  ["team-1.eu.example.com", "https://team-1.eu.example.com"],
  ["localhost:8787", "http://localhost:8787"],
  ["http://localhost:8787", "http://localhost:8787"],
  ["127.0.0.1:8787", "http://127.0.0.1:8787"],
  ["10.0.2.2:8787", "http://10.0.2.2:8787"],
  ["192.168.1.20", "http://192.168.1.20"],
  ["172.20.0.5:9000", "http://172.20.0.5:9000"],
  ["mac-mini.local:8787", "http://mac-mini.local:8787"],
  ["https://localhost:8443", "https://localhost:8443"],
  ["[::1]:8787", "http://[::1]:8787"],
  ["https://hive.example.com:80", "https://hive.example.com:80"],
];

test("addresses people type become a plain origin", () => {
  for (const [input, url] of accepted)
    assert.deepEqual(normalizeWorkspaceUrl(input), { url }, input);
});

const refused: [string, RegExp][] = [
  ["", /Enter your workspace address/],
  ["   ", /Enter your workspace address/],
  ["http://hive.example.com", /https/],
  ["http://8.8.8.8", /https/],
  ["http://172.32.0.1", /https/],
  ["ftp://hive.example.com", /web address/],
  ["javascript:alert(1)", /web address/],
  ["https://", /web address/],
  ["hive example.com", /web address/],
  ["-bad.example.com", /web address/],
  ["bad-.example.com", /web address/],
  ["a..b.example.com", /web address/],
  ["https://user@hive.example.com", /username/],
  ["https://user:secret@hive.example.com", /username/],
  ["hive.example.com:0", /port/],
  ["hive.example.com:70000", /port/],
  ["hive.example.com:abc", /web address/],
];

test("things that are not workspace addresses are refused with a reason", () => {
  for (const [input, reason] of refused) {
    const result = normalizeWorkspaceUrl(input);
    assert.ok("error" in result, `${input} should be refused`);
    assert.match(result.error, reason, input);
  }
});

test("only the device's own network may use plain http", () => {
  for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "x.local"])
    assert.equal(isLocalHost(host), true, host);
  for (const host of ["example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "local"])
    assert.equal(isLocalHost(host), false, host);
});

test("a workspace is shown without its scheme", () => {
  assert.equal(workspaceLabel("https://team.example.com"), "team.example.com");
  assert.equal(workspaceLabel("http://localhost:8787"), "localhost:8787");
});
