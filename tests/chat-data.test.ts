import assert from "node:assert/strict";
import { test } from "node:test";
import { Events } from "../packages/chat-core/src/events.ts";
import { Messages } from "../packages/chat-core/src/messages.ts";
import { Notifications } from "../packages/chat-core/src/notifications.ts";
import { Reactions } from "../packages/chat-core/src/reactions.ts";
import { Reads } from "../packages/chat-core/src/reads.ts";
import { migrate, SCHEMA_VERSION } from "../packages/chat-core/src/schema.ts";
import { SqliteRecordStore } from "../packages/chat-core/src/sqlite-store.ts";
import { memorySql } from "./helpers/do-shim.ts";

let tick = 0;
/** A clock that moves one second on every look, so what is made later sorts later. */
const now = () => new Date(Date.UTC(2026, 9, 25, 12, 0, tick++)).toISOString();

function world() {
  const sql = memorySql();
  return {
    sql,
    store: new SqliteRecordStore(sql, now),
    messages: new Messages(sql, now),
    reactions: new Reactions(sql, now),
    reads: new Reads(sql, now),
    notices: new Notifications(sql, now),
  };
}

test("the tables are made once, and a database from newer code is refused", () => {
  const sql = memorySql({ migrated: false });
  assert.equal(migrate(sql), SCHEMA_VERSION);
  assert.equal(migrate(sql), SCHEMA_VERSION, "again changes nothing");
  sql.run("UPDATE meta SET value = ? WHERE key = 'schema'", String(SCHEMA_VERSION + 1));
  assert.throws(() => migrate(sql), /schema/);
});

test("records are kept as the permission code expects of a store", async () => {
  const { store } = world();
  await store.put("shared", "channels", { id: "c1", name: "design", updatedAt: "1" });
  assert.deepEqual(await store.get("shared", "channels", "c1"), {
    id: "c1",
    name: "design",
    updatedAt: "1",
  });
  assert.equal(await store.get("shared", "channels", "nope"), null);
  assert.equal((await store.list("shared", "channels")).length, 1);
  assert.equal((await store.listWhere("shared", "channels", "name", "design")).length, 1);
  assert.equal((await store.listWhere("shared", "channels", "name", "other")).length, 0);
  // Only the one who goes first wins.
  const first = await store.compareAndSwap(
    "shared",
    "channels",
    "c1",
    { updatedAt: "1" },
    { name: "ui", updatedAt: "2" },
  );
  const second = await store.compareAndSwap(
    "shared",
    "channels",
    "c1",
    { updatedAt: "1" },
    { name: "late", updatedAt: "3" },
  );
  assert.equal((first as { name: string }).name, "ui");
  assert.equal(second, null);
  assert.equal(await store.insertIfAbsent("shared", "channels", { id: "c1" }), null);
  assert.deepEqual(await store.insertIfAbsent("shared", "channels", { id: "c2" }), { id: "c2" });
  assert.deepEqual(await store.take("shared", "channels", "c2"), { id: "c2" });
  assert.equal(await store.take("shared", "channels", "c2"), null);
  await store.put("u", "prefs", { id: "a", at: 1 });
  await store.put("u", "prefs", { id: "b", at: 5 });
  assert.equal(await store.removeBelow("u", "prefs", "at", 3), 1);
  assert.equal((await store.scan("prefs")).length, 1);
  await store.remove("shared", "channels", "c1");
  assert.equal(await store.get("shared", "channels", "c1"), null);
});

test("messages are numbered in the channel, and a retry is the same message", () => {
  const { messages } = world();
  const a = messages.post({ channelId: "c1", authorId: "u1", body: "hello" });
  const b = messages.post({ channelId: "c1", authorId: "u2", body: "hi", clientId: "k1" });
  const other = messages.post({ channelId: "c2", authorId: "u1", body: "elsewhere" });
  assert.deepEqual([a.message.seq, b.message.seq, other.message.seq], [1, 2, 1]);
  const retry = messages.post({ channelId: "c1", authorId: "u2", body: "hi", clientId: "k1" });
  assert.equal(retry.created, false);
  assert.equal(retry.message.id, b.message.id);
  assert.equal(messages.lastSeq("c1"), 2);
  assert.deepEqual(messages.lastActivity("c1")?.by, "u2");
  // The same name from someone else is another message.
  assert.equal(
    messages.post({ channelId: "c1", authorId: "u1", body: "x", clientId: "k1" }).created,
    true,
  );
});

