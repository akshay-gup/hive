import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Channel, ChannelView } from "../packages/domain/src/agent.ts";
import type { ChatMessage, ChatMessagePage, ChatNotice } from "../packages/domain/src/chat.ts";
import { chatWorld } from "./helpers/chat-world.ts";

/**
 * What people say in channels: messages and the threads under them, reactions, who has read what, and
 * who is told. The rules are Slack's: you take part in a channel you are in, you edit your own
 * messages, and a message goes when its author or the channel's managers take it away.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let world: Awaited<ReturnType<typeof chatWorld<typeof people>>>;
before(async () => {
  world = await chatWorld(people);
});

const { call } = {
  call: (who: Who, method: string, path: string, body?: unknown) =>
    world.call(who, method, path, body),
};
const ok = <T>(response: Response, status = 200) => world.ok<T>(response, status);
const make = async (who: Who, name: string, visibility?: "public" | "private") =>
  ok<Channel>(await call(who, "POST", "/v1/channels", { name, visibility }), 201);
const join = (who: Who, id: string) =>
  call(who, "POST", `/v1/channels/${id}/members`, { add: [people[who].email] });
const add = (who: Who, id: string, ...emails: string[]) =>
  call(who, "POST", `/v1/channels/${id}/members`, { add: emails });
const say = async (who: Who, channel: string, body: string, extra: object = {}) =>
  ok<ChatMessage>(
    await call(who, "POST", `/v1/channels/${channel}/messages`, { body, ...extra }),
    201,
  );
const page = async (who: Who, channel: string, query = "") =>
  ok<ChatMessagePage>(await call(who, "GET", `/v1/channels/${channel}/messages${query}`));
const bodies = (messages: ChatMessage[]) => messages.map((m) => m.body);
/** What a person is told about one channel (the world is shared, so other tests' notices are not theirs). */
const noticesIn = async (who: Who, channelId: string, query = "") =>
  (await ok<ChatNotice[]>(await call(who, "GET", `/v1/notifications${query}`))).filter(
    (n) => n.channelId === channelId,
  );
const unreadIn = async (who: Who, id: string) =>
  (await ok<ChannelView[]>(await call(who, "GET", "/v1/channels"))).find((c) => c.id === id)
    ?.unread;

test("people in a channel talk in it, and what is said comes back oldest first with who said it", async () => {
  const design = await make("max", "Design");
  await join("mia", design.id);
  const first = await say("max", design.id, "  hello team  ");
  assert.equal(first.body, "hello team", "trimmed");
  assert.deepEqual(
    [first.author.name, first.author.email, first.seq],
    ["Max", "max@example.com", 1],
  );
  await say("mia", design.id, "hi Max");
  assert.deepEqual(bodies((await page("olive", design.id)).messages), ["hello team", "hi Max"]);
  // Looking into a public channel is open to the team; taking part is for the people in it.
  const outside = await call("olive", "POST", `/v1/channels/${design.id}/messages`, {
    body: "can I?",
  });
  assert.equal(outside.status, 403);
  assert.match((await outside.json()).error, /Join the channel/);
  assert.equal(
    (await call("max", "POST", `/v1/channels/${design.id}/messages`, { body: "   " })).status,
    422,
  );
});

test("a message sent again with the same id is one message", async () => {
  const room = await make("max", "Retries");
  const a = await say("max", room.id, "once", { clientId: "k-1" });
  const b = await ok<ChatMessage>(
    await call("max", "POST", `/v1/channels/${room.id}/messages`, {
      body: "once",
      clientId: "k-1",
    }),
    201,
  );
  assert.equal(a.id, b.id);
  assert.equal((await page("max", room.id)).messages.length, 1);
});

test("a channel's history is paged back from the newest", async () => {
  const room = await make("max", "Long");
  for (let i = 1; i <= 7; i++) await say("max", room.id, `m${i}`);
  const newest = await page("max", room.id, "?limit=3");
  assert.deepEqual(bodies(newest.messages), ["m5", "m6", "m7"]);
  assert.equal(newest.more, true);
  const older = await page("max", room.id, `?limit=3&before=${newest.messages[0]?.seq}`);
  assert.deepEqual(bodies(older.messages), ["m2", "m3", "m4"]);
  assert.equal(
    (await call("max", "GET", `/v1/channels/${room.id}/messages?before=abc`)).status,
    422,
  );
});

