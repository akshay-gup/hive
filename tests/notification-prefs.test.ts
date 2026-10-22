import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type {
  AgentWorkspace,
  Channel,
  ChannelView,
  NotificationPrefs,
} from "../packages/domain/src/agent.ts";
import { managedWorkspace } from "./helpers/managed.ts";

/** What a person is told about is theirs to choose: mentions, the work they asked for, and channels they mute. */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let world: Awaited<ReturnType<typeof managedWorkspace<typeof people>>>;
before(async () => {
  world = await managedWorkspace(people, "wprefs");
});
after(async () => {
  await world.close();
});

const call = (who: Who, method: string, path: string, body?: unknown) =>
  world.call(who, method, path, body);
const prefs = async (who: Who) =>
  (await (await call(who, "GET", "/api/agent/notification-prefs")).json()) as NotificationPrefs;
const set = (who: Who, body: unknown) => call(who, "PUT", "/api/agent/notification-prefs", body);
const noticesOf = async (who: Who) =>
  ((await (await call(who, "GET", "/api/agent")).json()) as AgentWorkspace).notifications;
const channel = async (who: Who, id: string) =>
  ((await (await call(who, "GET", "/api/agent/channels")).json()) as ChannelView[]).find(
    (c) => c.id === id,
  );

test("everything is on until a person turns something off, and what they choose is theirs alone", async () => {
  assert.deepEqual(await prefs("mia"), { mentions: true, work: true, muted: [] });
  const saved = await set("mia", { mentions: false });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { mentions: false, work: true, muted: [] });
  // Another person's are untouched, and a change leaves what it did not name as it was.
  assert.equal((await prefs("max")).mentions, true);
  await set("mia", { work: false });
  assert.deepEqual(await prefs("mia"), { mentions: false, work: false, muted: [] });
  await set("mia", { mentions: true, work: true });
  assert.deepEqual(await prefs("mia"), { mentions: true, work: true, muted: [] });
  // Not a thing to set.
  assert.equal((await set("mia", { mentions: "yes" })).status, 422);
  // A guest says what they want to be told as well.
  assert.equal((await set("gus", { work: false })).status, 200);
  assert.equal((await prefs("gus")).work, false);
});

test("a mention is not shown to someone who turned mentions off, and is there again when they turn them on", async () => {
  const made = (await (
    await call("max", "POST", "/api/agent/channels", { name: "Launch", visibility: "public" })
  ).json()) as Channel;
  await world.server.agent.notifyMentions(world.owner("max"), made.id, "over to you @mia");
  const mentions = async () => (await noticesOf("mia")).filter((n) => n.channelId === made.id);
  assert.equal((await mentions()).length, 1);
  await set("mia", { mentions: false });
  assert.equal((await mentions()).length, 0);
  await set("mia", { mentions: true });
  assert.equal((await mentions()).length, 1);
});

test("a muted channel has no unread mark and tells its person nothing, until it is unmuted", async () => {
  const made = (await (
    await call("max", "POST", "/api/agent/channels", { name: "Chatter", visibility: "public" })
  ).json()) as Channel;
  await call("mia", "POST", `/api/agent/channels/${made.id}/members`, { add: ["mia@example.com"] });
  await world.server.agent.noteMessage(world.owner("max"), made.id);
  await world.server.agent.notifyMentions(world.owner("max"), made.id, "look @mia");
  const seen = await channel("mia", made.id);
  assert.deepEqual([seen?.unread, seen?.muted], [true, false]);
  const quiet = await set("mia", { muted: [made.id] });
  assert.deepEqual((await quiet.json()).muted, [made.id]);
  const muted = await channel("mia", made.id);
  assert.deepEqual([muted?.unread, muted?.muted], [false, true]);
  assert.equal((await noticesOf("mia")).filter((n) => n.channelId === made.id).length, 0);
  // Muting is for the one who did it.
  assert.equal((await channel("max", made.id))?.muted, false);
  await set("mia", { muted: [] });
  assert.equal((await channel("mia", made.id))?.unread, true);
  assert.equal((await noticesOf("mia")).filter((n) => n.channelId === made.id).length, 1);
});