test("a thread's replies are counted on its first message and are not in the channel's pages", () => {
  const { messages } = world();
  const root = messages.post({ channelId: "c1", authorId: "u1", body: "root" }).message;
  const r1 = messages.post({
    channelId: "c1",
    authorId: "u2",
    body: "r1",
    threadRoot: root.id,
  }).message;
  messages.post({ channelId: "c1", authorId: "u3", body: "r2", threadRoot: root.id });
  messages.post({ channelId: "c1", authorId: "u2", body: "r3", threadRoot: root.id });
  const grown = messages.get(root.id);
  assert.equal(grown?.replyCount, 3);
  assert.deepEqual(grown?.replyUsers, ["u2", "u3"]);
  assert.deepEqual(
    messages.page("c1").messages.map((m) => m.body),
    ["root"],
  );
  assert.deepEqual(
    messages.replies(root.id).map((m) => m.body),
    ["r1", "r2", "r3"],
  );
  assert.deepEqual(
    messages.threads("c1").map((m) => m.id),
    [root.id],
  );
  assert.throws(
    () => messages.post({ channelId: "c1", authorId: "u1", body: "x", threadRoot: r1.id }),
    /first message/,
  );
  assert.throws(
    () => messages.post({ channelId: "c2", authorId: "u1", body: "x", threadRoot: root.id }),
    /not in this channel/,
  );
  assert.throws(
    () => messages.post({ channelId: "c1", authorId: "u1", body: "x", threadRoot: "nope" }),
    /not in this channel/,
  );
});

test("pages go back from a place, oldest first", () => {
  const { messages } = world();
  for (let i = 1; i <= 7; i++) messages.post({ channelId: "c1", authorId: "u1", body: `m${i}` });
  const newest = messages.page("c1", { limit: 3 });
  assert.deepEqual(
    newest.messages.map((m) => m.body),
    ["m5", "m6", "m7"],
  );
  assert.equal(newest.more, true);
  const older = messages.page("c1", { limit: 3, before: newest.messages[0]?.seq });
  assert.deepEqual(
    older.messages.map((m) => m.body),
    ["m2", "m3", "m4"],
  );
  const oldest = messages.page("c1", { limit: 3, before: older.messages[0]?.seq });
  assert.deepEqual(
    oldest.messages.map((m) => m.body),
    ["m1"],
  );
  assert.equal(oldest.more, false);
  assert.deepEqual(
    messages.since("c1", 5).map((m) => m.body),
    ["m6", "m7"],
  );
});

test("only the author edits, and a deleted message keeps its place and its thread", () => {
  const { messages } = world();
  const root = messages.post({ channelId: "c1", authorId: "u1", body: "root" }).message;
  const reply = messages.post({
    channelId: "c1",
    authorId: "u2",
    body: "reply",
    threadRoot: root.id,
  }).message;
  assert.equal(messages.edit(root.id, "u1", "root!").editedAt !== null, true);
  assert.throws(() => messages.edit(root.id, "u2", "mine"), /Only the person/);
  // Deleting a reply counts one fewer, and it is gone from the thread.
  assert.equal(messages.remove(reply.id)?.body, "reply");
  assert.equal(messages.get(root.id)?.replyCount, 0);
  assert.deepEqual(messages.replies(root.id), []);
  assert.equal(messages.remove(reply.id), null, "once");
  // A deleted message with no replies is not in the page; one with replies stays as a place.
  const other = messages.post({ channelId: "c1", authorId: "u1", body: "other" }).message;
  messages.post({ channelId: "c1", authorId: "u3", body: "r", threadRoot: other.id });
  messages.remove(other.id);
  messages.remove(root.id);
  const bodies = messages.page("c1").messages.map((m) => [m.body, m.deletedAt !== null]);
  assert.deepEqual(bodies, [["", true]]);
  assert.throws(() => messages.edit(other.id, "u1", "x"), /not found/);
});