test("a private channel's conversation is shut to everyone outside it, the owner and admins too", async () => {
  const room = await make("max", "Payroll", "private");
  const m = await say("max", room.id, "salaries");
  const hidden: [string, string, unknown?][] = [
    ["GET", `/v1/channels/${room.id}/messages`],
    ["POST", `/v1/channels/${room.id}/messages`, { body: "hi" }],
    ["GET", `/v1/channels/${room.id}/threads`],
    ["GET", `/v1/channels/${room.id}/since?seq=0`],
    ["GET", `/v1/messages/${m.id}/replies`],
    ["PATCH", `/v1/messages/${m.id}`, { body: "mine" }],
    ["DELETE", `/v1/messages/${m.id}`],
    ["PUT", `/v1/messages/${m.id}/reactions/${encodeURIComponent("👍")}`],
  ];
  for (const who of ["mia", "ada", "olive", "gus"] as const)
    for (const [method, path, body] of hidden) {
      const response = await call(who, method, path, body);
      assert.equal(response.status, 404, `${who} ${method} ${path}`);
    }
  assert.equal((await call("max", "GET", `/v1/messages/${m.id}/replies`)).status, 200);
});

test("a guest talks in the channels they were added to, and nowhere else", async () => {
  const room = await make("max", "Client work");
  await add("ada", room.id, "gus@example.com");
  assert.equal((await say("gus", room.id, "thanks for having me")).author.name, "Gus");
  const other = await make("max", "Internal");
  assert.equal(
    (await call("gus", "POST", `/v1/channels/${other.id}/messages`, { body: "hi" })).status,
    404,
  );
  assert.equal((await call("gus", "GET", `/v1/channels/${other.id}/messages`)).status, 404);
});

test("an archived channel is read-only", async () => {
  const room = await make("max", "Old project");
  const m = await say("max", room.id, "done");
  await call("max", "POST", `/v1/channels/${room.id}/archive`, {});
  assert.deepEqual(bodies((await page("mia", room.id)).messages), ["done"]);
  for (const [method, path, body] of [
    ["POST", `/v1/channels/${room.id}/messages`, { body: "more" }],
    ["PATCH", `/v1/messages/${m.id}`, { body: "edit" }],
    ["DELETE", `/v1/messages/${m.id}`],
    ["PUT", `/v1/messages/${m.id}/reactions/${encodeURIComponent("👍")}`],
  ] as const)
    assert.equal((await call("max", method, path, body)).status, 409, `${method} ${path}`);
});

test("a thread is replies to a message, counted on it and kept out of the channel's page", async () => {
  const room = await make("max", "Threads");
  await join("mia", room.id);
  const root = await say("max", room.id, "question?");
  const r1 = await say("mia", room.id, "answer", { threadRoot: root.id });
  await say("max", room.id, "thanks", { threadRoot: root.id });
  assert.deepEqual(bodies((await page("max", room.id)).messages), ["question?"]);
  const thread = await ok<{ root: ChatMessage; replies: ChatMessage[] }>(
    await call("mia", "GET", `/v1/messages/${root.id}/replies`),
  );
  assert.deepEqual(bodies(thread.replies), ["answer", "thanks"]);
  assert.deepEqual(
    [thread.root.replyCount, thread.root.replyPeople.map((p) => p.name)],
    [2, ["Mia", "Max"]],
  );
  const threads = await ok<ChatMessage[]>(
    await call("max", "GET", `/v1/channels/${room.id}/threads`),
  );
  assert.deepEqual(
    threads.map((m) => m.id),
    [root.id],
  );
  // Replies go to the first message of a thread, in the same channel.
  const nested = await call("mia", "POST", `/v1/channels/${room.id}/messages`, {
    body: "x",
    threadRoot: r1.id,
  });
  assert.equal(nested.status, 409);
  const other = await make("max", "Elsewhere");
  const wrong = await call("max", "POST", `/v1/channels/${other.id}/messages`, {
    body: "x",
    threadRoot: root.id,
  });
  assert.equal(wrong.status, 404);
});

