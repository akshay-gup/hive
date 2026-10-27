import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ChatCore } from "../apps/chat/src/core.ts";
import type { Channel, ChannelView } from "../packages/domain/src/agent.ts";
import { memorySql } from "./helpers/do-shim.ts";

/**
 * The rules about channels and the people in them, as the chat service enforces them: the same rules
 * the workspace server had (a channel is public or private, its managers look after who is in it, a
 * guest has only the channels that name them), run through the chat service's own routes.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let core: ChatCore;
before(() => {
  core = new ChatCore(memorySql());
});

const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const person = people[who];
  return core.handle(
    new Request(`http://chat${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      sub: person.id,
      email: person.email,
      name: person.name,
      role: person.role,
      issuedAt: Date.now(),
    },
  );
};
const json = (response: Response) => response.json();
const members = (id: string) => `/v1/channels/${id}/members`;
const channelsOf = async (who: Who) =>
  (await json(await call(who, "GET", "/v1/channels"))) as ChannelView[];
const namesOf = async (who: Who) => (await channelsOf(who)).map((c) => c.name).sort();
const make = async (who: Who, name: string, visibility?: "public" | "private") => {
  const response = await call(who, "POST", "/v1/channels", { name, visibility });
  assert.equal(response.status, 201, name);
  return (await json(response)) as Channel;
};
const add = (who: Who, id: string, ...emails: string[]) =>
  call(who, "POST", members(id), { add: emails });
const remove = (who: Who, id: string, ...emails: string[]) =>
  call(who, "POST", members(id), { remove: emails });
const stored = (id: string) => core.store.get<Channel>("shared", "channels", id);

test("a channel starts as the person who made it, and anyone in the team can find it and join it", async () => {
  const design = await make("max", "Design");
  assert.deepEqual(
    [design.visibility, design.everyone, design.members, design.managers],
    ["public", false, ["max@example.com"], ["max@example.com"]],
  );
  // Others see it, are not in it, and can look inside before they join. Admins manage every channel.
  const seen = (who: Who) => channelsOf(who).then((all) => all.find((c) => c.id === design.id));
  assert.deepEqual(
    [(await seen("mia"))?.joined, (await seen("mia"))?.manager, (await seen("mia"))?.count],
    [false, false, 1],
  );
  assert.deepEqual([(await seen("max"))?.joined, (await seen("max"))?.manager], [true, true]);
  assert.deepEqual([(await seen("ada"))?.joined, (await seen("ada"))?.manager], [false, true]);
  assert.equal((await call("mia", "GET", `/v1/channels/${design.id}`)).status, 200);
  // Joining is putting yourself in, and leaving is taking yourself out.
  const joined = await add("mia", design.id, "mia@example.com");
  assert.equal(joined.status, 200);
  assert.equal((await json(joined)).you.in, true);
  assert.deepEqual([(await seen("mia"))?.joined, (await seen("mia"))?.count], [true, 2]);
  const left = await remove("mia", design.id, "mia@example.com");
  assert.equal(left.status, 200);
  assert.equal((await seen("mia"))?.joined, false);
  // Not a guest: a guest has only the channels that name them.
  assert.ok(!(await namesOf("gus")).includes("Design"));
  assert.equal((await add("gus", design.id, "gus@example.com")).status, 404);
});

test("a channel made before people could join channels is open to the whole team, and stays so", async () => {
  const now = new Date().toISOString();
  await core.store.put("shared", "channels", {
    id: "general",
    name: "General",
    status: "active",
    createdBy: "acct:someone",
    createdAt: now,
    updatedAt: now,
  });
  for (const who of ["olive", "ada", "max", "mia"] as const) {
    const general = (await channelsOf(who)).find((c) => c.id === "general");
    assert.equal(general?.joined, true, who);
  }
  assert.ok(!(await namesOf("gus")).includes("General"));
  // Everyone is in it, so no one leaves it.
  const refused = await remove("mia", "general", "mia@example.com");
  assert.equal(refused.status, 409);
  assert.match((await json(refused)).error, /Everyone in the workspace is in this channel/);
  assert.equal((await call("mia", "GET", members("general"))).status, 200);
  const view = await json(await call("mia", "GET", members("general")));
  assert.deepEqual(
    [view.everyone, view.you.in, view.you.leave, view.you.join],
    [true, true, false, false],
  );
});

test("anyone in a private channel can add and take out people, and the last one cannot leave", async () => {
  const room = await make("max", "Hiring", "private");
  // Someone who is not in it cannot put themselves in.
  assert.equal((await add("mia", room.id, "mia@example.com")).status, 404);
  // Someone in it can add a teammate, and a guest, but not a stranger to the workspace.
  assert.equal((await add("max", room.id, "mia@example.com")).status, 200);
  assert.equal((await add("max", room.id, "gus@example.com")).status, 200);
  assert.equal((await add("max", room.id, "new@example.com")).status, 403);
  assert.deepEqual(await namesOf("gus"), ["Hiring"]);
  // Everyone in it sees who is in it, with who they are.
  const view = await json(await call("mia", "GET", members(room.id)));
  assert.deepEqual(
    view.people.map((p: { email: string; role: string | null; manager: boolean }) => [
      p.email,
      p.role,
      p.manager,
    ]),
    [
      ["max@example.com", "member", true],
      ["gus@example.com", "guest", false],
      ["mia@example.com", "member", false],
    ],
  );
  // A guest may leave a private channel, and is then gone from it.
  assert.equal((await remove("gus", room.id, "gus@example.com")).status, 200);
  assert.deepEqual(await namesOf("gus"), []);
  // Anyone in a private channel may take someone out.
  assert.equal((await remove("mia", room.id, "max@example.com")).status, 200);
  assert.equal((await call("max", "GET", members(room.id))).status, 404);
  // The last person cannot leave: there would be no one to open it.
  const last = await remove("mia", room.id, "mia@example.com");
  assert.equal(last.status, 403);
  assert.match((await json(last)).error, /last person/);
  assert.deepEqual((await stored(room.id))?.members, ["mia@example.com"]);
});

test("a guest is added to a public channel only by an owner or admin, and a stranger to the workspace only by them", async () => {
  const lounge = await make("max", "Lounge");
  const denied = await add("max", lounge.id, "gus@example.com");
  assert.equal(denied.status, 403);
  assert.match((await json(denied)).error, /owner or admin can add a guest to a public channel/);
  assert.equal((await add("max", lounge.id, "new@example.com")).status, 403);
  // A teammate, anyone in the team can add.
  assert.equal((await add("max", lounge.id, "mia@example.com")).status, 200);
  // A person who is not in a public channel joins it before adding people; an admin needs not.
  const outsider = await make("max", "Offsite");
  const notIn = await add("mia", outsider.id, "ada@example.com");
  assert.equal(notIn.status, 403);
  assert.match((await json(notIn)).error, /Join the channel/);
  assert.equal((await add("ada", outsider.id, "gus@example.com", "new@example.com")).status, 200);
  assert.deepEqual(await namesOf("gus"), ["Offsite"]);
  // A guest puts no one anywhere, joins no public channel, and cannot leave one.
  assert.equal((await add("gus", outsider.id, "mia@example.com")).status, 403);
  assert.equal((await add("gus", lounge.id, "gus@example.com")).status, 404);
  const stay = await remove("gus", outsider.id, "gus@example.com");
  assert.equal(stay.status, 403);
  assert.match((await json(stay)).error, /guest can't leave a public channel/);
  // The people who are not signed in yet are in the list, by their address.
  const view = await json(await call("max", "GET", members(outsider.id)));
  assert.ok(
    view.people.some(
      (p: { email: string; name: string }) => p.email === "new@example.com" && p.name === "",
    ),
  );
});

test("a channel's managers, and the owner and admins, take people out of a public channel, and choose its managers", async () => {
  const club = await make("max", "Club");
  assert.equal((await add("max", club.id, "mia@example.com", "ada@example.com")).status, 200);
  // A plain member cannot take people out of a public channel, nor choose managers.
  const stop = await remove("mia", club.id, "ada@example.com");
  assert.equal(stop.status, 403);
  assert.match((await json(stop)).error, /channel manager, an admin or the owner/);
  assert.equal(
    (
      await call("mia", "POST", `/v1/channels/${club.id}/managers`, {
        add: ["mia@example.com"],
      })
    ).status,
    403,
  );
  // A manager does, and chooses others, among the people in the channel and not a guest.
  const managers = (who: Who, body: unknown) =>
    call(who, "POST", `/v1/channels/${club.id}/managers`, body);
  assert.equal((await managers("max", { add: ["new@example.com"] })).status, 409);
  assert.equal((await add("ada", club.id, "gus@example.com")).status, 200);
  const guest = await managers("max", { add: ["gus@example.com"] });
  assert.equal(guest.status, 409);
  assert.match((await json(guest)).error, /guest can't manage/);
  const promoted = await managers("max", { add: ["mia@example.com"] });
  assert.equal(promoted.status, 200);
  assert.deepEqual(
    (await json(promoted)).people
      .filter((p: { manager: boolean }) => p.manager)
      .map((p: { email: string }) => p.email),
    ["max@example.com", "mia@example.com"],
  );
  // The new manager takes someone out; an admin does, with no part in the channel's own list of managers.
  assert.equal((await remove("mia", club.id, "gus@example.com")).status, 200);
  assert.equal((await remove("ada", club.id, "mia@example.com")).status, 200);
  // Leaving the channel ends managing it.
  assert.deepEqual((await stored(club.id))?.managers, ["max@example.com"]);
  // The owner is a manager of every channel they can open.
  assert.equal((await remove("olive", club.id, "ada@example.com")).status, 200);
  assert.equal(
    (await managers("olive", { add: ["max@example.com"], remove: ["max@example.com"] })).status,
    200,
  );
  assert.deepEqual((await stored(club.id))?.managers, []);
});

test("a manager makes a channel private, only an owner or admin makes it public again, and the team stays in it", async () => {
  const lab = await make("max", "Lab");
  await add("max", lab.id, "mia@example.com");
  const set = (who: Who, body: unknown) => call(who, "PATCH", `/v1/channels/${lab.id}`, body);
  // Anyone in the team can read a public channel; no one outside it can read a private one.
  assert.equal((await call("ada", "GET", `/v1/channels/${lab.id}`)).status, 200);
  assert.equal((await set("mia", { visibility: "private" })).status, 403);
  const closed = await set("max", { visibility: "private" });
  assert.equal(closed.status, 200);
  assert.equal((await json(closed)).visibility, "private");
  assert.equal((await call("ada", "GET", `/v1/channels/${lab.id}`)).status, 404);
  assert.equal((await call("mia", "GET", `/v1/channels/${lab.id}`)).status, 200);
  // A manager cannot open it up again; an owner can once they are in it.
  assert.equal((await set("max", { visibility: "public" })).status, 403);
  assert.equal((await add("max", lab.id, "olive@example.com")).status, 200);
  assert.equal((await set("olive", { visibility: "public" })).status, 200);
  assert.equal((await call("ada", "GET", `/v1/channels/${lab.id}`)).status, 200);
  // Archived, it is read-only: no one is added or taken out.
  assert.equal((await call("max", "POST", `/v1/channels/${lab.id}/archive`, {})).status, 200);
  const frozen = await add("max", lab.id, "ada@example.com");
  assert.equal(frozen.status, 409);
  assert.match((await json(frozen)).error, /archived/);
});

test("everyone in the workspace can be put in a channel by an owner or admin, and taken out without losing anyone who is here", async () => {
  const town = await make("max", "Town hall");
  const everyone = (who: Who, on: boolean) =>
    call(who, "PATCH", `/v1/channels/${town.id}`, { everyone: on });
  assert.equal((await everyone("max", true)).status, 403);
  const all = await everyone("ada", true);
  assert.equal(all.status, 200);
  const view = await json(all);
  assert.deepEqual([view.everyone, view.you.in], [true, true]);
  for (const who of ["olive", "ada", "mia"] as const)
    assert.equal((await channelsOf(who)).find((c) => c.id === town.id)?.joined, true, who);
  assert.equal(
    (await channelsOf("gus")).find((c) => c.id === town.id),
    undefined,
  );
  // Taking everyone out names the people who are here, who stay in; guests were never in.
  assert.equal((await everyone("ada", false)).status, 200);
  assert.deepEqual((await stored(town.id))?.members, [
    "ada@example.com",
    "max@example.com",
    "mia@example.com",
    "olive@example.com",
  ]);
  for (const who of ["olive", "ada", "mia", "max"] as const)
    assert.equal((await channelsOf(who)).find((c) => c.id === town.id)?.joined, true, who);
  // A private channel can't have everyone in it, and a channel made private by the team's owner keeps its people.
  const bad = await call("ada", "PATCH", `/v1/channels/${town.id}`, {
    visibility: "private",
    everyone: true,
  });
  assert.equal(bad.status, 409);
});

test("an older channel everyone is in becomes private only by an owner or admin, and keeps the people who are here", async () => {
  const now = new Date().toISOString();
  await core.store.put("shared", "channels", {
    id: "ops",
    name: "Ops",
    status: "active",
    createdBy: "acct:someone",
    createdAt: now,
    updatedAt: now,
    members: ["gus@example.com"],
  });
  assert.equal(
    (await call("max", "PATCH", "/v1/channels/ops", { visibility: "private" })).status,
    403,
  );
  const closed = await call("ada", "PATCH", "/v1/channels/ops", { visibility: "private" });
  assert.equal(closed.status, 200);
  assert.deepEqual((await stored("ops"))?.members, [
    "ada@example.com",
    "gus@example.com",
    "max@example.com",
    "mia@example.com",
    "olive@example.com",
  ]);
  assert.deepEqual(
    [(await stored("ops"))?.visibility, (await stored("ops"))?.everyone],
    ["private", false],
  );
  assert.ok((await namesOf("max")).includes("Ops"));
  assert.ok((await namesOf("gus")).includes("Ops"));
});

test("archiving a channel is for its managers, the owner and admins, and anyone in a private one, and not for guests", async () => {
  const spare = await make("max", "Spare");
  const hidden = await make("max", "Hidden spare", "private");
  const archive = (who: Who, id: string) => call(who, "POST", `/v1/channels/${id}/archive`, {});
  // A guest who cannot open a channel is told there is none; one who is in it is told it is not theirs to do.
  assert.equal((await archive("gus", spare.id)).status, 404);
  assert.equal((await add("ada", spare.id, "gus@example.com")).status, 200);
  assert.equal((await archive("gus", spare.id)).status, 403);
  await remove("ada", spare.id, "gus@example.com");
  // Someone who cannot open a private channel is told there is none.
  assert.equal((await archive("mia", hidden.id)).status, 404);
  // A member of the team who does not manage a public channel cannot put it away.
  assert.equal((await archive("mia", spare.id)).status, 403);
  assert.equal((await stored(spare.id))?.status, "active");
  assert.equal((await archive("max", spare.id)).status, 200);
  assert.equal((await stored(spare.id))?.status, "archived");
  // Anyone in a private channel may, since its last person cannot leave it.
  await add("max", hidden.id, "mia@example.com");
  assert.equal((await archive("mia", hidden.id)).status, 200);
  assert.equal((await stored(hidden.id))?.status, "archived");
  // An admin may archive a public channel they do not manage.
  const open = await make("max", "Open spare");
  assert.equal((await archive("ada", open.id)).status, 200);
});

test("an owner or admin can list every channel, private ones too, and join one to read it", async () => {
  const lost = await make("max", "Lost plans", "private");
  const team = await make("max", "Team notes");
  const directory = async (who: Who) => call(who, "GET", "/v1/admin/channels");
  // Only the people who run the workspace see the list; to anyone else it is not theirs to ask for.
  assert.equal((await directory("max")).status, 403);
  assert.equal((await directory("gus")).status, 403);
  const listed = (await json(await directory("ada"))) as {
    id: string;
    visibility: string;
    count: number;
    managers: string[];
    joined: boolean;
  }[];
  const row = listed.find((c) => c.id === lost.id);
  assert.deepEqual(
    [row?.visibility, row?.count, row?.managers, row?.joined],
    ["private", 1, ["Max"], false],
  );
  assert.ok(listed.some((c) => c.id === team.id));
  assert.equal(
    listed.some((c) => c.id === "orchestrator"),
    false,
  );
  // The list is names and numbers: what is said in the channel is still shut to them.
  assert.equal((await call("ada", "GET", `/v1/channels/${lost.id}/mentionable`)).status, 404);
  assert.equal((await call("max", "POST", `/v1/admin/channels/${lost.id}/join`)).status, 403);
  // Joining names them in it, for the people there to see, and opens it to them.
  const joined = await call("ada", "POST", `/v1/admin/channels/${lost.id}/join`);
  assert.equal(joined.status, 200);
  const entry = await json(joined);
  assert.deepEqual([entry.joined, entry.count], [true, 2]);
  assert.deepEqual((await stored(lost.id))?.members, ["ada@example.com", "max@example.com"]);
  assert.equal((await call("ada", "GET", `/v1/channels/${lost.id}/mentionable`)).status, 200);
  // And archives one they are not in, which would otherwise be left for good.
  const gone = await make("max", "Gone quiet", "private");
  const archived = await call("ada", "POST", `/v1/admin/channels/${gone.id}/archive`, {});
  assert.equal(archived.status, 200);
  assert.equal((await json(archived)).archived, true);
  assert.equal(
    (await call("max", "POST", `/v1/admin/channels/${team.id}/archive`, {})).status,
    403,
  );
});

test("a channel changed at the same moment by two people keeps both changes", async () => {
  const board = await make("max", "Board");
  const results = await Promise.all([
    add("max", board.id, "mia@example.com"),
    add("ada", board.id, "olive@example.com"),
    add("olive", board.id, "gus@example.com"),
  ]);
  for (const response of results) assert.equal(response.status, 200);
  assert.deepEqual((await stored(board.id))?.members, [
    "gus@example.com",
    "max@example.com",
    "mia@example.com",
    "olive@example.com",
  ]);
  // Leaving while another is added keeps both.
  await Promise.all([
    remove("mia", board.id, "mia@example.com"),
    add("max", board.id, "ada@example.com"),
  ]);
  const after = (await stored(board.id))?.members ?? [];
  assert.ok(!after.includes("mia@example.com"));
  assert.ok(after.includes("ada@example.com"));
});

test("a private channel is found only by the people in it, whoever else is asking", async () => {
  const channel = await make("max", "Finance", "private");
  assert.deepEqual(
    [channel.visibility, channel.everyone, channel.members],
    ["private", false, ["max@example.com"]],
  );
  // It is in no one else's list: not the team's, not the admin's, not the owner's, not a guest's.
  assert.ok((await namesOf("max")).includes("Finance"));
  for (const who of ["mia", "ada", "olive", "gus"] as const)
    assert.ok(!(await namesOf(who)).includes("Finance"), who);
  // And nothing that names it gets through: to anyone else it is not there.
  const hidden: [string, string, unknown?][] = [
    ["GET", `/v1/channels/${channel.id}`],
    ["GET", members(channel.id)],
    ["POST", members(channel.id), { add: ["mia@example.com"] }],
    ["POST", `/v1/channels/${channel.id}/managers`, { add: ["mia@example.com"] }],
    ["PATCH", `/v1/channels/${channel.id}`, { visibility: "public" }],
    ["POST", `/v1/channels/${channel.id}/archive`, {}],
    ["GET", `/v1/channels/${channel.id}/mentionable`],
    ["POST", `/v1/channels/${channel.id}/read`, {}],
  ];
  for (const who of ["mia", "ada", "olive", "gus"] as const)
    for (const [method, path, body] of hidden) {
      const response = await call(who, method, path, body);
      assert.equal(response.status, 404, `${who} ${method} ${path} ${response.status}`);
      assert.match((await json(response)).error, /is not there/i, `${who} ${method} ${path}`);
    }
  // The people in it use all of it.
  for (const path of ["", "/members", "/mentionable"])
    assert.equal((await call("max", "GET", `/v1/channels/${channel.id}${path}`)).status, 200);
});

test("a person's own place, and what they want to be told about, are theirs", async () => {
  const prefs = await call("max", "PUT", "/v1/notification-prefs", { muted: ["design"] });
  assert.deepEqual(await json(prefs), { mentions: true, work: true, muted: ["design"] });
  assert.deepEqual(await json(await call("mia", "GET", "/v1/notification-prefs")), {
    mentions: true,
    work: true,
    muted: [],
  });
  const me = await json(await call("gus", "GET", "/v1/me"));
  assert.deepEqual([me.email, me.role], ["gus@example.com", "guest"]);
});
