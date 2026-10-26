import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWorkerUrl, shadowedEnvKeys } from "../apps/server/src/config.ts";

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  };
  try {
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a managed workspace needs both its id and the control plane's key, and runs live", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const { generateWorkspaceKeys } = await import("../packages/integrations/src/workspace-token.ts");
  const { randomBytes } = await import("node:crypto");
  const keys = generateWorkspaceKeys();
  const names = [
    "WORKSPACE_MODE",
    "WORKSPACE_ID",
    "CONTROL_PLANE_PUBLIC_KEY",
    "TOKEN_ENCRYPTION_KEY",
  ];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.WORKSPACE_ID;
    delete process.env.CONTROL_PLANE_PUBLIC_KEY;
    process.env.WORKSPACE_MODE = "live";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.equal(readConfig().managed, undefined);
    process.env.WORKSPACE_ID = "w1abc";
    assert.throws(() => readConfig(), /both WORKSPACE_ID and CONTROL_PLANE_PUBLIC_KEY/);
    delete process.env.WORKSPACE_ID;
    process.env.CONTROL_PLANE_PUBLIC_KEY = keys.publicKey;
    assert.throws(() => readConfig(), /both WORKSPACE_ID and CONTROL_PLANE_PUBLIC_KEY/);
    process.env.WORKSPACE_ID = "w1abc";
    process.env.CONTROL_PLANE_PUBLIC_KEY = "nonsense";
    assert.throws(() => readConfig(), /Ed25519/);
    process.env.CONTROL_PLANE_PUBLIC_KEY = keys.publicKey;
    assert.deepEqual(readConfig().managed, {
      workspaceId: "w1abc",
      controlPublicKey: keys.publicKey,
    });
    process.env.WORKSPACE_MODE = "sample";
    assert.throws(() => readConfig(), /live mode/);
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("browser worker URL keeps an existing scheme and adds http to host:port", () => {
  assert.equal(browserWorkerUrl(undefined), undefined);
  assert.equal(browserWorkerUrl("  "), undefined);
  assert.equal(browserWorkerUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(browserWorkerUrl("https://browser.internal:8790"), "https://browser.internal:8790");
  assert.equal(browserWorkerUrl("hive-browser-h4fx:8790"), "http://hive-browser-h4fx:8790");
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});