test("only the author edits; the author, the channel's managers, admins and the owner delete", async () => {
  const room = await make("max", "Rules");
  await add("max", room.id, "mia@example.com", "ada@example.com");
  const mine = await say("mia", room.id, "typo");
  const edited = await ok<ChatMessage>(
    await call("mia", "PATCH", `/v1/messages/${mine.id}`, { body: "fixed" }),
  );
  assert.deepEqual([edited.body, edited.editedAt !== null], ["fixed", true]);
  // Not even the manager edits what someone else wrote.
  assert.equal(
    (await call("max", "PATCH", `/v1/messages/${mine.id}`, { body: "mine now" })).status,
    403,
  );
  assert.equal((await call("mia", "PATCH", `/v1/messages/${mine.id}`, { body: " " })).status, 422);
  // A plain member cannot delete someone else's; the author, a manager and an admin can.
  const theirs = await say("max", room.id, "from the manager");
  assert.equal((await call("mia", "DELETE", `/v1/messages/${theirs.id}`)).status, 403);
  assert.equal((await call("mia", "DELETE", `/v1/messages/${mine.id}`)).status, 200);
  const again = await say("mia", room.id, "second");
  assert.equal((await call("max", "DELETE", `/v1/messages/${again.id}`)).status, 200);
  const third = await say("mia", room.id, "third");
  assert.equal((await call("ada", "DELETE", `/v1/messages/${third.id}`)).status, 200);
  const fourth = await say("mia", room.id, "fourth");
  assert.equal((await call("olive", "DELETE", `/v1/messages/${fourth.id}`)).status, 200);
  assert.deepEqual(bodies((await page("max", room.id)).messages), ["from the manager"]);
});

test("a deleted message with a thread stays as a place for it", async () => {
  const room = await make("max", "Tombstones");
  const root = await say("max", room.id, "start");
  await say("max", room.id, "reply", { threadRoot: root.id });
  await call("max", "DELETE", `/v1/messages/${root.id}`);
  const shown = (await page("max", room.id)).messages;
  assert.deepEqual(
    shown.map((m) => [m.body, m.deleted, m.replyCount]),
    [["", true, 1]],
  );
});

test("reactions are one to a person and emoji, and show who", async () => {
  const room = await make("max", "Reactions");
  await join("mia", room.id);
  const m = await say("max", room.id, "ship it");
  const react = (who: Who, emoji: string, method = "PUT") =>
    call(who, method, `/v1/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`);
  await react("max", "👍");
  await react("max", "👍");
  const after = await ok<ChatMessage>(await react("mia", "👍"));
  await react("mia", "🎉");
  assert.deepEqual(after.reactions, [{ emoji: "👍", count: 2, users: ["acct_max", "acct_mia"] }]);
  const shown = (await page("max", room.id)).messages[0];
  assert.deepEqual(
    shown?.reactions.map((r) => [r.emoji, r.count]),
    [
      ["👍", 2],
      ["🎉", 1],
    ],
  );
  await react("max", "👍", "DELETE");
  assert.deepEqual(
    (await page("max", room.id)).messages[0]?.reactions.map((r) => [r.emoji, r.count]),
    [
      ["👍", 1],
      ["🎉", 1],
    ],
  );
  // Someone who is not in the channel does not react to what is said in it.
  assert.equal((await react("olive", "👍")).status, 403);
});

