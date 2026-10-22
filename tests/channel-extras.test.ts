import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Channel, ChannelPeopleView, ChannelView } from "../packages/domain/src/agent.ts";
import { managedWorkspace } from "./helpers/managed.ts";

/**
 * What a channel has beyond its people: a first #general for a new team, a topic, and a mark for
 * what the others wrote since you were last in it.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let world: Awaited<ReturnType<typeof managedWorkspace<typeof people>>>;
before(async () => {
  world = await managedWorkspace(people, "wextras");
});
after(async () => {
  await world.close();
});

const call = (who: Who, method: string, path: string, body?: unknown) =>
  world.call(who, method, path, body);
const channelsOf = async (who: Who) =>
  (await (await call(who, "GET", "/api/agent/channels")).json()) as ChannelView[];
const find = async (who: Who, id: string) => (await channelsOf(who)).find((c) => c.id === id);
const owner = (who: Who) => world.owner(who);

test("a new workspace starts with a #general that everyone but a guest is in, once", async () => {
  // The first person in lists channels, and the team has somewhere to talk.
  const general = await find("olive", "general");
  assert.equal(general?.name, "general");
  assert.equal(general?.everyone, true);
  assert.equal(general?.joined, true);
  assert.equal((await find("mia", "general"))?.joined, true);
  // A guest is in nothing until someone names them.
  assert.equal(await find("gus", "general"), undefined);
  // It is made once: an archived one does not come back.
  const archived = await call("olive", "POST", "/api/agent/channels/general/archive", {});
  assert.equal(archived.status, 200);
  assert.equal((await channelsOf("olive")).filter((c) => c.id === "general").length, 1);
  assert.equal((await find("olive", "general"))?.status, "archived");
});

test("someone in a channel can set its topic, and no one else", async () => {
  const made = (await (
    await call("max", "POST", "/api/agent/channels", { name: "Design", visibility: "public" })
  ).json()) as Channel;
  const patch = (who: Who, topic: string) =>
    call(who, "PATCH", `/api/agent/channels/${made.id}`, { topic });
  // Mia can find it but is not in it.
  const before = (await (
    await call("mia", "GET", `/api/agent/channels/${made.id}/members`)
  ).json()) as ChannelPeopleView;
  assert.equal(before.you.topic, false);
  assert.equal((await patch("mia", "Hijacked")).status, 403);
  assert.equal((await patch("gus", "Hijacked")).status, 403);
  const saved = await patch("max", "  Screens and flows for the app  ");
  assert.equal(saved.status, 200);
  const view = (await saved.json()) as ChannelPeopleView;
  assert.equal(view.topic, "Screens and flows for the app");
  assert.equal((await find("mia", made.id))?.topic, "Screens and flows for the app");
  // Too long is refused, and an empty topic clears it.
  assert.equal((await patch("max", "x".repeat(251))).status, 422);
  assert.equal(((await (await patch("max", "")).json()) as ChannelPeopleView).topic, "");
  // Changing the topic does not undo who is in the channel.
  assert.deepEqual(
    view.people.map((p) => p.email),
    ["max@example.com"],
  );
});

test("a channel is unread for the others in it after someone writes, until they open it", async () => {
  const made = (await (
    await call("max", "POST", "/api/agent/channels", { name: "Launch", visibility: "public" })
  ).json()) as Channel;
  await call("mia", "POST", `/api/agent/channels/${made.id}/members`, {
    add: ["mia@example.com"],
  });
  // Nothing was said yet.
  assert.equal((await find("mia", made.id))?.unread, false);
  await world.server.agent.noteMessage(owner("max"), made.id);
  // The others are told; the writer is not; someone who is not in it is not either.
  assert.equal((await find("mia", made.id))?.unread, true);
  assert.equal((await find("max", made.id))?.unread, false);
  assert.equal((await find("olive", made.id))?.unread, false);
  // Opening it reads it, and only for that person.
  assert.equal((await call("mia", "POST", `/api/agent/channels/${made.id}/read`, {})).status, 200);
  assert.equal((await find("mia", made.id))?.unread, false);
  await world.server.agent.noteMessage(owner("max"), made.id);
  assert.equal((await find("mia", made.id))?.unread, true);
  // A channel one cannot open cannot be marked read.
  const secret = (await (
    await call("max", "POST", "/api/agent/channels", { name: "Quiet", visibility: "private" })
  ).json()) as Channel;
  assert.equal(
    (await call("mia", "POST", `/api/agent/channels/${secret.id}/read`, {})).status,
    404,
  );
});
