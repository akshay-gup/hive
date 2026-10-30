import assert from "node:assert/strict";
import { test } from "node:test";
import { opencodeRunLauncher } from "../apps/server/src/opencode/agui.ts";
import { RunRecord } from "../apps/server/src/opencode/run-record.ts";

test("what a run says becomes the messages a chat keeps, in order", () => {
  const record = new RunRecord();
  const events = [
    { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Looking " },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "it up" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "browse_web",
      parentMessageId: "m1",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"url":"https://a.test"}' },
    { type: "TOOL_CALL_RESULT", messageId: "toolresult-c1", toolCallId: "c1", content: "{}" },
    { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "Done" },
    { type: "TEXT_MESSAGE_START", messageId: "empty", role: "assistant" },
  ];
  for (const event of events) record.handle(event);
  const messages = record.messages();
  assert.deepEqual(
    messages.map((m) => m.id),
    ["m1", "toolresult-c1", "m2"],
    "an empty reply is left out",
  );
  assert.equal(messages[0]?.content, "Looking it up");
  assert.deepEqual(messages[0]?.toolCalls, [
    {
      id: "c1",
      type: "function",
      function: { name: "browse_web", arguments: '{"url":"https://a.test"}' },
    },
  ]);
  assert.equal(messages[1]?.toolCallId, "c1");
});

test("a reply that is only a tool call is kept, without empty text", () => {
  const record = new RunRecord();
  record.handle({
    type: "TOOL_CALL_START",
    toolCallId: "c1",
    toolCallName: "x",
    parentMessageId: "m1",
  });
  const [message] = record.messages();
  assert.equal("content" in (message ?? {}), false);
});

test("stopping a thread with no run going is harmless", () => {
  const launcher = opencodeRunLauncher({ config: {} } as never);
  assert.doesNotThrow(() => launcher.stop("t1"));
});

test("a run that carries on shows what the earlier try said, and a tool that never came back says it was cut off", () => {
  const record = new RunRecord();
  record.seed([
    {
      id: "m1",
      role: "assistant",
      content: "Looking it up.",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "browse_web", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "browse_web", arguments: "{}" } },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "c1", content: "{}" },
  ]);
  // What it says next goes on from there.
  record.handle({ type: "TEXT_MESSAGE_START", messageId: "m2" });
  record.handle({ type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "Found it." });
  const messages = record.messages();
  assert.deepEqual(
    messages.map((m) => [m.role, m.id]),
    [
      ["assistant", "m1"],
      ["tool", "t1"],
      ["tool", "interrupted-c2"],
      ["assistant", "m2"],
    ],
  );
  assert.equal(messages[2]?.content, "error: Interrupted by a restart");
  assert.equal(messages[3]?.content, "Found it.");
});