test("reactions are one to a person, message and emoji", () => {
  const { messages, reactions } = world();
  const m = messages.post({ channelId: "c1", authorId: "u1", body: "hi" }).message;
  assert.equal(reactions.add(m.id, "c1", "u1", "👍"), true);
  assert.equal(reactions.add(m.id, "c1", "u1", "👍"), false);
  reactions.add(m.id, "c1", "u2", "👍");
  reactions.add(m.id, "c1", "u2", "🎉");
  assert.deepEqual(reactions.summary([m.id]).get(m.id), [
    { emoji: "👍", count: 2, users: ["u1", "u2"] },
    { emoji: "🎉", count: 1, users: ["u2"] },
  ]);
  assert.equal(reactions.remove(m.id, "u1", "👍"), true);
  assert.equal(reactions.remove(m.id, "u1", "👍"), false);
  assert.throws(() => reactions.add(m.id, "c1", "u1", ""), /emoji/);
  messages.remove(m.id);
  assert.equal(reactions.summary([m.id]).size, 0, "gone with the message");
});

test("unread is other people's messages in the channel after your place, and never goes back", () => {
  const { messages, reads } = world();
  const a = messages.post({ channelId: "c1", authorId: "u2", body: "a" }).message;
  messages.post({ channelId: "c1", authorId: "u1", body: "mine" });
  const c = messages.post({ channelId: "c1", authorId: "u2", body: "c" }).message;
  messages.post({ channelId: "c1", authorId: "u3", body: "in a thread", threadRoot: a.id });
  assert.equal(reads.unreadCount("u1", "c1"), 2, "mine and the thread reply do not count");
  assert.equal(reads.hasUnread("u1", "c1"), true);
  assert.equal(reads.mark("u1", "c1", a.seq), a.seq);
  assert.equal(reads.unreadCount("u1", "c1"), 1);
  assert.equal(reads.mark("u1", "c1", 0), a.seq, "it does not go back");
  reads.mark("u1", "c1", c.seq);
  assert.equal(reads.hasUnread("u1", "c1"), false);
  messages.post({ channelId: "c9", authorId: "u1", body: "only mine" });
  assert.equal(reads.hasUnread("u1", "c9"), false, "your own are not unread to you");
  assert.deepEqual([...reads.all("u1")], [["c1", c.seq]]);
  // Deleted ones are not unread.
  const d = messages.post({ channelId: "c1", authorId: "u2", body: "d" }).message;
  messages.remove(d.id);
  assert.equal(reads.hasUnread("u1", "c1"), false);
});

test("a person is told once about a message", () => {
  const { notices } = world();
  const mention = { userId: "u1", kind: "mention", messageId: "m1", channelId: "c1", seq: 3 };
  assert.equal(notices.add(mention), true);
  assert.equal(notices.add(mention), false);
  assert.equal(notices.add({ ...mention, kind: "reply" }), true);
  assert.equal(notices.unreadCount("u1"), 2);
  assert.equal(notices.markRead("u1", ["m1"]), 2);
  assert.equal(notices.unreadCount("u1"), 0);
  assert.equal(notices.markUnread("u1", ["m1"]), 2);
  assert.equal(notices.list("u1", { unreadOnly: true }).length, 2);
  assert.equal(notices.dismiss("u1", ["m1"]), 2);
  assert.equal(notices.list("u1").length, 0);
});

test("events can be caught up on until they are pruned", () => {
  const { sql } = world();
  let at = 1_000_000;
  const events = new Events(sql, () => at);
  assert.equal(events.covers(0), true);
  const a = events.append("message.new", { id: "m1" }, { channelId: "c1" });
  events.append("read.updated", { seq: 1 }, { userId: "u1" });
  const c = events.append("message.new", { id: "m2" }, { channelId: "c1" });
  assert.deepEqual(
    events.since(a.id).map((e) => e.id),
    [a.id + 1, c.id],
  );
  assert.equal(events.since(0)[0]?.channelId, "c1");
  assert.deepEqual(events.since(0)[1]?.userId, "u1");
  assert.equal(events.latest(), c.id);
  // The oldest go when there are more than are kept, and a client behind them is told so.
  assert.equal(events.prune({ keep: 1 }), 2);
  assert.equal(events.covers(0), false);
  assert.equal(events.covers(a.id + 1), true);
  assert.equal(events.covers(c.id), true);
  // And what is old goes whatever there are.
  at += 4 * 24 * 3600_000;
  assert.equal(events.prune({ keep: 100 }), 1);
  assert.equal(events.since(0).length, 0);
});
