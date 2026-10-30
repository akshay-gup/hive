import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeJevAction } from "../../../packages/domain/src/jev.ts";
import { answeredSince, choiceLabel, choiceState } from "../src/channel-choices.ts";
import { agentView } from "../src/chat-agent-extra.ts";
import type { FeedMessage } from "../src/chat-feed.ts";

const panel = {
  id: "p1",
  threadId: "chat-room",
  turnId: "r1",
  candidateSetVersion: 1,
  type: "clarification",
  title: "What next?",
  options: [{ id: "explore", label: "Explore exhibits", details: [], sources: [] }],
  mode: "sample",
};
const call = (id: string, name: string) => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});
const upload = {
  requested: true,
  channelId: "c1",
  requestId: "0123456789abcdef",
  prompt: "The permission slip",
  accept: ["pdf"],
  multiple: true,
  folder: "uploads",
};
const reply = (id: string, status = "done"): FeedMessage =>
  ({
    id,
    author: { id: "hive", kind: "agent", name: "Hive" },
    body: "Pick one, and send the slip.",
    extra: {
      v: 1,
      runId: `run-${id}`,
      askedBy: "u1",
      status,
      steps: [
        {
          id: "a",
          role: "assistant",
          toolCalls: [call("c1", "present_choices"), call("c2", "request_upload")],
        },
        { id: "t1", role: "tool", toolCallId: "c1", content: JSON.stringify({ panel }) },
        { id: "t2", role: "tool", toolCallId: "c2", content: JSON.stringify(upload) },
      ],
    },
  }) as unknown as FeedMessage;
const said = (id: string, body: string): FeedMessage =>
  ({ id, author: { id: "u1", kind: "person", name: "Max" }, body }) as unknown as FeedMessage;
const pickText = encodeJevAction({
  panelId: "p1",
  threadId: "chat-room",
  candidateSetVersion: 1,
  optionId: "explore",
});

test("the choices and the request for files in a reply are cards of its view", () => {
  const view = agentView(reply("m1").extra);
  const cards = view?.segments.flatMap((segment) => segment.cards) ?? [];
  assert.deepEqual(
    cards.map((card) => [card.name, card.loading]),
    [
      ["present_choices", false],
      ["request_upload", false],
    ],
  );
  // Other tools the agent used are steps, not cards.
  const other = agentView({
    ...(reply("m2").extra as object),
    steps: [
      { id: "a", role: "assistant", toolCalls: [call("c1", "send_file")] },
      { id: "t", role: "tool", toolCallId: "c1", content: "{}" },
    ],
  });
  assert.equal(other?.segments.flatMap((segment) => segment.cards).length, 0);
});

test("only the choices shown after the person's last message may be picked, and a pick is confirmed once answered", () => {
  const open = choiceState([said("u0", "plan"), reply("m1")]);
  assert.equal(open.latestPanelId, "p1");
  assert.equal(open.threadId, "chat-room");
  assert.equal(open.busy, false);
  assert.equal(open.confirmedSelection("p1"), null);

  const going = choiceState([said("u0", "plan"), reply("m1", "working")]);
  assert.equal(going.busy, true);

  // The person writes something else: the old choices are not open any more.
  assert.equal(
    choiceState([said("u0", "plan"), reply("m1"), said("u1", "never mind")]).latestPanelId,
    null,
  );

  const picked = [said("u0", "plan"), reply("m1"), said("u1", pickText)];
  assert.equal(choiceState(picked).confirmedSelection("p1"), null);
  const answered = [...picked, { ...reply("m2"), body: "Exploring it is." } as FeedMessage];
  assert.equal(choiceState(answered).confirmedSelection("p1"), "explore");
});

test("a pick reads as the choice it made, and a request for files is answered once the person writes", () => {
  const feed = [said("u0", "plan"), reply("m1"), said("u1", pickText)];
  assert.equal(choiceLabel(feed, 2), "Selected: Explore exhibits");
  assert.equal(choiceLabel(feed, 0), "plan");
  assert.equal(choiceLabel([said("x", pickText)], 0), "Choice unavailable");
  assert.equal(answeredSince(feed.slice(0, 2), "m1"), false);
  assert.equal(answeredSince(feed, "m1"), true);
  assert.equal(answeredSince(feed, "gone"), false);
});

test("in a shared channel a pick starts with the mention that wakes the agent, and still reads as the choice", () => {
  const feed = [said("u0", "@hive plan"), reply("m1"), said("u1", `@hive ${pickText}`)];
  assert.equal(choiceLabel(feed, 2), "Selected: Explore exhibits");
  const answered = [...feed, { ...reply("m2"), body: "Exploring it is." } as FeedMessage];
  assert.equal(choiceState(answered).confirmedSelection("p1"), "explore");
});
