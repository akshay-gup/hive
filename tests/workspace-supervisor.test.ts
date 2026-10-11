import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentEnv,
  loadSecrets,
  OPENCODE_URL,
  readEnvFile,
  Supervisor,
  type SupervisorSpec,
  serverEnv,
  withEnvFile,
} from "../apps/workspace/src/supervisor.ts";

const stub = (name: string) => fileURLToPath(new URL(`./helpers/${name}`, import.meta.url));
let dir: string;
let markers: string;
const secrets = {
  tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  opencodePassword: "p".repeat(64),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-supervisor-"));
  markers = join(dir, "markers");
  writeFileSync(markers, "");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
/** Every mark a stand-in made: who, what, and when. */
const events = () =>
  readFileSync(markers, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [who, what, at] = line.split(" ");
      return { who, what, at: Number(at) };
    });
const when = (who: string, what: string) =>
  events().find((e) => e.who === who && e.what === what)?.at;
const saw = (who: string, what: string) => events().some((e) => e.who === who && e.what === what);
const settle = async (until: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(until(), "condition was not reached in time");
};

async function setup(
  over: {
    agent?: Record<string, string>;
    server?: Record<string, string>;
    timeout?: number;
    grace?: number;
  } = {},
) {
  const port = await freePort();
  const lines: string[] = [];
  const common = {
    MARKERS: markers,
    STUB_PORT: String(port),
    OPENCODE_SERVER_PASSWORD: secrets.opencodePassword,
    OPENCODE_SERVER_URL: `http://127.0.0.1:${port}`,
  };
  const spec: SupervisorSpec = {
    agent: {
      name: "opencode",
      command: [process.execPath, stub("stub-agent.mjs")],
      env: { ...common, ...over.agent },
      healthUrl: `http://127.0.0.1:${port}/global/health`,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${secrets.opencodePassword}`).toString("base64")}`,
      },
    },
    server: {
      name: "hive",
      command: [process.execPath, stub("stub-hive.mjs")],
      env: { ...common, ...over.server },
    },
    healthTimeoutMs: over.timeout ?? 10_000,
    graceMs: over.grace ?? 5000,
    pollMs: 20,
    log: (line) => lines.push(line),
  };
  return { supervisor: new Supervisor(spec), lines };
}

