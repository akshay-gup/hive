import assert from "node:assert/strict";
import test from "node:test";
import { AgentWatch } from "../apps/server/src/agent-watch/watch.ts";
import type { OpenCodeEvent } from "../apps/server/src/opencode/events.ts";
import type { WatchFinding } from "../packages/domain/src/agent-watch.ts";
import { runnerFrameSchema } from "../packages/domain/src/chat-agent.ts";

const dataDir = "/data/hive";
const own = `${dataDir}/owners/shared/channels/c1`;

function watching(options: { open?: () => boolean } = {}) {
  const sent: WatchFinding[] = [];
  const watch = new AgentWatch({
    dataDir,
    env: { HOME: "/home/hive" },
    send: (frame) => {
      if (options.open && !options.open()) return false;
      sent.push(frame.finding);
      return true;
    },
  });
  return { watch, sent };
}
const tool = (callID: string, name: string, input: object, status = "running"): OpenCodeEvent => ({
  id: callID,
  type: "message.part.updated",
  properties: {
    sessionID: "s1",
    part: {
      id: `p-${callID}`,
      messageID: "m1",
      type: "tool",
      callID,
      tool: name,
      state: { status, input },
    },
  },
});

test("a bash command that reaches the machine's data is sent on, with where it happened", () => {
  const { watch, sent } = watching();
  const handle = watch.forRun({ scope: "channel", runId: "run-1", directory: own });
  handle(tool("c1", "bash", { command: "cat /data/hive/postgres/PG_VERSION" }));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    source: "command",
    scope: "channel",
    runId: "run-1",
    tool: "bash",
    target: "/data/hive/postgres/PG_VERSION",
    command: "cat /data/hive/postgres/PG_VERSION",
    rule: "database",
    severity: "high",
    action: "marked",
    mode: "audit",
  });
  // What goes over the wire is a frame the service accepts.
  assert.ok(runnerFrameSchema.safeParse({ t: "agent.flag", finding: sent[0] }).success);
});

test("what the agent does in its own folder, with the Hive tools, or before it has said what, is left alone", () => {
  const { watch, sent } = watching();
  const handle = watch.forRun({ scope: "own-chat", directory: own });
  handle(tool("a", "bash", { command: "ls && cat notes.md" }));
  handle(tool("b", "bash", {}, "pending"));
  handle(tool("c", "hive_0123456789abcdef_create_issue", { title: "/data/hive/postgres" }));
  handle({ id: "x", type: "session.idle", properties: { sessionID: "s1" } });
  assert.deepEqual(sent, []);
});

test("the same thing is marked once in a run, even as the call is reported again", () => {
  const { watch, sent } = watching();
  const handle = watch.forRun({ scope: "task", directory: own });
  const command = "cat /data/hive/session-signing-key";
  handle(tool("a", "bash", { command }));
  handle(tool("a", "bash", { command }, "completed"));
  handle(tool("b", "bash", { command }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.scope, "task");
  assert.equal(sent[0]?.runId, undefined);
});

test("a run is marked for no more than a few dozen things", () => {
  const { watch, sent } = watching();
  const handle = watch.forRun({ scope: "channel", runId: "r", directory: own });
  for (let i = 0; i < 80; i++)
    handle(tool(`c${i}`, "read", { filePath: `/data/hive/files/doc-${i}.pdf` }));
  assert.equal(sent.length, 50);
});

test("what cannot be sent while the chat service is out of reach is sent when it is back", () => {
  let open = false;
  const { watch, sent } = watching({ open: () => open });
  const handle = watch.forRun({ scope: "own-chat", directory: own });
  handle(tool("a", "bash", { command: "cat /etc/hive/workspace.json" }));
  assert.equal(sent.length, 0);
  open = true;
  watch.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.rule, "keys");
});

test("the mode a finding is made in is the one the watch is set to", () => {
  const { watch, sent } = watching();
  watch.setMode("enforce");
  watch.forRun({ scope: "channel", directory: own })(
    tool("a", "read", { filePath: "/etc/hive/workspace.json" }),
  );
  assert.equal(sent[0]?.mode, "enforce");
  assert.equal(sent[0]?.source, "file-tool");
});

test("in the stricter mode what reaches the machine's data is turned down, and said to have been", () => {
  const { watch, sent } = watching();
  const run = watch.forRun({ scope: "channel", runId: "r", directory: own });
  const ask = (permission: string, patterns: string[]) => run.asked({ permission, patterns });
  // Marked and let through while it only marks.
  assert.equal(ask("read", ["/data/hive/postgres/PG_VERSION"]), false);
  assert.equal(sent[0]?.action, "marked");
  watch.setMode("enforce");
  assert.equal(ask("bash", ["cat /data/hive/session-signing-key"]), true);
  assert.equal(sent[1]?.action, "blocked");
  assert.equal(sent[1]?.mode, "enforce");
  assert.equal(sent[1]?.command, "cat /data/hive/session-signing-key");
  // What is only a mention of the folder, or in its own folder, is let through.
  assert.equal(ask("bash", ["find / -name x"]), false);
  assert.equal(ask("read", [`${own}/notes.md`]), false);
  assert.equal(ask("webfetch", ["https://example.com"]), false);
});
