import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readControlConfig } from "../apps/control/src/config.ts";
import { loadSigningKeys } from "../apps/control/src/signing.ts";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
  verifyWorkspaceToken,
} from "../packages/integrations/src/workspace-token.ts";

test("a control plane starts as a sample one on a laptop", () => {
  const config = readControlConfig({});
  assert.equal(config.mode, "sample");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8800);
  assert.equal(config.publicUrl, "http://localhost:8800");
  assert.equal(config.maxWorkspacesPerAccount, 3);
  assert.equal(config.googleRedirectUri, "http://localhost:8800/v1/auth/google/callback");
  assert.deepEqual(config.allowedOrigins, ["http://localhost:8081", "http://127.0.0.1:8081"]);
  assert.deepEqual(readControlConfig({ CONTROL_ALLOWED_ORIGINS: "" }).allowedOrigins, []);
  assert.equal(config.clientIpHeader, undefined);
  assert.equal(
    readControlConfig({ CONTROL_CLIENT_IP_HEADER: " Fly-Client-IP " }).clientIpHeader,
    "Fly-Client-IP",
  );
});

test("a sample control plane refuses to listen beyond the machine it is on", () => {
  assert.throws(() => readControlConfig({ CONTROL_HOST: "0.0.0.0" }), /local-only/);
  assert.equal(readControlConfig({ CONTROL_HOST: "::1" }).host, "::1");
});

test("a live control plane signs in with Google and is served over https", () => {
  const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
  assert.throws(
    () => readControlConfig({ CONTROL_MODE: "live", CONTROL_PUBLIC_URL: "https://hive.example" }),
    /GOOGLE_CLIENT_ID/,
  );
  assert.throws(
    () =>
      readControlConfig({
        CONTROL_MODE: "live",
        CONTROL_PUBLIC_URL: "http://hive.example",
        ...google,
      }),
    /https/,
  );
  const live = readControlConfig({
    CONTROL_MODE: "live",
    CONTROL_HOST: "0.0.0.0",
    CONTROL_PUBLIC_URL: "https://hive.example/",
    CONTROL_ALLOWED_ORIGINS: " https://a.example , https://b.example ,",
    ...google,
  });
  assert.equal(live.publicUrl, "https://hive.example");
  assert.equal(live.googleRedirectUri, "https://hive.example/v1/auth/google/callback");
  assert.deepEqual(live.allowedOrigins, ["https://a.example", "https://b.example"]);
});

test("the edge proxy's token is optional, and not a weak one", () => {
  assert.equal(readControlConfig({}).edgeToken, undefined);
  assert.equal(readControlConfig({ CONTROL_EDGE_TOKEN: "  " }).edgeToken, undefined);
  const token = "t".repeat(32);
  assert.equal(readControlConfig({ CONTROL_EDGE_TOKEN: ` ${token} ` }).edgeToken, token);
  assert.throws(
    () => readControlConfig({ CONTROL_EDGE_TOKEN: "short" }),
    /CONTROL_EDGE_TOKEN must be at least 32 characters/,
  );
});

test("settings that cannot work are refused by name", () => {
  assert.throws(() => readControlConfig({ CONTROL_MODE: "maybe" }), /CONTROL_MODE/);
  assert.throws(() => readControlConfig({ CONTROL_PORT: "http" }), /CONTROL_PORT/);
  assert.throws(() => readControlConfig({ CONTROL_PORT: "70000" }), /CONTROL_PORT/);
  assert.throws(() => readControlConfig({ CONTROL_MAX_WORKSPACES: "0" }), /CONTROL_MAX_WORKSPACES/);
});

test("the signing key is made once, kept private, and found again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hive-signing-"));
  try {
    const [first, second] = await Promise.all([
      loadSigningKeys(directory, {}),
      loadSigningKeys(directory, {}),
    ]);
    // Two starts at once end up with the same key, whichever wrote the file.
    assert.equal(first.privateKey, second.privateKey);
    assert.equal(first.publicKey, second.publicKey);
    const again = await loadSigningKeys(directory, {});
    assert.equal(again.privateKey, first.privateKey);
    assert.equal((await stat(join(directory, "signing-key"))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(directory, "signing-key"), "utf8")).trim(), first.privateKey);
    // A token it signs verifies against the key it hands out.
    const token = signWorkspaceToken(first.privateKey, {
      workspaceId: "w1",
      sub: "a",
      email: "a@example.com",
      name: "A",
      role: "member",
    });
    verifyWorkspaceToken(first.publicKey, token, { workspaceId: "w1" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a signing key from the environment wins, and gives its public key", async () => {
  const keys = generateWorkspaceKeys();
  const directory = await mkdtemp(join(tmpdir(), "hive-signing-env-"));
  try {
    const loaded = await loadSigningKeys(directory, {
      CONTROL_SIGNING_KEY: `  ${keys.privateKey} `,
    });
    assert.equal(loaded.privateKey, keys.privateKey);
    assert.equal(loaded.publicKey, keys.publicKey);
    // Nothing is written when the key is given.
    await assert.rejects(stat(join(directory, "signing-key")), /ENOENT/);
    await assert.rejects(
      loadSigningKeys(directory, { CONTROL_SIGNING_KEY: "nonsense" }),
      /Ed25519/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
