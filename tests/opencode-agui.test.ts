/**
 * Phase 2 tests: AG-UI shim translation, event bus fan-out, /run route guards.
 * Run with: npx tsx --test tests/opencode-agui.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lastUserText,
  opencodeShimRoutes,
  parseModelRef,
  RunTranslator,
} from "../apps/server/src/opencode/agui.ts";
import { OpencodeEventBus } from "../apps/server/src/opencode/events.ts";
import { connectionFromConfig } from "../apps/server/src/opencode/server.ts";

const testConnection = { url: "http://127.0.0.1:1", password: undefined };

function collectTranslator() {
  const events: Array<Record<string, unknown>> = [];
  let done = false;
  const translator = new RunTranslator(
    { threadId: "t1", runId: "r1", messages: [] },
    (event) => events.push(event),
    () => {
      done = true;
    },
  );
  return { translator, events, isDone: () => done };
}

const textPart = (overrides: Record<string, unknown> = {}) => ({
  id: "prt_1",
  sessionID: "ses_1",
  messageID: "msg_a",
  type: "text",
  text: "hello",
  ...overrides,
});

describe("parseModelRef", () => {
  it("splits provider/model", () => {
    assert.deepEqual(parseModelRef("openai/gpt-4o"), {
      providerID: "openai",
      modelID: "gpt-4o",
    });
  });
  it("returns undefined for missing/empty parts", () => {
    assert.equal(parseModelRef(undefined), undefined);
    assert.equal(parseModelRef("gpt-4o"), undefined);
    assert.equal(parseModelRef("/gpt-4o"), undefined);
    assert.equal(parseModelRef("openai/"), undefined);
  });
});

describe("lastUserText", () => {
  it("picks the last user message", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    assert.equal(lastUserText(messages), "second");
  });
  it("joins text content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ];
    assert.equal(lastUserText(messages), "ab");
  });
  it("returns undefined with no user message", () => {
    assert.equal(lastUserText([{ role: "assistant", content: "hi" }]), undefined);
  });
});

describe("RunTranslator", () => {
  it("streams assistant text from deltas and completes on session.idle", () => {
    const { translator, events, isDone } = collectTranslator();
    translator.handle({
      id: "e1",
      type: "message.updated",
      properties: { info: { id: "msg_a", role: "assistant" } },
    });
    translator.handle({
      id: "e2",
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: textPart({ text: "" }), time: 1 },
    });
    translator.handle({
      id: "e3",
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_a",
        partID: "prt_1",
        field: "text",
        delta: "hel",
      },
    });
    translator.handle({
      id: "e4",
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: textPart({ text: "hello" }), time: 2 },
    });
    translator.handle({ id: "e5", type: "session.idle", properties: { sessionID: "ses_1" } });

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    assert.equal(events[1].delta, "hel");
    assert.equal(events[2].delta, "lo"); // part.updated heals the gap after streamed deltas
    assert.equal(events[4].runId, "r1");
    assert.ok(isDone());
  });

  it("filters synthetic parts on egress", () => {
    const { translator, events } = collectTranslator();
    translator.handle({
      id: "e1",
      type: "message.updated",
      properties: { info: { id: "msg_u", role: "user" } },
    });
    translator.handle({
      id: "e2",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: textPart({
          id: "prt_ctx",
          messageID: "msg_u",
          text: "[hive context]",
          synthetic: true,
        }),
        time: 1,
      },
    });
    translator.handle({
      id: "e3",
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_u",
        partID: "prt_ctx",
        field: "text",
        delta: "more",
      },
    });
    assert.deepEqual(events, []);
  });

  it("ignores non-assistant messages", () => {
    const { translator, events } = collectTranslator();
    translator.handle({
      id: "e1",
      type: "message.updated",
      properties: { info: { id: "msg_u", role: "user" } },
    });
    translator.handle({
      id: "e2",
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: textPart({ messageID: "msg_u" }), time: 1 },
    });
    assert.deepEqual(events, []);
  });

  it("translates tool call lifecycle", () => {
    const { translator, events } = collectTranslator();
    const toolPart = (status: string, extra: Record<string, unknown> = {}) => ({
      id: "prt_t",
      sessionID: "ses_1",
      messageID: "msg_a",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status, input: { command: "ls" }, ...extra },
    });
    translator.handle({
      id: "e1",
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: toolPart("running"), time: 1 },
    });
    translator.handle({
      id: "e2",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: toolPart("completed", { output: "file.txt" }),
        time: 2,
      },
    });
    translator.handle({ id: "e3", type: "session.idle", properties: { sessionID: "ses_1" } });

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    assert.equal(events[0].toolCallName, "bash");
    assert.equal(events[1].delta, JSON.stringify({ command: "ls" }));
    assert.equal(events[3].content, "file.txt");
  });

  it("normalizes bridged Hive tool names for the UI", () => {
    const { translator, events } = collectTranslator();
    const toolPart = (status: string, extra: Record<string, unknown> = {}) => ({
      id: "prt_t",
      sessionID: "ses_1",
      messageID: "msg_a",
      type: "tool",
      callID: "call_1",
      tool: "hive_0123456789abcdef_create_issue",
      state: { status, input: { command: "ls" }, ...extra },
    });
    translator.handle({
      id: "e1",
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: toolPart("running"), time: 1 },
    });
    translator.handle({
      id: "e2",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: toolPart("completed", { output: "file.txt" }),
        time: 2,
      },
    });
    translator.handle({ id: "e3", type: "session.idle", properties: { sessionID: "ses_1" } });

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    assert.equal(events[0].toolCallName, "create_issue");
    assert.equal(events[1].delta, JSON.stringify({ command: "ls" }));
    assert.equal(events[3].content, "file.txt");
  });

  it("turns a tool call as OpenCode 1.18.33 really sends it into the four tool events", () => {
    // Captured from a real `opencode serve`, running `echo hello-from-shell` through its shell API:
    // the call is already running when it is first seen, and its state is updated twice more.
    const { translator, events, isDone } = collectTranslator();
    const sessionID = "ses_eee182be4ffe6OlokA2lfdv6CF";
    const messageID = "msg_111e7d676001QvAYW3QIcMQhir";
    const part = (state: Record<string, unknown>) => ({
      id: "prt_1",
      sessionID,
      messageID,
      type: "tool",
      callID: "01M48YFNKR2B1YG324FACX4AVW",
      tool: "bash",
      state,
    });
    const input = { command: "echo hello-from-shell" };
    for (const event of [
      { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
      {
        type: "message.updated",
        properties: { sessionID, info: { id: messageID, role: "assistant", sessionID } },
      },
      {
        type: "message.part.updated",
        properties: { sessionID, part: part({ status: "running", input, time: { start: 1 } }) },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: part({ status: "running", input, time: { start: 1 }, metadata: {} }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: part({
            status: "completed",
            input,
            output: "hello-from-shell\n",
            title: "",
            metadata: {},
            time: { start: 1, end: 2 },
          }),
        },
      },
      { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID } },
    ])
      translator.handle({ id: "e", ...event });
    assert.deepEqual(
      events.map((event) => event.type),
      ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "RUN_FINISHED"],
    );
    assert.equal(events[0].toolCallName, "bash");
    assert.equal(events[0].parentMessageId, messageID);
    assert.equal(events[1].delta, JSON.stringify(input));
    assert.equal(events[3].content, "hello-from-shell\n");
    assert.ok(isDone());
  });

  it("emits RUN_ERROR on session.error, with the reason OpenCode gives", () => {
    const { translator, events, isDone } = collectTranslator();
    // As OpenCode sends it: a named error with its message under `data` (captured from a real server).
    translator.handle({
      id: "e1",
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: {
          name: "APIError",
          data: {
            message: 'Forbidden: request blocked: no rule allows host "opencode.ai"',
            statusCode: 403,
          },
        },
      },
    });
    assert.equal(events[0].type, "RUN_ERROR");
    assert.equal(
      events[0].message,
      'Forbidden: request blocked: no rule allows host "opencode.ai"',
    );
    assert.ok(isDone());
    // Events after finish are ignored.
    translator.handle({ id: "e2", type: "session.idle", properties: { sessionID: "ses_1" } });
    assert.equal(events.length, 1);
  });

  it("names the kind of error when OpenCode gives no message", () => {
    for (const [error, expected] of [
      [
        { name: "ContextOverflowError", data: {} },
        "The OpenCode session reported an error (ContextOverflowError)",
      ],
      [{ message: "boom" }, "boom"],
      [undefined, "The OpenCode session reported an error"],
    ] as const) {
      const { translator, events } = collectTranslator();
      translator.handle({
        id: "e",
        type: "session.error",
        properties: { sessionID: "ses_1", error },
      });
      assert.equal(events[0].message, expected);
    }
  });

  it("surfaces permission.asked as a CUSTOM event without ending the run", () => {
    const { translator, events, isDone } = collectTranslator();
    translator.handle({
      id: "e1",
      type: "permission.asked",
      properties: {
        id: "req_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["rm *"],
        metadata: {},
      },
    });
    assert.equal(events[0].type, "CUSTOM");
    assert.equal(events[0].name, "permission-requested");
    assert.equal((events[0].value as Record<string, unknown>).requestId, "req_1");
    assert.ok(!isDone());
  });
});

describe("OpencodeEventBus", () => {
  // Reach into the private dispatch to test fan-out without a live server.
  const dispatch = (bus: OpencodeEventBus, event: Record<string, unknown>) =>
    (bus as unknown as { dispatch(raw: unknown): void }).dispatch(event);

  const evt = (type: string, properties: Record<string, unknown>) => ({
    payload: { id: "e", type, properties },
  });

  it("fans out only to tracks with the current session id (drops stale)", () => {
    const bus = new OpencodeEventBus(testConnection);
    const seen: string[] = [];
    bus.track("t1", "ses_new");
    bus.onEvent("t1", (e) => seen.push(e.type));
    dispatch(bus, evt("session.status", { sessionID: "ses_old", status: { type: "busy" } }));
    assert.deepEqual(seen, []);
    dispatch(bus, evt("session.status", { sessionID: "ses_new", status: { type: "busy" } }));
    assert.deepEqual(seen, ["session.status"]);
    assert.ok(bus.isBusy("t1"));
  });

  it("derives busy/idle from status events only", () => {
    const bus = new OpencodeEventBus(testConnection);
    bus.track("t1", "ses_1");
    dispatch(bus, evt("session.status", { sessionID: "ses_1", status: { type: "busy" } }));
    assert.ok(bus.isBusy("t1"));
    dispatch(
      bus,
      evt("message.part.delta", {
        sessionID: "ses_1",
        messageID: "m",
        partID: "p",
        field: "text",
        delta: "hi",
      }),
    );
    assert.ok(bus.isBusy("t1")); // deltas never touch the state buffer
    dispatch(bus, evt("session.idle", { sessionID: "ses_1" }));
    assert.ok(!bus.isBusy("t1"));
  });

  it("ignores sync envelopes", () => {
    const bus = new OpencodeEventBus(testConnection);
    const seen: string[] = [];
    bus.track("t1", "ses_1");
    bus.onEvent("t1", (e) => seen.push(e.type));
    dispatch(bus, {
      payload: { id: "e", type: "sync", properties: { sessionID: "ses_1" } },
    });
    assert.deepEqual(seen, []);
  });

  it("serializes enqueued actions per thread", async () => {
    const bus = new OpencodeEventBus(testConnection);
    const order: string[] = [];
    const slow = bus.enqueue("t1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    const fast = bus.enqueue("t1", async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["slow", "fast"]);
  });

  it("untrack stops fan-out", () => {
    const bus = new OpencodeEventBus(testConnection);
    const seen: string[] = [];
    bus.track("t1", "ses_1");
    const unsub = bus.onEvent("t1", (e) => seen.push(e.type));
    unsub();
    dispatch(bus, evt("session.idle", { sessionID: "ses_1" }));
    assert.deepEqual(seen, []);
  });
});

describe("opencodeShimRoutes", () => {
  const stubDeps = (service: Record<string, unknown>) =>
    ({
      // Nobody in these tests is a guest.
      service: { access: { isGuest: async () => false }, ...service },
      bus: new OpencodeEventBus(testConnection),
      pool: {},
      config: { model: "openai/gpt-4o" },
    }) as unknown as Parameters<typeof opencodeShimRoutes>[0];

  it("rejects invalid bodies with 400", async () => {
    const app = opencodeShimRoutes(stubDeps({}));
    const badJson = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
    const badShape = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    assert.equal(badShape.status, 400);
  });

  it("rejects a second concurrent run on the same thread with 409", async () => {
    // The orchestrator-channel ensure never resolves: the first run stays
    // in-flight. The first run mentions the agent so it passes the mention
    // gate and blocks there.
    const mentioned = JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ role: "user", content: "@hive do work" }],
    });
    const app = opencodeShimRoutes(
      stubDeps({ ensureOrchestratorChannel: () => new Promise(() => undefined) }),
    );
    const first = app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: mentioned,
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t1", runId: "r2", messages: [] }),
    });
    assert.equal(second.status, 409);
    // A different thread is unaffected.
    const other = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t2", runId: "r3", messages: [] }),
    });
    assert.notEqual(other.status, 409);
    await first; // resolves with the open stream response; the run stays pending
  });

  it("lazily binds an unbound run thread to the orchestrator channel", async () => {
    // Regression: without CopilotKit Intelligence the client runs as
    // thread "local-main", which has no channel binding. The run must bind
    // it instead of failing with "Thread local-main not found".
    const bound: Array<{ threadId: string; channelId: string; name?: string }> = [];
    const app = opencodeShimRoutes(
      stubDeps({
        ensureOrchestratorChannel: async () => ({ id: "orchestrator" }),
        ensureThreadBinding: async (
          _owner: unknown,
          threadId: string,
          channelId: string,
          name?: string,
        ) => {
          bound.push({ threadId, channelId, name });
          return { threadId, channelId, name };
        },
      }),
    );
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "local-main", runId: "r1", messages: [] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("RUN_STARTED"));
    assert.ok(text.includes("RUN_FINISHED"));
    assert.ok(!text.includes("RUN_ERROR"));
    assert.ok(!text.includes("not found"));
    assert.deepEqual(bound, [
      { threadId: "local-main", channelId: "orchestrator", name: "Main chat" },
    ]);
  });

  it("treats channel-scoped runs as chat-only no-ops without binding", async () => {
    // Channels open directly as chat surfaces; the server must not bind a
    // `channel:<id>` pseudo-thread to the orchestrator channel.
    const calls: string[] = [];
    const app = opencodeShimRoutes(
      stubDeps({
        ensureOrchestratorChannel: async () => {
          calls.push("ensureOrchestratorChannel");
        },
        ensureThreadBinding: async () => {
          calls.push("ensureThreadBinding");
        },
      }),
    );
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "channel:abc123",
        runId: "r1",
        messages: [{ role: "user", content: "@hive do work" }],
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("RUN_STARTED"));
    assert.ok(text.includes("RUN_FINISHED"));
    assert.ok(!text.includes("RUN_ERROR"));
    assert.deepEqual(calls, []);
  });
});

describe("connectionFromConfig", () => {
  it("honours OPENCODE_SERVER_URL/PASSWORD overrides", () => {
    const conn = connectionFromConfig({
      opencodeServerUrl: "http://10.0.0.5:4096",
      opencodeServerPassword: "s3cret",
    } as never);
    assert.equal(conn.url, "http://10.0.0.5:4096");
    assert.equal(conn.password, "s3cret");
  });
});
