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

test("people can be mentioned in a channel, and only those who can open it are offered or told", async () => {
  const made = async (name: string, visibility: "public" | "private") =>
    (await (
      await call("max", "POST", "/api/agent/channels", { name, visibility })
    ).json()) as Channel;
  const handles = async (who: Who, id: string) =>
    (
      (await (await call(who, "GET", `/api/agent/channels/${id}/mentionable`)).json()) as {
        handle: string;
      }[]
    ).map((p) => p.handle);
  const noticesOf = async (who: Who) =>
    (await (await call(who, "GET", "/api/agent/notifications")).json()) as {
      title: string;
      body: string;
      channelId?: string;
    }[];

  // A public channel: everyone but a guest, except the one asking.
  const open = await made("Plans", "public");
  assert.deepEqual(await handles("max", open.id), ["mia", "olive"]);
  assert.deepEqual(await handles("mia", open.id), ["max", "mia".replace("mia", "olive")].sort());
  // A private one: only those in it. Others are told nothing of it.
  const secret = await made("Hush", "private");
  await call("max", "POST", `/api/agent/channels/${secret.id}/members`, {
    add: ["mia@example.com"],
  });
  assert.deepEqual(await handles("max", secret.id), ["mia"]);
  assert.equal(
    (await call("olive", "GET", `/api/agent/channels/${secret.id}/mentionable`)).status,
    404,
  );

  // Mentioning tells the people named, not the writer, not those who cannot open the channel.
  await world.server.agent.notifyMentions(
    owner("max"),
    secret.id,
    "hello @mia and @olive and @max",
  );
  const mia = (await noticesOf("mia")).filter((n) => n.channelId === secret.id);
  assert.equal(mia.length, 1);
  assert.equal(mia[0].title, "Max mentioned you in #Hush");
  assert.equal(mia[0].body, "hello @mia and @olive and @max");
  assert.equal(
    (await noticesOf("olive")).some((n) => n.channelId === secret.id),
    false,
  );
  assert.equal(
    (await noticesOf("max")).some((n) => n.channelId === secret.id),
    false,
  );
  // Saying it again is the same notice.
  await world.server.agent.notifyMentions(
    owner("max"),
    secret.id,
    "hello @mia and @olive and @max",
  );
  assert.equal((await noticesOf("mia")).filter((n) => n.channelId === secret.id).length, 1);
  // A guest is told only of what they are in, and is offered only those in it.
  await call("olive", "POST", `/api/agent/channels/${open.id}/members`, {
    add: ["gus@example.com"],
  });
  assert.deepEqual(
    await handles("gus", open.id),
    ["max", "mia", "olive"].filter((h) => h !== "gus"),
  );
});

test("notifications are personal: the result of a task is for whoever started it", async () => {
  const now = new Date().toISOString();
  await world.db.put("shared", "tasks", {
    id: "task-by-max",
    title: "Summarise the launch notes",
    status: "completed",
    channelId: "general",
    createdBy: owner("max"),
    createdAt: now,
    updatedAt: now,
  } as never);
  await world.server.agent.notify(
    owner("max"),
    "Done: launch notes",
    "Summary is ready",
    "task-by-max",
    "k1",
  );
  await world.server.agent.notify(
    owner("max"),
    "The workspace updated",
    "A new version is running",
  );
  const titles = async (who: Who) =>
    (
      (await (await call(who, "GET", "/api/agent/notifications")).json()) as { title: string }[]
    ).map((n) => n.title);
  // Max asked for it, so it is his; the workspace's own notice is everyone's.
  assert.ok((await titles("max")).includes("Done: launch notes"));
  assert.ok(!(await titles("mia")).includes("Done: launch notes"));
  assert.ok(!(await titles("olive")).includes("Done: launch notes"));
  assert.ok((await titles("mia")).includes("The workspace updated"));
  // Someone else cannot read or dismiss it.
  const note = (
    (await (await call("max", "GET", "/api/agent/notifications")).json()) as {
      id: string;
      title: string;
    }[]
  ).find((n) => n.title === "Done: launch notes");
  assert.ok(note);
  assert.equal(
    (await call("mia", "POST", `/api/agent/notifications/${note.id}/dismiss`, {})).status,
    404,
  );
  assert.equal(
    (await call("mia", "POST", `/api/agent/notifications/${note.id}/read`, {})).status,
    404,
  );
  assert.equal(
    (await call("max", "POST", `/api/agent/notifications/${note.id}/read`, {})).status,
    200,
  );
});
