/**
 * Mention-gating tests: the OpenCode shim only runs when the latest user
 * message mentions the agent; otherwise the run is a silent no-op.
 * Run with: npx tsx --test tests/opencode-mention.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTranscript,
  mentionsAgent,
  messageFileParts,
  normalizeMention,
  opencodeShimRoutes,
  promptFileParts,
  shouldTriggerRun,
  stripMention,
} from "../apps/server/src/opencode/agui.ts";
import { OpencodeEventBus } from "../apps/server/src/opencode/events.ts";

const MENTION = "@hive";

describe("normalizeMention", () => {
  it("defaults to @hive", () => {
    assert.equal(normalizeMention(undefined), "@hive");
    assert.equal(normalizeMention(""), "@hive");
    assert.equal(normalizeMention("   "), "@hive");
  });
  it("trims and adds a missing @", () => {
    assert.equal(normalizeMention("  helper  "), "@helper");
    assert.equal(normalizeMention("@Helper"), "@Helper");
  });
});

describe("mentionsAgent", () => {
  it("matches a standalone token", () => {
    assert.ok(mentionsAgent("@hive do the thing", MENTION));
    assert.ok(mentionsAgent("hey @hive, look at this", MENTION));
    assert.ok(mentionsAgent("(@hive)", MENTION));
    assert.ok(mentionsAgent("thanks @hive.", MENTION));
  });
  it("is case-insensitive", () => {
    assert.ok(mentionsAgent("@Hive help", MENTION));
    assert.ok(mentionsAgent("ping @HIVE", MENTION));
  });
  it("rejects glued tokens", () => {
    assert.ok(!mentionsAgent("@hiveX do it", MENTION));
    assert.ok(!mentionsAgent("mail@hive", MENTION));
    assert.ok(!mentionsAgent("@hive2", MENTION));
    assert.ok(!mentionsAgent("the hive bot", MENTION));
  });
  it("rejects absence", () => {
    assert.ok(!mentionsAgent("just chatting here", MENTION));
    assert.ok(!mentionsAgent("", MENTION));
  });
});

describe("shouldTriggerRun", () => {
  const msg = (role: string, content: string, extra: Record<string, unknown> = {}) => ({
    role,
    content,
    ...extra,
  });
  it("triggers on a mention in the last user message", () => {
    assert.ok(
      shouldTriggerRun(
        [msg("user", "hello"), msg("assistant", "hi"), msg("user", "@hive summarize")],
        MENTION,
      ),
    );
  });
  it("ignores a mention in an older message", () => {
    assert.ok(
      !shouldTriggerRun(
        [msg("user", "@hive summarize"), msg("assistant", "ok"), msg("user", "never mind")],
        MENTION,
      ),
    );
  });
  it("ignores mentions in assistant messages", () => {
    assert.ok(
      !shouldTriggerRun([msg("user", "hi"), msg("assistant", "try @hive for that")], MENTION),
    );
  });
  it("is false with no user message", () => {
    assert.ok(!shouldTriggerRun([msg("assistant", "@hive hi")], MENTION));
    assert.ok(!shouldTriggerRun([], MENTION));
  });
});

describe("stripMention", () => {
  it("removes the token and tidies whitespace", () => {
    assert.equal(stripMention("@hive do the thing", MENTION), "do the thing");
    assert.equal(stripMention("hey @Hive, do it", MENTION), "hey , do it");
    assert.equal(stripMention("@hive", MENTION), "");
  });
  it("removes every occurrence", () => {
    assert.equal(stripMention("@hive one @hive two", MENTION), "one two");
  });
  it("leaves non-mentions alone", () => {
    assert.equal(stripMention("@hiveX do it", MENTION), "@hiveX do it");
  });
});

describe("buildTranscript", () => {
  it("orders turns with role labels", () => {
    const transcript = buildTranscript([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);
    assert.equal(transcript, "User: first\nAssistant: reply\nUser: second");
  });
  it("prefers message names over role labels, never invents them", () => {
    const transcript = buildTranscript([
      { role: "user", content: "hi", name: "akshay" },
      { role: "user", content: "yo" },
    ]);
    assert.equal(transcript, "akshay: hi\nUser: yo");
  });
  it("joins text parts and marks images", () => {
    const transcript = buildTranscript([
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          {
            type: "image",
            source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
          },
        ],
      },
    ]);
    assert.equal(transcript, "User: see this\n[attached file (image/png)]");
  });
  it("skips non-chat roles and empty messages", () => {
    const transcript = buildTranscript([
      { role: "system", content: "hidden" },
      { role: "user", content: "" },
      { role: "assistant", content: "kept" },
    ]);
    assert.equal(transcript, "Assistant: kept");
  });
  it("truncates from the front, keeping the recent tail", () => {
    const messages = Array.from({ length: 300 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message number ${i} with padding ${"x".repeat(120)}`,
    }));
    const transcript = buildTranscript(messages);
    assert.ok(transcript.length <= 20_000 + "[earlier history omitted]\n".length);
    assert.ok(transcript.startsWith("[earlier history omitted]"));
    assert.ok(transcript.includes("message number 199"));
    assert.ok(!transcript.includes("message number 0 with"));
  });
});

describe("messageFileParts", () => {
  it("maps data-source images to data URLs", () => {
    const parts = messageFileParts({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" } },
      ],
    });
    assert.deepEqual(parts, [
      { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=" },
    ]);
  });
  it("passes url-source images through", () => {
    const parts = messageFileParts({
      role: "user",
      content: [
        { type: "image", source: { type: "url", value: "https://x/y.png", mimeType: "image/png" } },
      ],
    });
    assert.deepEqual(parts, [{ type: "file", mime: "image/png", url: "https://x/y.png" }]);
  });
  it("ignores malformed or non-image parts", () => {
    assert.deepEqual(messageFileParts({ role: "user", content: "plain" }), []);
    assert.deepEqual(
      messageFileParts({
        role: "user",
        content: [{ type: "image", source: { type: "data" } }],
      }),
      [],
    );
  });
});

describe("promptFileParts", () => {
  it("takes files from the last user message only", () => {
    const image = {
      type: "image",
      source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
    };
    const parts = promptFileParts([
      { role: "user", content: [image] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "@hive go" },
    ]);
    assert.deepEqual(parts, []);
    const parts2 = promptFileParts([
      { role: "user", content: "@hive go" },
      { role: "user", content: [{ type: "text", text: "@hive see" }, image] },
    ]);
    assert.equal(parts2.length, 1);
    assert.equal(parts2[0].type, "file");
  });
});

describe("opencodeShimRoutes mention gating", () => {
  const testConnection = { url: "http://127.0.0.1:1", password: undefined };
  const stubDeps = (service: Record<string, unknown>) =>
    ({
      // Nobody in these tests is a guest.
      service: {
        access: { isGuest: async () => false, assertChannel: async () => undefined },
        noteMessage: async () => undefined,
        notifyMentions: async () => undefined,
        ...service,
      },
      bus: new OpencodeEventBus(testConnection),
      pool: {},
      config: { model: "openai/gpt-4o", agentMention: "@hive" },
    }) as unknown as Parameters<typeof opencodeShimRoutes>[0];

  const eventTypes = async (res: Response): Promise<string[]> =>
    (await res.text())
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => (JSON.parse(chunk.slice("data: ".length)) as { type: string }).type);

  it("completes a mention-less run in a shared channel as a no-op without touching OpenCode", async () => {
    // The lazy orchestrator bind runs before the mention gate, but it only
    // touches the thread store — OpenCode itself is never reached.
    const app = opencodeShimRoutes(
      stubDeps({
        ensureOrchestratorChannel: async () => ({ id: "orchestrator" }),
        ensureThreadBinding: async () => ({ threadId: "t1", channelId: "team" }),
      }),
    );
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r1",
        messages: [
          { role: "user", content: "just chatting" },
          { role: "assistant", content: "same here" },
          { role: "user", content: "no mention in this one" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await eventTypes(res), ["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("tells the people a message mentions, and marks the channel, even when the agent is not asked", async () => {
    const told: [string, string][] = [];
    const marked: string[] = [];
    const app = opencodeShimRoutes(
      stubDeps({
        ensureOrchestratorChannel: async () => ({ id: "orchestrator" }),
        ensureThreadBinding: async () => ({ threadId: "t1", channelId: "team" }),
        noteMessage: async (_owner: string, channelId: string) => {
          marked.push(channelId);
        },
        notifyMentions: async (_owner: string, channelId: string, text: string) => {
          told.push([channelId, text]);
        },
      }),
    );
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "@mia can you look at this?" }],
      }),
    });
    assert.deepEqual(await eventTypes(res), ["RUN_STARTED", "RUN_FINISHED"]);
    assert.deepEqual(marked, ["team"]);
    assert.deepEqual(told, [["team", "@mia can you look at this?"]]);
  });

  it("releases the in-flight slot after a no-op run", async () => {
    const app = opencodeShimRoutes(
      stubDeps({
        ensureOrchestratorChannel: async () => ({ id: "orchestrator" }),
        ensureThreadBinding: async () => ({ threadId: "t1", channelId: "team" }),
      }),
    );
    const body = (runId: string) =>
      JSON.stringify({ threadId: "t1", runId, messages: [{ role: "user", content: "chat" }] });
    const first = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body("r1"),
    });
    assert.deepEqual(await eventTypes(first), ["RUN_STARTED", "RUN_FINISHED"]);
    const second = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body("r2"),
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await eventTypes(second), ["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("answers everything said in your own chat, mention or not", async () => {
    const app = opencodeShimRoutes(
      stubDeps({
        ensureOrchestratorChannel: async () => ({ id: "orchestrator" }),
        ensureThreadBinding: async () => ({ threadId: "t1", channelId: "orchestrator" }),
      }),
    );
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "what is on my list today" }],
      }),
    });
    // The stub has no OpenCode behind it, so the run fails: it was not skipped as a no-op.
    assert.notDeepEqual(await eventTypes(res), ["RUN_STARTED", "RUN_FINISHED"]);
  });
});
