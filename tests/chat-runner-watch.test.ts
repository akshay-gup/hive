import assert from "node:assert/strict";
import { test } from "node:test";
import { WITHHELD } from "../apps/server/src/agent-watch/egress.ts";
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

test("with refusing on: the result of a call that reaches the machine's data is not shown to the channel", async (t) => {
  let dataDir = "";
  const f = await wired(t, (turn) => {
    nativeCall(turn, "c1", "bash", { command: `cat ${dataDir}/postgres/PG_VERSION` }, "secret-17");
    nativeCall(turn, "c2", "bash", { command: "echo fine" }, "fine");
    turn.say("done");
  });
  dataDir = f.dataDir;
  await f.core.agent.setWatchMode("enforce");
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive look");
  const reply = await f.finished(asked.id);
  const steps = stepsText(f.extra(reply).steps);
  assert.ok(!steps.includes("secret-17"), "the secret is not in the reply");
  assert.ok(steps.includes(WITHHELD), "it says the result was withheld");
  assert.ok(steps.includes("fine"), "what the agent did in its own way is shown");
  assert.equal(f.core.flags.list()[0]?.mode, "enforce");
});
