import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  defaultSessionRuleset,
  invalidRuleLines,
  PermissionRulesStore,
  PermissionTracker,
  taskSessionRuleset,
} from "../apps/server/src/opencode/index.ts";

let directory = "";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-perms-"));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Minimal bus: enqueue runs the action immediately, in order. */
const fakeBus = () => ({
  enqueue: <T>(_scope: string, action: () => Promise<T>): Promise<T> => action(),
});

interface ReplyCall {
  requestID: string;
  directory?: string;
  reply?: string;
}

function fakePool(calls: ReplyCall[], failOn?: string) {
  return {
    forDirectory: (dir: string) => ({
      permission: {
        reply: async (args: ReplyCall) => {
          calls.push({ ...args, directory: dir });
          if (failOn === args.requestID) return { error: { message: "gone" } };
          return {};
        },
      },
    }),
  };
}

const scope = {
  scope: "thread-1",
  threadId: "thread-1",
  channelId: "chan-1",
  directory: "/d/chan-1",
};

test("invalidRuleLines accepts valid rules and names bad ones", () => {
  assert.deepEqual(invalidRuleLines(["bash:git status:allow", "edit:deny", "", "  "]), []);
  assert.deepEqual(invalidRuleLines(["bash:git status:maybe"]), ["bash:git status:maybe"]);
  assert.deepEqual(invalidRuleLines(["nocolons"]), ["nocolons"]);
});

test("taskSessionRuleset is allow-all, except for the tools that stop to ask the person", () => {
  assert.deepEqual(taskSessionRuleset(), [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "plan_enter", pattern: "*", action: "deny" },
    { permission: "plan_exit", pattern: "*", action: "deny" },
  ]);
  // A chat thread denies the two plan tools the same way, and keeps `question`: it has a person to answer.
  assert.deepEqual(taskSessionRuleset().slice(2), defaultSessionRuleset().slice(1));
  assert.equal(
    defaultSessionRuleset().some((rule) => rule.permission === "question"),
    false,
  );
});

test("tracker records permission asks, deduped by request id", () => {
  const tracker = new PermissionTracker();
  const first = tracker.record(scope, {
    id: "req-1",
    sessionID: "ses-1",
    permission: "bash",
    patterns: ["rm *"],
  });
  const second = tracker.record(scope, {
    id: "req-1",
    sessionID: "ses-1",
    permission: "bash",
    patterns: ["rm *"],
  });
  assert.equal(first, second);
  assert.equal(tracker.pendingForThread("thread-1").length, 1);
  assert.equal(tracker.get("req-1")?.permission, "bash");
});

test("tracker scopes pending requests by thread", () => {
  const tracker = new PermissionTracker();
  tracker.record(scope, { id: "a", sessionID: "s", permission: "bash", patterns: [] });
  tracker.record(
    { scope: "thread-2", threadId: "thread-2", channelId: "chan-1", directory: "/d/chan-1" },
    { id: "b", sessionID: "s", permission: "edit", patterns: [] },
  );
  assert.equal(tracker.pendingForThread("thread-1").length, 1);
  assert.equal(tracker.pendingForThread("thread-2").length, 1);
  assert.ok(tracker.remove("a"));
  assert.equal(tracker.pendingForThread("thread-1").length, 0);
});

test("tracker.reply answers via the SDK and clears the request", async () => {
  const tracker = new PermissionTracker();
  const calls: ReplyCall[] = [];
  const deps = { bus: fakeBus(), pool: fakePool(calls) } as never;
  tracker.record(scope, { id: "req-9", sessionID: "ses-9", permission: "bash", patterns: ["*"] });
  const answered = await tracker.reply(deps, "req-9", "once");
  assert.equal(answered.requestId, "req-9");
  assert.deepEqual(calls, [{ requestID: "req-9", directory: "/d/chan-1", reply: "once" }]);
  assert.equal(tracker.get("req-9"), undefined);
});

