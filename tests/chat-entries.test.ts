import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ChatCore } from "../apps/chat/src/core.ts";
import type { Entry } from "../packages/chat-core/src/entries.ts";
import type { Project } from "../packages/domain/src/agent.ts";
import { chatWorld } from "./helpers/chat-world.ts";

/**
 * What the room keeps that is not a task (notices, goals, routines) is an entry with a scope, and who may see
 * it comes from the scope each time it is read: a person's is theirs alone, even against an admin; a
 * project's and a channel's follow the project and the channel; the team's is for all but a guest.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let call: (who: Who, method: string, path: string, body?: unknown) => Promise<Response>;
let core: ChatCore;
let published: { type: string; data: unknown; userId?: string | null }[];

beforeEach(async () => {
  const world = await chatWorld(people);
  call = world.call;
  core = world.core;
  published = world.published as never;
});

const id = (who: Who) => people[who].id;
const json = <T>(response: Response) => response.json() as Promise<T>;
const seen = async (who: Who, kind = "goal") =>
  (await core.rules.visible(id(who), kind)).map((e) => e.data.title);
const make = (who: Who, scope: Entry["scope"], title: string, kind = "goal") =>
  core.rules.create(id(who), { kind, scope, data: { title } });
const project = async (who: Who, body: object) => {
  const response = await call(who, "POST", "/v1/projects", body);
  assert.equal(response.status, 201);
  return json<Project>(response);
};
const channel = async (
  who: Who,
  name: string,
  visibility: "public" | "private",
  add: Who[] = [],
) => {
  const made = await json<{ id: string }>(
    await call(who, "POST", "/v1/channels", { name, visibility }),
  );
  if (add.length)
    await call(who, "POST", `/v1/channels/${made.id}/members`, {
      add: add.map((w) => people[w].email),
    });
  return made.id;
};

test("a person's entry is theirs alone, and not even an admin or the owner sees it", async () => {
  const mine = await make("mia", { type: "person", id: id("max") }, "Mia's own");
  // Whoever is named in the scope, the entry is made for the person who made it.
  assert.deepEqual(mine.scope, { type: "person", id: id("mia") });
  assert.deepEqual(await seen("mia"), ["Mia's own"]);
  for (const other of ["max", "ada", "olive", "gus"] as const) {
    assert.deepEqual(await seen(other), [], other);
    await assert.rejects(core.rules.open(id(other), mine.id), /not there/);
    await assert.rejects(core.rules.update(id(other), mine.id, { status: "x" }), /not there/);
    await assert.rejects(core.rules.remove(id(other), mine.id), /not there/);
  }
  await core.rules.remove(id("mia"), mine.id);
  assert.equal(core.entries.get(mine.id), null);
});

test("the team's entry is for everyone but a guest; its maker and those who run the workspace manage it", async () => {
  const shared = await make("mia", { type: "team" }, "Everyone's");
  assert.deepEqual(await seen("max"), ["Everyone's"]);
  assert.deepEqual(await seen("ada"), ["Everyone's"]);
  assert.deepEqual(await seen("gus"), []);
  // Anyone on the team may change it; only its maker or an admin removes it.
  await core.rules.update(id("max"), shared.id, { data: { title: "Everyone's, edited" } });
  await assert.rejects(core.rules.remove(id("max"), shared.id), /cannot remove/);
  await core.rules.remove(id("ada"), shared.id);
  await assert.rejects(make("gus", { type: "team" }, "Not for a guest"), /cannot add/);
});

test("a project's entries follow the project, and a project made private hides them at once", async () => {
  const site = await project("max", { name: "Website" });
  await make("max", { type: "project", id: site.id }, "Launch by May");
  assert.deepEqual(await seen("mia"), ["Launch by May"]);
  assert.deepEqual(await seen("gus"), []);
  const closed = await call("max", "PATCH", `/v1/projects/${site.id}`, { access: "private" });
  assert.equal(closed.status, 200);
  assert.deepEqual(await seen("mia"), [], "no longer the team's");
  assert.deepEqual(await seen("max"), ["Launch by May"]);
  assert.deepEqual(
    await seen("ada"),
    ["Launch by May"],
    "those who run the workspace see all projects",
  );
  // A viewer looks but does not change.
  await call("max", "PATCH", `/v1/projects/${site.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "viewer" },
    ],
  });
  const goal = (await core.rules.visible(id("mia"), "goal"))[0] as Entry;
  await assert.rejects(core.rules.update(id("mia"), goal.id, { status: "x" }), /cannot change/);
  await assert.rejects(make("mia", { type: "project", id: site.id }, "No"), /cannot add/);
});

test("deleting a project deletes what is kept in it, and those who could see it are told", async () => {
  const site = await project("max", { name: "Website" });
  await make("max", { type: "project", id: site.id }, "Launch by May");
  await make("max", { type: "project", id: site.id }, "Hire", "routine");
  assert.deepEqual(core.rules.countIn({ type: "project", id: site.id }), { goal: 1, routine: 1 });
  published.length = 0;
  const gone = await call("max", "DELETE", `/v1/projects/${site.id}`, { deleteTasks: true });
  assert.equal(gone.status, 200);
  assert.deepEqual(core.entries.allInScope({ type: "project", id: site.id }), []);
  const told = published.filter((e) => e.type === "entry.changed").map((e) => e.userId);
  assert.ok(
    told.includes(id("mia")) && told.includes(id("max")),
    "the team could see an open project",
  );
  assert.ok(!told.includes(id("gus")));
});

test("a channel's entries follow the channel, and go when it is deleted", async () => {
  const quiet = await channel("max", "ops", "private", ["mia"]);
  await make("max", { type: "channel", id: quiet }, "Ops runbook");
  assert.deepEqual(await seen("mia"), ["Ops runbook"]);
  assert.deepEqual(
    await seen("ada"),
    [],
    "a private channel is its members', whoever runs the workspace",
  );
  assert.deepEqual(await seen("gus"), []);
  await assert.rejects(make("ada", { type: "channel", id: quiet }, "Not a member"), /cannot add/);
  const removed = await call("max", "DELETE", `/v1/channels/${quiet}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(core.entries.allInScope({ type: "channel", id: quiet }), []);
});

test("a scope must exist, and moving an entry needs the say over both ends", async () => {
  await assert.rejects(make("max", { type: "project", id: "nope" }, "x"), /not there/);
  await assert.rejects(make("max", { type: "channel", id: "nope" }, "x"), /not there/);
  const site = await project("max", { name: "Website" });
  const goal = await make("max", { type: "project", id: site.id }, "Launch");
  const other = await project("mia", { name: "Mia's" });
  // Max runs one project and not the other.
  await assert.rejects(
    core.rules.update(id("max"), goal.id, { scope: { type: "project", id: other.id } }),
    /cannot move/,
  );
  const moved = await core.rules.update(id("max"), goal.id, { scope: { type: "person" } });
  assert.deepEqual(moved.scope, { type: "person", id: id("max") });
  assert.deepEqual(await seen("mia"), [], "now Max's own");
});

test("people are told of an entry only if they may see it", async () => {
  published.length = 0;
  await make("mia", { type: "person" }, "Private");
  await make("mia", { type: "team" }, "Shared");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const events = published.filter((e) => e.type === "entry.changed");
  const forPrivate = events.slice(0, 1).map((e) => e.userId);
  assert.deepEqual(
    forPrivate,
    [id("mia")],
    "a person's own entry is announced to that person only",
  );
  const forTeam = new Set(events.slice(1).map((e) => e.userId));
  assert.ok(forTeam.has(id("max")) && forTeam.has(id("ada")));
  assert.ok(!forTeam.has(id("gus")));
});
