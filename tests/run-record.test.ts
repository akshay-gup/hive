import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { opencodeShimRoutes } from "../apps/server/src/opencode/agui.ts";
import {
  mergeableMessages,
  mergeMessages,
  RunRecord,
} from "../apps/server/src/opencode/run-record.ts";

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

test("merging replaces a message by id and adds new ones at the end", () => {
  const merged = mergeMessages(
    [
      { id: "a", role: "user", content: "hi" },
      { id: "b", role: "assistant", content: "par" },
    ],
    [
      { id: "b", role: "assistant", content: "partial, then more" },
      { id: "c", role: "tool", content: "x" },
    ],
  );
  assert.deepEqual(
    merged.map((m) => [m.id, m.content]),
    [
      ["a", "hi"],
      ["b", "partial, then more"],
      ["c", "x"],
    ],
  );
});

test("of what a page sends only the message that started the run is kept", () => {
  const sent = [
    { id: "u1", role: "user", content: "old" },
    { id: "a1", role: "assistant", content: "reply" },
    { id: "u2", role: "user", content: "@hive hello?" },
  ];
  assert.deepEqual(
    mergeableMessages(sent).map((m) => m.id),
    ["u2"],
  );
  assert.deepEqual(mergeableMessages([]), []);
});

test("the shim says whether a thread has a run going, and Stop on one with none is harmless", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("owner" as never, "owner" as never);
    await next();
  });
  app.route("/", opencodeShimRoutes({ config: {} } as never));
  const live = await app.request("/live?threadId=t1");
  assert.deepEqual(await live.json(), { running: false });
  const stop = await app.request("/stop", {
    method: "POST",
    body: JSON.stringify({ threadId: "t1" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(stop.status, 200);
});

test("a thread can be started from what is written in it, with no page attached", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("owner" as never, "owner" as never);
    await next();
  });
  let asked = "";
  app.route(
    "/",
    opencodeShimRoutes({
      config: {},
      loadMessages: async (_owner: string, threadId: string) => {
        asked = threadId;
        return [{ id: "u1", role: "user", content: "no mention, so nothing to do" }];
      },
    } as never),
  );
  const started = await app.request("/start", {
    method: "POST",
    body: JSON.stringify({ threadId: "thread-1" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(started.status, 200);
  assert.equal(asked, "thread-1");
  assert.deepEqual(await started.json(), { started: true });
  const bad = await app.request("/start", { method: "POST", body: "{}" });
  assert.equal(bad.status, 400);
});

test("a message sent while the agent is working is written down and answered next", async () => {
  const saved: string[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("owner" as never, "owner" as never);
    await next();
  });
  app.route(
    "/",
    opencodeShimRoutes({
      config: {},
      saveMessages: async (_o: string, _t: string, messages: Array<{ id: string }>) => {
        for (const message of messages) saved.push(message.id);
      },
      loadMessages: async () => [{ id: "u2", role: "user", content: "later, no mention" }],
    } as never),
  );
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  const sent = await post("/queue", { threadId: "t1", message: { id: "u2", content: "hi" } });
  assert.equal(sent.status, 200);
  assert.equal(saved[0], "u2", "it is kept before anything else happens");
  assert.equal((await post("/queue", { threadId: "t1" })).status, 400);
});

test("after a restart a reply that was being written is picked up again, once", async () => {
  const cleared: string[] = [];
  const loaded: string[] = [];
  const routes = opencodeShimRoutes({
    config: {},
    runMarks: {
      set: async () => {},
      clear: async (threadId: string) => {
        cleared.push(threadId);
      },
      all: async () => [
        { threadId: "fresh", owner: "o", startedAt: Date.now() - 60_000 },
        { threadId: "old", owner: "o", startedAt: Date.now() - 3 * 60 * 60_000 },
      ],
    },
    loadMessages: async (_owner: string, threadId: string) => {
      loaded.push(threadId);
      return [];
    },
  } as never);
  await routes.resume();
  assert.deepEqual(loaded, ["fresh"], "one from an hour ago is left alone");
  assert.ok(cleared.includes("fresh") && cleared.includes("old"));
});

test("the main chat is one record whether the page or the agent names it", async () => {
  const { conversationKey } = await import("../apps/server/src/app.ts");
  assert.equal(conversationKey("local-main"), "default");
  assert.equal(conversationKey(undefined), "default");
  assert.equal(conversationKey("thread-7"), "thread-7");
});