test("a question the agent asks is kept until it is answered, then handed back to the agent", async () => {
  const tracker = new PermissionTracker();
  const calls: Array<Record<string, unknown>> = [];
  const pool = {
    forDirectory: () => ({
      question: {
        reply: async (request: Record<string, unknown>) => {
          calls.push({ ...request, how: "reply" });
          return {};
        },
        reject: async (request: Record<string, unknown>) => {
          calls.push({ ...request, how: "reject" });
          return {};
        },
      },
    }),
  };
  const deps = { bus: fakeBus(), pool } as never;
  const asked = {
    id: "que-1",
    sessionID: "ses-1",
    questions: [{ question: "Who is it for?", header: "Audience", options: [] }],
  };
  tracker.recordQuestion(scope, asked);
  assert.equal(tracker.recordQuestion(scope, asked), tracker.getQuestion("que-1"));
  assert.equal(tracker.questionsForThread("thread-1").length, 1);
  assert.equal(tracker.questionsForThread("other").length, 0);

  await tracker.answerQuestion(deps, "que-1", [["Ada"]]);
  assert.deepEqual(calls, [
    { requestID: "que-1", directory: "/d/chan-1", answers: [["Ada"]], how: "reply" },
  ]);
  assert.equal(tracker.getQuestion("que-1"), undefined);
  await assert.rejects(() => tracker.answerQuestion(deps, "que-1", [["x"]]), /not pending/);

  // Skipping it turns it down, and a run that is cancelled turns down whatever it was waiting on.
  tracker.recordQuestion(scope, { ...asked, id: "que-2" });
  await tracker.answerQuestion(deps, "que-2", null);
  tracker.recordQuestion(scope, { ...asked, id: "que-3" });
  assert.equal(await tracker.rejectAllForScope(deps, "thread-1"), 1);
  assert.deepEqual(
    calls.slice(1).map((call) => [call.requestID, call.how]),
    [
      ["que-2", "reject"],
      ["que-3", "reject"],
    ],
  );
  assert.equal(tracker.questionsForThread("thread-1").length, 0);
});

test("tracker.reply throws for unknown request ids", async () => {
  const tracker = new PermissionTracker();
  const deps = { bus: fakeBus(), pool: fakePool([]) } as never;
  await assert.rejects(() => tracker.reply(deps, "nope", "reject"), /not pending/);
});

test("tracker.reply surfaces SDK errors without clearing", async () => {
  const tracker = new PermissionTracker();
  const calls: ReplyCall[] = [];
  const deps = { bus: fakeBus(), pool: fakePool(calls, "req-x") } as never;
  tracker.record(scope, { id: "req-x", sessionID: "s", permission: "bash", patterns: [] });
  await assert.rejects(() => tracker.reply(deps, "req-x", "reject"), /permission.reply failed/);
  assert.ok(tracker.get("req-x"), "failed reply stays pending");
});

test("rejectAllForScope rejects every pending request best-effort", async () => {
  const tracker = new PermissionTracker();
  const calls: ReplyCall[] = [];
  const deps = { bus: fakeBus(), pool: fakePool(calls) } as never;
  tracker.record(scope, { id: "r1", sessionID: "s", permission: "bash", patterns: [] });
  tracker.record(scope, { id: "r2", sessionID: "s", permission: "edit", patterns: [] });
  const rejected = await tracker.rejectAllForScope(deps, "thread-1");
  assert.equal(rejected, 2);
  assert.deepEqual(
    calls.map((c) => c.reply),
    ["reject", "reject"],
  );
  assert.equal(tracker.pendingForThread("thread-1").length, 0);
  assert.equal(await tracker.rejectAllForScope(deps, "thread-1"), 0);
});

test("rules store round-trips channel rules on disk", async () => {
  const store = new PermissionRulesStore(directory);
  assert.deepEqual(await store.channelRules("u1", "chan-a"), []);
  const saved = await store.setChannelRules("u1", "chan-a", ["bash:git *:allow", "edit:deny"]);
  assert.deepEqual(saved, ["bash:git *:allow", "edit:deny"]);
  assert.deepEqual(await store.channelRules("u1", "chan-a"), ["bash:git *:allow", "edit:deny"]);
  // A second instance sees the same file.
  assert.deepEqual(await new PermissionRulesStore(directory).channelRules("u1", "chan-a"), [
    "bash:git *:allow",
    "edit:deny",
  ]);
});

