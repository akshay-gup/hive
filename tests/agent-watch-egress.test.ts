import assert from "node:assert/strict";
import test from "node:test";
import { Egress, WITHHELD } from "../apps/server/src/agent-watch/egress.ts";

/**
 * What the agent does reaches a person as events through the worker, which can hold a result back for a
 * moment or say it is withheld. Time is a number the test moves, and the timer is one it fires.
 */
function rig(hold = 300) {
  let clock = 1000;
  let fire: (() => void) | null = null;
  const out: Record<string, unknown>[] = [];
  const egress = new Egress((event) => out.push(event), {
    holdMs: () => hold,
    now: () => clock,
    later: (_ms, work) => {
      fire = work;
      return {
        cancel: () => {
          fire = null;
        },
      };
    },
  });
  return {
    egress,
    out,
    advance(ms: number) {
      clock += ms;
      const work = fire;
      fire = null;
      work?.();
    },
    types: () => out.map((e) => `${e.type}${e.content ? `:${e.content}` : ""}`),
  };
}
const start = (id: string, name: string) => ({
  type: "TOOL_CALL_START",
  toolCallId: id,
  toolCallName: name,
});
const result = (id: string, content: string) => ({
  type: "TOOL_CALL_RESULT",
  toolCallId: id,
  content,
});

test("with nothing to hold, events go straight through", () => {
  const r = rig(0);
  r.egress.push(start("a", "bash"));
  r.egress.push(result("a", "17"));
  assert.deepEqual(r.types(), ["TOOL_CALL_START", "TOOL_CALL_RESULT:17"]);
});

test("a shell or file result waits a moment, and what comes after it waits behind it", () => {
  const r = rig();
  r.egress.push(start("a", "bash"));
  r.egress.push(result("a", "17"));
  r.egress.push({ type: "TEXT_MESSAGE_CONTENT", delta: "done" });
  assert.deepEqual(r.types(), ["TOOL_CALL_START"]);
  r.advance(299);
  assert.deepEqual(r.types(), ["TOOL_CALL_START"]);
  r.advance(1);
  assert.deepEqual(r.types(), ["TOOL_CALL_START", "TOOL_CALL_RESULT:17", "TEXT_MESSAGE_CONTENT"]);
});

test("a result the run's own Hive tools return is not held", () => {
  const r = rig();
  r.egress.push(start("a", "create_issue"));
  r.egress.push(result("a", "{}"));
  assert.deepEqual(r.types(), ["TOOL_CALL_START", "TOOL_CALL_RESULT:{}"]);
});

test("a call said to be withheld shows no result, whether it was said before or while it waited", () => {
  const before = rig();
  before.egress.withhold("a");
  before.egress.push(start("a", "bash"));
  before.egress.push(result("a", "secret"));
  before.advance(300);
  assert.deepEqual(before.types(), ["TOOL_CALL_START", `TOOL_CALL_RESULT:${WITHHELD}`]);

  const during = rig();
  during.egress.push(start("a", "read"));
  during.egress.push(result("a", "secret"));
  during.advance(100);
  during.egress.withhold("a");
  during.advance(200);
  assert.deepEqual(during.types(), ["TOOL_CALL_START", `TOOL_CALL_RESULT:${WITHHELD}`]);
  assert.ok(!JSON.stringify(during.out).includes("secret"));
});

test("shutting the run withholds what waits, drops what follows, and lets the end through", () => {
  const r = rig();
  r.egress.push(start("a", "bash"));
  r.egress.push(result("a", "secret"));
  r.egress.push({ type: "TEXT_MESSAGE_CONTENT", delta: "the answer is secret" });
  r.egress.shutDown();
  r.egress.push({ type: "TEXT_MESSAGE_CONTENT", delta: "more" });
  r.egress.push(start("b", "bash"));
  r.egress.push(result("b", "more secret"));
  r.egress.push({ type: "RUN_ERROR", message: "Stopped" });
  assert.deepEqual(r.types(), [
    "TOOL_CALL_START",
    `TOOL_CALL_RESULT:${WITHHELD}`,
    `TOOL_CALL_RESULT:${WITHHELD}`,
    "RUN_ERROR",
  ]);
  assert.ok(!JSON.stringify(r.out).includes('secret"'));
});

test("when the run is over everything held goes out as it is, in order", () => {
  const r = rig();
  r.egress.push(start("a", "bash"));
  r.egress.push(result("a", "17"));
  r.egress.push({ type: "RUN_FINISHED" });
  r.egress.flushNow();
  assert.deepEqual(r.types(), ["TOOL_CALL_START", "TOOL_CALL_RESULT:17", "RUN_FINISHED"]);
});

test("a result that is held no longer than asked for goes out when its time comes, not before", () => {
  const r = rig();
  r.egress.push(start("a", "bash"));
  r.egress.push(result("a", "1"));
  r.advance(150);
  r.egress.push(start("b", "bash"));
  r.egress.push(result("b", "2"));
  r.advance(150);
  assert.deepEqual(r.types(), ["TOOL_CALL_START", "TOOL_CALL_RESULT:1", "TOOL_CALL_START"]);
  r.advance(150);
  assert.deepEqual(r.types().at(-1), "TOOL_CALL_RESULT:2");
});