test("a workspace makes its secrets once, keeps them private, and finds them again", () => {
  const first = loadSecrets(join(dir, "volume"));
  assert.equal(Buffer.from(first.tokenEncryptionKey, "base64").length, 32);
  assert.ok(first.opencodePassword.length >= 32);
  assert.equal(statSync(join(dir, "volume", "secrets.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "volume")).mode & 0o777, 0o700);
  assert.deepEqual(loadSecrets(join(dir, "volume")), first);
  // Another workspace's are its own.
  assert.notEqual(loadSecrets(join(dir, "other")).tokenEncryptionKey, first.tokenEncryptionKey);
});

test("secrets that cannot be read are an error, and are never replaced", () => {
  const file = join(dir, "secrets.json");
  for (const damaged of [
    "{not json",
    "{}",
    JSON.stringify({ tokenEncryptionKey: "short", opencodePassword: "x" }),
  ]) {
    writeFileSync(file, damaged);
    assert.throws(() => loadSecrets(dir), /damaged/);
    assert.equal(readFileSync(file, "utf8"), damaged);
  }
});

test("settings kept in a file are laid over the environment, and win over the machine's defaults", () => {
  const file = join(dir, "workspace.json");
  writeFileSync(file, JSON.stringify({ WORKSPACE_ID: "w9", MODEL: "anthropic/test-model" }));
  const env = withEnvFile({
    PATH: "/usr/bin",
    WORKSPACE_ID: "the-default",
    PORT: "8787",
    HIVE_ENV_FILE: file,
  });
  assert.equal(env.WORKSPACE_ID, "w9");
  assert.equal(env.MODEL, "anthropic/test-model");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.PORT, "8787");
  // The file's name is not passed on to the agent or the server.
  assert.equal("HIVE_ENV_FILE" in env, false);
  // With none named, the environment is left exactly as it is.
  const plain = { PATH: "/usr/bin" };
  assert.equal(withEnvFile(plain), plain);
  assert.equal(withEnvFile({ HIVE_ENV_FILE: "  " }).HIVE_ENV_FILE, "  ");
});

test("a settings file that cannot be used stops the workspace without repeating what it holds", () => {
  const file = join(dir, "workspace.json");
  assert.throws(() => readEnvFile(file), /could not be read \(ENOENT\)/);
  writeFileSync(file, '{"ANTHROPIC_API_KEY": "sk-secret-value", ');
  assert.throws(
    () => readEnvFile(file),
    (error: unknown) => {
      assert.match((error as Error).message, /is not valid JSON/);
      assert.equal((error as Error).message.includes("sk-secret-value"), false);
      return true;
    },
  );
  writeFileSync(file, "[1]");
  assert.throws(() => readEnvFile(file), /must be a JSON object of strings/);
  writeFileSync(file, '{"PORT": 8787}');
  assert.throws(() => readEnvFile(file), /must be a JSON object of strings/);
  writeFileSync(file, "null");
  assert.throws(() => readEnvFile(file), /must be a JSON object of strings/);
});

test("the agent runs on the volume, pinned and not sharing, without the server's own settings", () => {
  const env = agentEnv(
    {
      PATH: "/usr/bin",
      MODEL: "anthropic/test-model",
      ANTHROPIC_API_KEY: "provider-key",
      TOKEN_ENCRYPTION_KEY: "server-only",
      GOOGLE_CLIENT_SECRET: "server-only",
      DATABASE_URL: "postgres://server-only",
      WORKER_TOKEN: "server-only",
      UNSET: undefined,
    },
    secrets,
    "/data",
    "/home/hive",
  );
  assert.equal(env.MODEL, "anthropic/test-model");
  assert.equal(env.ANTHROPIC_API_KEY, "provider-key");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/hive");
  assert.equal(env.XDG_DATA_HOME, "/data/opencode/data");
  assert.equal(env.XDG_STATE_HOME, "/data/opencode/state");
  assert.equal(env.OPENCODE_SERVER_PASSWORD, secrets.opencodePassword);
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "true");
  assert.equal(env.OPENCODE_DISABLE_SHARE, "true");
  for (const name of [
    "TOKEN_ENCRYPTION_KEY",
    "GOOGLE_CLIENT_SECRET",
    "DATABASE_URL",
    "WORKER_TOKEN",
    "UNSET",
  ])
    assert.equal(name in env, false, name);
  assert.equal(JSON.stringify(env).includes(secrets.tokenEncryptionKey), false);
});

test("the server gets its secrets and the way to the agent, over whatever the machine set", () => {
  const env = serverEnv(
    {
      WORKSPACE_ID: "w1",
      TOKEN_ENCRYPTION_KEY: "from-outside",
      OPENCODE_SERVER_URL: "http://elsewhere",
    },
    secrets,
  );
  assert.equal(env.WORKSPACE_ID, "w1");
  assert.equal(env.TOKEN_ENCRYPTION_KEY, secrets.tokenEncryptionKey);
  assert.equal(env.OPENCODE_SERVER_URL, OPENCODE_URL);
  assert.equal(env.OPENCODE_SERVER_PASSWORD, secrets.opencodePassword);
});

test("the server starts only once the agent answers, and both stop when asked, server first", async () => {
  const { supervisor, lines } = await setup({ agent: { STUB_DELAY_MS: "400" } });
  const done = supervisor.run();
  await settle(() => saw("hive", "started-with-agent"));
  // It never started while the agent was still coming up.
  assert.ok((when("hive", "started-with-agent") ?? 0) >= (when("agent", "ready") ?? Infinity));
  assert.equal(saw("hive", "started-without-agent"), false);

  supervisor.stop("test");
  assert.equal(await done, 0);
  assert.ok(saw("hive", "terminated") && saw("agent", "terminated"));
  assert.ok((when("hive", "terminated") ?? Infinity) <= (when("agent", "terminated") ?? 0));
  // What each said is passed on with who said it.
  assert.ok(lines.some((line) => line.startsWith("[supervisor] stopping: test")));
});

test("the agent is told the password and the server how to reach it", async () => {
  const { supervisor } = await setup();
  const done = supervisor.run();
  await settle(() => saw("hive", "started-with-agent"));
  supervisor.stop("test");
  await done;
  const hive = JSON.parse(readFileSync(join(dir, "hive-env.json"), "utf8"));
  assert.equal(hive.OPENCODE_SERVER_PASSWORD, secrets.opencodePassword);
});

test("an agent that never answers ends the workspace in failure, and the server never starts", async () => {
  const { supervisor, lines } = await setup({ agent: { STUB_DELAY_MS: "60000" }, timeout: 300 });
  assert.equal(await supervisor.run(), 1);
  assert.equal(saw("hive", "started-with-agent") || saw("hive", "started-without-agent"), false);
  assert.ok(saw("agent", "terminated"));
  assert.ok(lines.some((line) => /did not answer/.test(line)));
});

test("an agent that stops before it is ready ends the workspace without waiting out the clock", async () => {
  const { supervisor } = await setup({ agent: { STUB_EXIT: "2" }, timeout: 30_000 });
  const started = Date.now();
  assert.equal(await supervisor.run(), 1);
  assert.ok(Date.now() - started < 5000);
  assert.equal(saw("hive", "started-with-agent"), false);
});

test("if the agent stops while running, the server is stopped and the workspace ends in failure", async () => {
  const { supervisor, lines } = await setup({ agent: { STUB_CRASH_AFTER_MS: "300" } });
  assert.equal(await supervisor.run(), 1);
  assert.ok(saw("hive", "terminated"));
  assert.ok(lines.some((line) => /opencode stopped on its own/.test(line)));
});

test("if the server stops while running, the agent is stopped and the workspace ends in failure", async () => {
  const { supervisor, lines } = await setup({ server: { STUB_CRASH_AFTER_MS: "300" } });
  assert.equal(await supervisor.run(), 1);
  assert.ok(saw("agent", "terminated"));
  assert.ok(lines.some((line) => /hive stopped on its own/.test(line)));
});

test("a process that ignores the request to stop is killed after its time is up", async () => {
  const { supervisor, lines } = await setup({ server: { STUB_IGNORE_TERM: "1" }, grace: 300 });
  const done = supervisor.run();
  await settle(() => saw("hive", "started-with-agent"));
  const asked = Date.now();
  supervisor.stop("test");
  assert.equal(await done, 0);
  assert.ok(Date.now() - asked >= 250);
  assert.ok(lines.some((line) => /did not stop in time/.test(line)));
  assert.ok(saw("agent", "terminated"));
});

test("asking to stop while the agent is still starting stops it cleanly", async () => {
  const { supervisor } = await setup({ agent: { STUB_DELAY_MS: "60000" }, timeout: 60_000 });
  const done = supervisor.run();
  await settle(() => saw("agent", "started"));
  supervisor.stop("test");
  assert.equal(await done, 0);
  assert.equal(saw("hive", "started-with-agent"), false);
  assert.ok(existsSync(markers));
});
