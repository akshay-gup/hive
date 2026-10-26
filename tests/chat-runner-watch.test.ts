import assert from "node:assert/strict";
import { test } from "node:test";
import { WATCH_STOP_TEXT } from "../packages/domain/src/agent-watch.ts";
import { wired } from "./helpers/chat-wired.ts";
import type { FakeTurn } from "./helpers/fake-opencode.ts";

/**
 * A run of the agent through the real room, runner and sessions, with OpenCode played by a stand-in that
 * does what the test says. What the watch does about the agent reaching the machine's own data is judged
 * by what the people in the channel are shown.
 */
const nativeCall = (
  turn: FakeTurn,
  callID: string,
  tool: string,
  input: object,
  output: string,
) => {
  const messageID = `msg_${callID}`;
  turn.emit({
    type: "message.updated",
    properties: { info: { id: messageID, role: "assistant", sessionID: "x" } },
  });
  const part = (state: Record<string, unknown>) =>
    turn.emit({
      type: "message.part.updated",
      properties: {
        part: { id: `prt_${callID}`, messageID, type: "tool", callID, tool, state },
      },
    });
  part({ status: "running", input });
  part({ status: "completed", input, output });
};
const stepsText = (steps: unknown) => JSON.stringify(steps);

test("only marked: what the agent reads of the machine's data is shown as it is, and flagged", async (t) => {
  let dataDir = "";
  const f = await wired(t, (turn) => {
    nativeCall(turn, "c1", "bash", { command: `cat ${dataDir}/postgres/PG_VERSION` }, "secret-17");
    turn.say("done");
  });
  dataDir = f.dataDir;
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive look");
  const reply = await f.finished(asked.id);
  assert.match(stepsText(f.extra(reply).steps), /secret-17/);
  const [flag] = f.core.flags.list();
  assert.equal(flag?.rule, "database");
  assert.equal(flag?.mode, "audit");
  assert.equal(flag?.channelId, room.id);
});

test("with refusing on: a call that reaches the machine's data stops the run, and nothing of it is shown", async (t) => {
  let dataDir = "";
  const f = await wired(t, (turn) => {
    nativeCall(turn, "c1", "bash", { command: `cat ${dataDir}/postgres/PG_VERSION` }, "secret-17");
    nativeCall(turn, "c2", "bash", { command: "echo fine" }, "later-fine");
    turn.say("the answer is secret-17");
  });
  dataDir = f.dataDir;
  await f.core.agent.setWatchMode("enforce");
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive look");
  const reply = await f.finished(asked.id);
  // The person is told why, in words, and the run shows as failed for that reason.
  assert.equal(f.extra(reply).status, "failed");
  assert.equal(f.extra(reply).reason, "watch");
  assert.equal(reply.body, WATCH_STOP_TEXT);
  // Nothing the agent read, or did after, is in what the channel is shown.
  const shown = stepsText(f.extra(reply).steps) + reply.body;
  assert.ok(!shown.includes("secret-17"));
  assert.ok(!shown.includes("later-fine"));
  // It is marked as stopped, and the agent's session is refused the data, stopped and forgotten.
  const [flag] = f.core.flags.list();
  assert.equal(flag?.action, "blocked");
  assert.equal(flag?.mode, "enforce");
  await f.until("the session to be forgotten", () => f.opencode.deleted.length === 1);
  assert.equal(f.opencode.aborted.length >= 1, true);
  const told = f.opencode.told.at(-1)?.permission as { permission: string; action: string }[];
  assert.ok(
    told.some((rule) => rule.permission === "external_directory" && rule.action === "deny"),
  );
});

test("with refusing on, a run that reaches nothing of the kind is left alone", async (t) => {
  const f = await wired(t, (turn) => {
    nativeCall(turn, "c1", "bash", { command: "echo fine" }, "fine");
    turn.say("done");
  });
  await f.core.agent.setWatchMode("enforce");
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive look");
  const reply = await f.finished(asked.id);
  assert.equal(f.extra(reply).status, "done");
  assert.match(stepsText(f.extra(reply).steps), /fine/);
  assert.equal(f.opencode.deleted.length, 0);
  assert.equal(f.core.flags.list().length, 0);
});
