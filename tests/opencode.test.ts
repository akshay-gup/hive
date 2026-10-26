import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { MemoryThreadStore } from "../apps/server/src/engine/threads.ts";
import {
  assertCompatibleServerVersion,
  buildSessionRuleset,
  connectionFromConfig,
  defaultSessionRuleset,
  ensureThreadSession,
  type OpencodeClientPool,
  opencodeAuthHeaders,
  type PermissionRuleset,
  parsePermissionRules,
  rotateThreadSession,
  type SessionContext,
  sessionDirectory,
  taskSessionRuleset,
} from "../apps/server/src/opencode/index.ts";
import type { ChannelThread } from "../packages/domain/src/agent.ts";

let directory = "";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-opencode-"));
  config.dataDir = directory;
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: directory,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
};

test("auth headers are empty without a password", () => {
  assert.deepEqual(opencodeAuthHeaders({ url: "http://127.0.0.1:4096" }), {});
});

test("auth headers use Basic with the configured password", () => {
  const headers = opencodeAuthHeaders({ url: "http://127.0.0.1:4096", password: "s3cret" });
  assert.equal(headers.Authorization, `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
});

test("auth headers honor OPENCODE_SERVER_USERNAME", () => {
  const prev = process.env.OPENCODE_SERVER_USERNAME;
  process.env.OPENCODE_SERVER_USERNAME = "akshay";
  try {
    const headers = opencodeAuthHeaders({ url: "http://127.0.0.1:4096", password: "s3cret" });
    assert.equal(headers.Authorization, `Basic ${Buffer.from("akshay:s3cret").toString("base64")}`);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = prev;
  }
});

test("version assert accepts 1.x and rejects other majors", () => {
  assertCompatibleServerVersion("1.18.33");
  assertCompatibleServerVersion("1.0.0");
  assert.throws(
    () => assertCompatibleServerVersion("2.0.0"),
    /Incompatible OpenCode server version/,
  );
  assert.throws(() => assertCompatibleServerVersion(""), /Incompatible OpenCode server version/);
});

test("connectionFromConfig applies the default URL and trims slashes", () => {
  assert.equal(connectionFromConfig({}).url, "http://127.0.0.1:4096");
  assert.equal(
    connectionFromConfig({ opencodeServerUrl: "http://vm:4096///" }).url,
    "http://vm:4096",
  );
  assert.equal(connectionFromConfig({ opencodeServerPassword: "  " }).password, undefined);
});

test("parsePermissionRules accepts tool:action and tool:pattern:action", () => {
  assert.deepEqual(parsePermissionRules(["edit:allow", "bash:rm -rf:deny"]), [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm -rf", action: "deny" },
  ]);
});

test("parsePermissionRules skips invalid entries and non-arrays", () => {
  assert.deepEqual(parsePermissionRules(["edit", "edit:maybe", ":allow", 42, null]), []);
  assert.deepEqual(parsePermissionRules("edit:allow"), []);
  assert.deepEqual(parsePermissionRules(undefined), []);
});

test("default ruleset is ask-everything with native denies preserved", () => {
  const rules = defaultSessionRuleset();
  assert.deepEqual(rules[0], { permission: "*", pattern: "*", action: "ask" });
  const denies = rules.filter((r) => r.action === "deny").map((r) => r.permission);
  // `question` is left on: a chat has a person to answer it (see permissions.ts).
  assert.deepEqual(denies, ["plan_enter", "plan_exit"]);
});

test("user rules are appended last so they win via findLast", () => {
  const rules = buildSessionRuleset([{ permission: "read", pattern: "*", action: "allow" }]);
  assert.deepEqual(rules.at(-1), { permission: "read", pattern: "*", action: "allow" });
  assert.equal(rules.length, defaultSessionRuleset().length + 1);
});

test("session directory is the channel workspace dir", () => {
  assert.equal(
    sessionDirectory(config, "u1", "proj-x"),
    join(directory, "owners", "shared", "channels", "proj-x"),
  );
  assert.equal(
    sessionDirectory(config, "u1", "orchestrator"),
    join(directory, "owners", "u1", "channels", "orchestrator"),
  );
});

// --- Session binding tests with a stubbed SDK client ---

interface FakeSessionCalls {
  creates: unknown[];
  gets: string[];
  sessions: Map<string, { id: string; permission?: unknown[] }>;
  /** What the server was told to add to a session's rules. */
  updates?: { sessionID: string; permission: unknown[] }[];
}

function stubContext(
  calls: FakeSessionCalls,
  userRules?: SessionContext["userRules"],
  permissionMode?: SessionContext["permissionMode"],
  protect?: SessionContext["protect"],
): SessionContext {
  const client = {
    session: {
      create: async (params: unknown) => {
        calls.creates.push(params);
        const id = `ses_test_${calls.creates.length}`;
        calls.sessions.set(id, { id });
        return { data: { id }, error: undefined };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.gets.push(sessionID);
        const found = calls.sessions.get(sessionID);
        return found
          ? { data: found, error: undefined }
          : { data: undefined, error: { message: "not found" } };
      },
      // The server joins what it is told to the rules a session has.
      ...(calls.updates
        ? {
            update: async (params: { sessionID: string; permission: unknown[] }) => {
              calls.updates?.push(params);
              const found = calls.sessions.get(params.sessionID);
              if (found) found.permission = [...(found.permission ?? []), ...params.permission];
              return { data: found, error: undefined };
            },
          }
        : {}),
    },
  };
  const pool = { forDirectory: () => client } as unknown as OpencodeClientPool;
  return {
    threads: new MemoryThreadStore(),
    clients: pool,
    config,
    userRules,
    permissionMode,
    protect,
  };
}

const binding: ChannelThread = {
  threadId: "thread-1",
  channelId: "proj-x",
  name: "General",
  createdAt: new Date().toISOString(),
};

test("rotateThreadSession persists opencodeSessionId before returning", async () => {
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map() };
  const ctx = stubContext(calls);
  await ctx.threads.write("owner", binding);
  const ref = await rotateThreadSession(ctx, "owner", "thread-1");
  assert.match(ref.sessionId, /^ses_test_/);
  assert.equal(ref.directory, join(directory, "owners", "shared", "channels", "proj-x"));
  const stored = (await ctx.threads.scan("owner")).find((b) => b.threadId === "thread-1");
  assert.equal(stored?.opencodeSessionId, ref.sessionId);
  // The session was created with the default-ask ruleset.
  const params = calls.creates[0] as { permission: unknown[] };
  assert.deepEqual(params.permission[0], defaultSessionRuleset()[0]);
});

test("ensureThreadSession reuses a live bound session without creating", async () => {
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map() };
  const ctx = stubContext(calls);
  calls.sessions.set("ses_live", { id: "ses_live" });
  await ctx.threads.write("owner", { ...binding, opencodeSessionId: "ses_live" });
  const ref = await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(ref.sessionId, "ses_live");
  assert.deepEqual(calls.gets, ["ses_live"]);
  assert.equal(calls.creates.length, 0);
});

test("ensureThreadSession rebinds when the server lost the session", async () => {
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map() };
  const ctx = stubContext(calls);
  await ctx.threads.write("owner", { ...binding, opencodeSessionId: "ses_gone" });
  const ref = await ensureThreadSession(ctx, "owner", "thread-1");
  assert.notEqual(ref.sessionId, "ses_gone");
  const stored = (await ctx.threads.scan("owner")).find((b) => b.threadId === "thread-1");
  assert.equal(stored?.opencodeSessionId, ref.sessionId);
});

test("ensureThreadSession passes user rules into the session ruleset", async () => {
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map() };
  const ctx = stubContext(calls, () => [{ permission: "read", pattern: "*", action: "allow" }]);
  await ctx.threads.write("owner", binding);
  await rotateThreadSession(ctx, "owner", "thread-1");
  const params = calls.creates[0] as { permission: unknown[] };
  assert.deepEqual(params.permission.at(-1), { permission: "read", pattern: "*", action: "allow" });
});

test("session helpers throw 404 for unbound threads", async () => {
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map() };
  const ctx = stubContext(calls);
  await assert.rejects(() => ensureThreadSession(ctx, "owner", "nope"), /not bound to a channel/);
  await assert.rejects(() => rotateThreadSession(ctx, "owner", "nope"), /not bound to a channel/);
});

test("a thread's session is told its rules again when its mode or rules changed since it began", async () => {
  const updates: { sessionID: string; permission: unknown[] }[] = [];
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map(), updates };
  let mode: "ask" | "auto" = "ask";
  let rules: PermissionRuleset = [];
  const ctx = stubContext(
    calls,
    () => rules,
    () => mode,
  );
  await ctx.threads.write("owner", binding);
  const first = await rotateThreadSession(ctx, "owner", "thread-1");
  // The session was made with the rules the thread had, and the rules it ends with are those.
  const session = calls.sessions.get(first.sessionId);
  assert.ok(session);
  session.permission = buildSessionRuleset([], "ask");
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 0, "nothing changed, so nothing is said");

  // The channel is switched to run without asking: the next run is under that.
  mode = "auto";
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].permission, buildSessionRuleset([], "auto"));
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 1, "told once");

  // And back to asking, with a rule: the last rules win, so it is under those again.
  mode = "ask";
  rules = [{ permission: "read", pattern: "*", action: "allow" }];
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 2);
  const wanted = buildSessionRuleset(rules, "ask");
  assert.deepEqual(updates[1].permission, wanted);
  assert.deepEqual((session.permission ?? []).slice(-wanted.length), wanted);
});

test("a server that will not take a thread's new rules does not stop the thread running", async () => {
  // The stub has no way to update a session.
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map() };
  const ctx = stubContext(calls, undefined, () => "auto");
  calls.sessions.set("ses_live", { id: "ses_live", permission: buildSessionRuleset([], "ask") });
  await ctx.threads.write("owner", { ...binding, opencodeSessionId: "ses_live" });
  const ref = await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(ref.sessionId, "ses_live");
});

test("what the agent is to be refused is the last of a session's rules, and reaches a session that already has its own", async () => {
  const deny: PermissionRuleset = [
    { permission: "external_directory", pattern: "/data/hive/*", action: "deny" },
  ];
  const updates: { sessionID: string; permission: unknown[] }[] = [];
  const calls: FakeSessionCalls = { creates: [], gets: [], sessions: new Map(), updates };
  let protect: PermissionRuleset = [];
  const ctx = stubContext(
    calls,
    undefined,
    () => "auto",
    () => protect,
  );
  await ctx.threads.write("owner", binding);
  const first = await rotateThreadSession(ctx, "owner", "thread-1");
  const session = calls.sessions.get(first.sessionId);
  assert.ok(session);
  session.permission = buildSessionRuleset([], "auto", protect);
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 0, "nothing to refuse, nothing said");

  // The owner turns refusing on: the next run is under it, in auto mode too, and it is the last rule.
  protect = deny;
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.permission.at(-1), deny[0]);
  await ensureThreadSession(ctx, "owner", "thread-1");
  assert.equal(updates.length, 1, "told once");

  // A session made after is made with it.
  await rotateThreadSession(ctx, "owner", "thread-1");
  const made = calls.creates.at(-1) as { permission: unknown[] };
  assert.deepEqual(made.permission.at(-1), deny[0]);
});

test("a task's session can be made with what the agent is to be refused as well", () => {
  const deny: PermissionRuleset = [
    { permission: "external_directory", pattern: "/data/hive/*", action: "deny" },
  ];
  assert.deepEqual(taskSessionRuleset(deny).at(-1), deny[0]);
  assert.deepEqual(taskSessionRuleset(), taskSessionRuleset([]));
});
