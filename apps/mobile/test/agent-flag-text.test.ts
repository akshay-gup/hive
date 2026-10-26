import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FlagRow,
  flagCount,
  flagDetail,
  flagOrder,
  flagWhat,
  flagWhere,
} from "../src/agent-flag-text.ts";

const flag = (patch: Partial<FlagRow> = {}): FlagRow => ({
  id: "f1",
  at: "2026-10-26T10:00:00.000Z",
  source: "command",
  scope: "channel",
  tool: "bash",
  target: "/data/hive/postgres/PG_VERSION",
  command: "cat /data/hive/postgres/PG_VERSION",
  rule: "database",
  severity: "high",
  action: "marked",
  mode: "audit",
  askerName: "Mia",
  channelName: "hush",
  ...patch,
});

test("who asked and where is said in a few words, whatever is known", () => {
  assert.equal(flagWhere(flag()), "Mia's request in #hush");
  assert.equal(flagWhere(flag({ askerName: undefined })), "A request in #hush");
  assert.equal(flagWhere(flag({ channelName: undefined })), "Mia's request in a channel");
  assert.equal(flagWhere(flag({ scope: "own-chat" })), "A private chat with the agent");
  assert.equal(flagWhere(flag({ scope: "task" })), "A task the agent was working on");
});

test("a flag of the kernel watch, or of something outside any run, is not said to be the agent's", () => {
  const machine = flag({
    scope: "machine",
    source: "kernel",
    askerName: undefined,
    channelName: undefined,
  });
  assert.equal(flagWhere(machine), "On the machine, outside any run");
  assert.equal(
    flagWhat(machine),
    "A program that is not the workspace server opened the workspace's database",
  );
  const down = flag({
    scope: "machine",
    source: "watch",
    rule: "watch",
    target: "the kernel watch went quiet",
  });
  assert.equal(flagWhat(down), "The kernel watch: the kernel watch went quiet");
});

test("what was done is said as it was: opened, or refused", () => {
  assert.equal(flagWhat(flag()), "The agent opened the workspace's database");
  assert.equal(
    flagWhat(flag({ action: "blocked", rule: "keys" })),
    "The agent was refused the workspace's keys and settings",
  );
  assert.equal(
    flagWhat(flag({ rule: "obfuscation" })),
    "The agent ran a command that hides what it opens",
  );
  assert.equal(flagWhat(flag({ rule: "unheard-of" })), "The agent opened something kept apart");
});

test("the command is shown, or the path when the file tool had no command", () => {
  assert.equal(flagDetail(flag()), "cat /data/hive/postgres/PG_VERSION");
  assert.equal(
    flagDetail(flag({ command: undefined, source: "file-tool" })),
    "/data/hive/postgres/PG_VERSION",
  );
});

test("those not looked at come first, the serious before the minor, the newer before the older", () => {
  const rows = [
    flag({ id: "seen", reviewedAt: "2026-10-26T11:00:00.000Z" }),
    flag({ id: "minor", severity: "low" }),
    flag({ id: "old", at: "2026-10-25T10:00:00.000Z" }),
    flag({ id: "new" }),
    flag({ id: "mid", severity: "medium" }),
  ];
  assert.deepEqual(
    rows.sort(flagOrder).map((row) => row.id),
    ["new", "old", "mid", "minor", "seen"],
  );
});

test("the count says there is nothing, or how many", () => {
  assert.equal(flagCount(0), "Nothing to look at.");
  assert.equal(flagCount(3), "3 to look at.");
});