test("rules store rejects invalid rule lines", async () => {
  const store = new PermissionRulesStore(directory);
  await assert.rejects(
    () => store.setChannelRules("u1", "chan-a", ["bash:ls:allow", "bogus"]),
    /Invalid permission rules: bogus/,
  );
  await assert.rejects(
    () => store.setThreadRules("u1", "chan-a", "thread-1", ["also-bogus"]),
    /Invalid permission rules: also-bogus/,
  );
});

test("thread overrides merge after channel rules so they win", async () => {
  const store = new PermissionRulesStore(directory);
  await store.setChannelRules("u1", "chan-b", ["bash:*:ask"]);
  await store.setThreadRules("u1", "chan-b", "thread-9", ["bash:git status:allow"]);
  assert.deepEqual(await store.threadRules("u1", "chan-b", "thread-9"), ["bash:git status:allow"]);
  assert.deepEqual(await store.threadRules("u1", "chan-b", "other-thread"), []);
  const ruleset = await store.effectiveRules("u1", {
    threadId: "thread-9",
    channelId: "chan-b",
    name: "t",
    createdAt: "",
  });
  assert.deepEqual(ruleset, [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "git status", action: "allow" },
  ]);
});

test("rules store sanitizes hostile channel ids to the workspace dir", async () => {
  const store = new PermissionRulesStore(directory);
  await store.setChannelRules("u1", "../../evil", ["edit:deny"]);
  assert.deepEqual(await store.channelRules("u1", "../../evil"), ["edit:deny"]);
  // Lands under channels/, not outside the data dir.
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(join(directory, "owners", "shared", "channels"));
  assert.ok(!names.includes(".."));
});

test("buildSessionRuleset uses ask base by default and allow base in auto mode", async () => {
  const { buildSessionRuleset } = await import("../apps/server/src/opencode/index.ts");
  const ask = buildSessionRuleset([]);
  assert.equal(ask[0].permission, "*");
  assert.equal(ask[0].action, "ask");
  const auto = buildSessionRuleset([], "auto");
  assert.equal(auto[0].permission, "*");
  assert.equal(auto[0].action, "allow");
  // Native denies survive in both modes.
  for (const ruleset of [ask, auto]) {
    const denied = ruleset.filter((r) => r.action === "deny").map((r) => r.permission);
    assert.ok(denied.includes("plan_enter") && denied.includes("plan_exit"));
    assert.ok(!denied.includes("question"));
  }
  // Explicit user denies still win over the auto-allow base (last-wins).
  const { parsePermissionRules } = await import("../apps/server/src/opencode/index.ts");
  const mixed = buildSessionRuleset(parsePermissionRules(["edit:deny"]), "auto");
  assert.equal(mixed.at(-1)?.permission, "edit");
  assert.equal(mixed.at(-1)?.action, "deny");
});

test("permission mode round-trips per channel with thread override and inherit", async () => {
  const store = new PermissionRulesStore(directory);
  const binding = (threadId: string) => ({ threadId, channelId: "chan-mode" }) as never;
  assert.equal(await store.channelMode("u1", "chan-mode"), "ask");
  assert.equal(await store.effectiveMode("u1", binding("t1")), "ask");
  await store.setChannelMode("u1", "chan-mode", "auto");
  assert.equal(await store.channelMode("u1", "chan-mode"), "auto");
  assert.equal(await store.effectiveMode("u1", binding("t1")), "auto");
  // Thread override wins; clearing it inherits again.
  assert.equal(await store.threadMode("u1", "chan-mode", "t1"), null);
  await store.setThreadMode("u1", "chan-mode", "t1", "ask");
  assert.equal(await store.effectiveMode("u1", binding("t1")), "ask");
  await store.setThreadMode("u1", "chan-mode", "t1", null);
  assert.equal(await store.threadMode("u1", "chan-mode", "t1"), null);
  assert.equal(await store.effectiveMode("u1", binding("t1")), "auto");
  // Setting thread rules preserves the thread mode.
  await store.setThreadMode("u1", "chan-mode", "t2", "ask");
  await store.setThreadRules("u1", "chan-mode", "t2", ["bash:deny"]);
  assert.equal(await store.effectiveMode("u1", binding("t2")), "ask");
  assert.deepEqual(await store.threadRules("u1", "chan-mode", "t2"), ["bash:deny"]);
});
