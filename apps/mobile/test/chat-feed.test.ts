import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../../packages/domain/src/chat.ts";
import {
  applyEvent,
  continues,
  dropped,
  emptyFeed,
  type Feed,
  failed,
  newestSeq,
  older,
  put,
  replaced,
  retrying,
  type Scope,
  sending,
} from "../src/chat-feed.ts";

const person = (id: string) => ({ id, name: id, email: `${id}@x.test`, kind: "person" as const });
let n = 0;
const message = (over: Partial<ChatMessage> = {}): ChatMessage => {
  n++;
  return {
    id: `m${n}`,
    channelId: "c1",
    seq: n,
    author: person("max"),
    body: `text ${n}`,
    threadRoot: null,
    replyCount: 0,
    lastReplyAt: null,
    replyPeople: [],
    createdAt: new Date(Date.UTC(2026, 9, 25, 12, 0, n)).toISOString(),
    editedAt: null,
    deleted: false,
    reactions: [],
    files: [],
    ...over,
  };
};
const channel: Scope = { kind: "channel", channelId: "c1" };
const bodies = (feed: Feed) => feed.messages.map((m) => m.body);

test("a new message goes at its place, once, and one from another channel or a thread does not", () => {
  const a = message();
  const b = message();
  let feed = applyEvent(emptyFeed, channel, "message.new", b);
  feed = applyEvent(feed, channel, "message.new", a);
  feed = applyEvent(feed, channel, "message.new", a);
  assert.deepEqual(bodies(feed), [a.body, b.body]);
  const other = applyEvent(feed, channel, "message.new", message({ channelId: "c2" }));
  const reply = applyEvent(feed, channel, "message.new", message({ threadRoot: a.id }));
  assert.equal(other.messages.length, 2);
  assert.equal(reply.messages.length, 2);
  // In a thread's own feed it is the replies that count.
  const thread: Scope = { kind: "thread", root: a.id };
  const inThread = applyEvent(emptyFeed, thread, "message.new", message({ threadRoot: a.id }));
  assert.equal(inThread.messages.length, 1);
  assert.equal(applyEvent(emptyFeed, thread, "message.new", message()).messages.length, 0);
});

test("a message being sent is shown at once, and is replaced by the one that comes back", () => {
  const mine = { ...message({ seq: 0, id: "tmp", clientId: "k1", body: "hello" }) };
  let feed = sending(put(emptyFeed, message()), mine);
  assert.equal(feed.messages.at(-1)?.pending, true);
  const real = message({ clientId: "k1", body: "hello" });
  feed = applyEvent(feed, channel, "message.new", real);
  assert.deepEqual(
    feed.messages.map((m) => [m.id, m.pending ?? false]),
    [
      [feed.messages[0]?.id, false],
      [real.id, false],
    ],
  );
  assert.equal(feed.messages.length, 2, "not shown twice");
});

test("a message that did not send stays, can be tried again, or given up", () => {
  let feed = sending(emptyFeed, message({ seq: 0, id: "t", clientId: "k2" }));
  feed = failed(feed, "k2");
  assert.equal(feed.messages[0]?.failed, true);
  feed = retrying(feed, "k2");
  assert.equal(feed.messages[0]?.failed, false);
  assert.equal(dropped(feed, "k2").messages.length, 0);
});

test("a message edited is replaced, and reactions follow it", () => {
  const a = message();
  let feed = put(emptyFeed, a);
  feed = applyEvent(feed, channel, "message.edited", {
    ...a,
    body: "fixed",
    editedAt: "2026-10-25T12:30:00Z",
  });
  assert.deepEqual([feed.messages[0]?.body, feed.messages[0]?.editedAt !== null], ["fixed", true]);
  feed = applyEvent(feed, channel, "reaction.set", {
    messageId: a.id,
    channelId: "c1",
    reactions: [{ emoji: "👍", count: 1, users: ["mia"] }],
  });
  assert.equal(feed.messages[0]?.reactions[0]?.emoji, "👍");
  assert.equal(
    applyEvent(feed, channel, "reaction.set", { messageId: "nope", reactions: [] }),
    feed,
  );
});

test("a deleted message goes, unless a thread hangs from it, and then it stays as a place", () => {
  const plain = message();
  const threaded = message({ replyCount: 2 });
  let feed = put(put(emptyFeed, plain), threaded);
  feed = applyEvent(feed, channel, "message.deleted", {
    id: plain.id,
    channelId: "c1",
    threadRoot: null,
  });
  feed = applyEvent(feed, channel, "message.deleted", {
    id: threaded.id,
    channelId: "c1",
    threadRoot: null,
  });
  assert.deepEqual(
    feed.messages.map((m) => [m.deleted, m.body]),
    [[true, ""]],
  );
});

test("the first message of a thread is updated when someone replies", () => {
  const root = message();
  let feed = put(emptyFeed, root);
  feed = applyEvent(feed, channel, "thread.updated", {
    ...root,
    replyCount: 3,
    replyPeople: [person("mia")],
  });
  assert.equal(feed.messages[0]?.replyCount, 3);
});

test("older pages go before, without repeating, and the newest page keeps what is still being sent", () => {
  const msgs = [message(), message(), message(), message()];
  let feed = replaced(emptyFeed, [msgs[2] as ChatMessage, msgs[3] as ChatMessage], true);
  feed = older(
    feed,
    [msgs[0] as ChatMessage, msgs[1] as ChatMessage, msgs[2] as ChatMessage],
    false,
  );
  assert.deepEqual(
    feed.messages.map((m) => m.id),
    msgs.map((m) => m.id),
  );
  assert.equal(feed.more, false);
  feed = sending(feed, message({ seq: 0, id: "t", clientId: "k3" }));
  const refreshed = replaced(feed, [msgs[3] as ChatMessage], true);
  assert.deepEqual(
    refreshed.messages.map((m) => m.id),
    [msgs[3]?.id, "t"],
  );
  assert.equal(newestSeq(refreshed), msgs[3]?.seq);
});

test("messages by one person close together are shown as one run", () => {
  const a = message();
  const b = message({ createdAt: new Date(Date.parse(a.createdAt) + 60_000).toISOString() });
  const late = message({
    createdAt: new Date(Date.parse(a.createdAt) + 10 * 60_000).toISOString(),
  });
  const mia = message({ author: person("mia") });
  assert.equal(continues(undefined, a), false);
  assert.equal(continues(a, b), true);
  assert.equal(continues(a, late), false);
  assert.equal(continues(a, mia), false);
  assert.equal(continues({ ...a, deleted: true }, b), false);
});