test("a channel is unread to you when someone else has written in it since you looked", async () => {
  const room = await make("max", "Unread");
  await join("mia", room.id);
  assert.equal(await unreadIn("mia", room.id), false);
  const m = await say("max", room.id, "news");
  assert.equal(await unreadIn("mia", room.id), true);
  assert.equal(await unreadIn("max", room.id), false, "your own are not unread to you");
  // Looking at it up to what was there.
  await call("mia", "POST", `/v1/channels/${room.id}/read`, { seq: m.seq });
  assert.equal(await unreadIn("mia", room.id), false);
  // A reply in a thread does not make the channel unread; it is the thread's.
  await say("max", room.id, "in a thread", { threadRoot: m.id });
  assert.equal(await unreadIn("mia", room.id), false);
  await say("max", room.id, "more news");
  assert.equal(await unreadIn("mia", room.id), true);
  // A channel she has muted has no mark.
  await call("mia", "PUT", "/v1/notification-prefs", { muted: [room.id] });
  assert.equal(await unreadIn("mia", room.id), false);
  await call("mia", "PUT", "/v1/notification-prefs", { muted: [] });
});

test("a mention tells that person, once, and only if they can open the channel", async () => {
  const room = await make("max", "Mentions", "private");
  await add("max", room.id, "mia@example.com");
  await say("max", room.id, "@mia can you look? cc @olive and @hive");
  const notices = await noticesIn("mia", room.id);
  assert.equal(notices.length, 1);
  assert.deepEqual(
    [
      notices[0]?.kind,
      notices[0]?.by,
      notices[0]?.byName,
      notices[0]?.channelName,
      notices[0]?.read,
    ],
    ["mention", "max@example.com", "Max", "Mentions", false],
  );
  assert.match(notices[0]?.title ?? "", /Max mentioned you in #Mentions/);
  assert.match(notices[0]?.body ?? "", /can you look/);
  // The owner is not in the private channel: nothing tells her it exists. Nor does the agent's name tell anyone.
  assert.deepEqual(await noticesIn("olive", room.id), []);
  assert.deepEqual(await noticesIn("max", room.id), []);
});

test("a reply tells the thread's starter and the others who replied, not the one who wrote it", async () => {
  const room = await make("max", "Replies");
  await join("mia", room.id);
  await join("ada", room.id);
  const root = await say("max", room.id, "poll: lunch?");
  await say("mia", room.id, "pizza", { threadRoot: root.id });
  await say("ada", room.id, "tacos", { threadRoot: root.id });
  const kinds = async (who: Who) =>
    (await ok<ChatNotice[]>(await call(who, "GET", "/v1/notifications")))
      .filter((n) => n.channelId === room.id)
      .map((n) => n.kind);
  assert.deepEqual(await kinds("max"), ["reply", "reply"]);
  assert.deepEqual(await kinds("mia"), ["reply"], "only Ada's");
  assert.deepEqual(await kinds("ada"), []);
});

test("notices are read, unread and dismissed by their owner, and a channel's mute silences them", async () => {
  const room = await make("max", "Notices");
  await join("mia", room.id);
  const m = await say("max", room.id, "@mia hello");
  const list = (query = "") => noticesIn("mia", room.id, query);
  assert.equal((await list("?unread=1")).length, 1);
  await call("mia", "POST", `/v1/notifications/${m.id}/read`);
  assert.equal((await list("?unread=1")).length, 0);
  assert.equal((await list())[0]?.read, true);
  await call("mia", "POST", `/v1/notifications/${m.id}/unread`);
  assert.equal((await list("?unread=1")).length, 1);
  // Someone else's notices are not yours to change.
  await call("max", "POST", `/v1/notifications/${m.id}/dismiss`);
  assert.equal((await list()).length, 1);
  await call("mia", "PUT", "/v1/notification-prefs", { muted: [room.id] });
  assert.equal((await list()).length, 0);
  await call("mia", "PUT", "/v1/notification-prefs", { muted: [] });
  await call("mia", "POST", `/v1/notifications/${m.id}/dismiss`);
  assert.equal((await list()).length, 0);
});

test("a deleted message takes the notices about it with it", async () => {
  const room = await make("max", "Take back");
  await join("mia", room.id);
  const m = await say("max", room.id, "@mia oops wrong channel");
  assert.equal((await noticesIn("mia", room.id)).length, 1);
  await call("max", "DELETE", `/v1/messages/${m.id}`);
  assert.deepEqual(await noticesIn("mia", room.id), []);
});
