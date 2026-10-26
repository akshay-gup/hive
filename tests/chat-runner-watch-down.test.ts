import assert from "node:assert/strict";
import { test } from "node:test";
import { wired } from "./helpers/chat-wired.ts";

/**
 * A new request, through the real room and runner, when the machine's kernel watch is down (a file of its
 * own: each of these tests builds a whole workspace, which is a lot for one process on a small machine).
 */
test("with refusing on and the machine's watch down, a new request is not run, and says why; back up, it is", async (t) => {
  const f = await wired(t, (turn) => turn.say("hello"));
  await f.core.agent.setWatchMode("enforce");
  f.server.watch.kernelDown(true, "the kernel watch went quiet");
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive hi");
  const refused = await f.finished(asked.id);
  assert.equal(f.extra(refused).status, "failed");
  assert.match(refused.body, /watch on this machine is not working/);
  assert.equal(f.opencode.prompts.length, 0, "the agent was not started");
  f.server.watch.kernelDown(false, "");
  const again = await f.post("max", room.id, "@hive hi again");
  const done = await f.finished(again.id);
  assert.equal(f.extra(done).status, "done");
});
