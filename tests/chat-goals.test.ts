import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ChatCore } from "../apps/chat/src/core.ts";
import type { AgentTask, Goal, Project } from "../packages/domain/src/agent.ts";
import { chatWorld } from "./helpers/chat-world.ts";

/**
 * Goals are the room's, each with a scope: a person's own, a project's, a channel's, or the team's. Who sees one
 * follows from the scope, a task can only point at a goal its person may see, and a finished task counts as a
 * milestone of the goal it points at.
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

beforeEach(async () => {
  const world = await chatWorld(people);
  call = world.call;
  core = world.core;
});

const id = (who: Who) => people[who].id;
const json = <T>(response: Response) => response.json() as Promise<T>;
const titles = async (who: Who) => (await core.goals.list(id(who))).map((g) => g.title).sort();
const goal = (who: Who, title: string, scope?: Goal["scope"], home = {}) =>
  core.goals.create(
    id(who),
    { title, milestones: ["First step"], ...(scope ? { scope } : {}) },
    home,
  );
const project = async (who: Who, body: object) =>
  json<Project>(await call(who, "POST", "/v1/projects", body));

test("where a goal is made says whose it is, unless the maker says", async () => {
  const quiet = json<{ id: string }>(
    await call("max", "POST", "/v1/channels", { name: "ops", visibility: "private" }),
  );
  const loud = await json<{ id: string }>(
    await call("max", "POST", "/v1/channels", { name: "town-hall", visibility: "public" }),
  );
  const ops = (await quiet).id;
  assert.deepEqual(
    (await goal("max", "From the town hall", undefined, { channelId: loud.id })).scope,
    {
      type: "team",
    },
  );
  assert.deepEqual((await goal("max", "From ops", undefined, { channelId: ops })).scope, {
    type: "channel",
    id: ops,
  });
  assert.deepEqual((await goal("max", "From their own chat")).scope, {
    type: "person",
    id: id("max"),
  });
  assert.deepEqual((await goal("max", "Said so", { type: "team" }, { channelId: ops })).scope, {
    type: "team",
  });
  assert.deepEqual(await titles("mia"), ["From the town hall", "Said so"]);
  assert.deepEqual(await titles("max"), [
    "From ops",
    "From the town hall",
    "From their own chat",
    "Said so",
  ]);
});

test("a person's own goal is theirs alone, even against an admin; a project's follows the project", async () => {
  await goal("mia", "Mia's own", { type: "person" });
  const site = await project("max", { name: "Website", access: "private" });
  await goal("max", "Launch", { type: "project", id: site.id });
  assert.deepEqual(await titles("mia"), ["Mia's own"]);
  assert.deepEqual(
    await titles("ada"),
    ["Launch"],
    "an admin sees every project, and no one's own",
  );
  assert.deepEqual(await titles("olive"), ["Launch"]);
  assert.deepEqual(await titles("gus"), []);
});

test("a goal's milestones and status are changed by those who may work in its scope; pausing pauses its tasks", async () => {
  const mine = await goal("max", "Launch", { type: "team" });
  const made = await core.work.createTask(id("max"), {
    kind: "manual",
    title: "Write the post",
    goalId: mine.id,
    input: {},
  });
  const saved = await core.goals.update(id("mia"), mine.id, {
    milestones: mine.milestones.map((m) => ({ ...m, done: true })),
  });
  assert.equal(saved.milestones[0]?.done, true);
  await assert.rejects(core.goals.update(id("gus"), mine.id, { status: "paused" }), /not there/);
  const paused = await core.goals.update(id("max"), mine.id, { status: "paused" });
  assert.equal(paused.status, "paused");
  const task = (await core.work.tasksFor(id("max"))).find((t) => t.id === made.id) as AgentTask;
  assert.equal(task.status, "paused");
  await core.goals.remove(id("max"), mine.id);
  assert.deepEqual(await titles("max"), []);
});

test("a task can only point at a goal its person may see, and a finished one counts, once", async () => {
  const hidden = await goal("mia", "Mia's own", { type: "person" });
  await assert.rejects(
    core.work.createTask(id("max"), {
      kind: "manual",
      title: "Sneak",
      goalId: hidden.id,
      input: {},
    }),
    /not there/,
  );
  const shared = await goal("mia", "Shared", { type: "team" });
  const made = await core.work.createTask(id("max"), {
    kind: "manual",
    title: "Do it",
    goalId: shared.id,
    input: {},
  });
  await core.work.updateTask(id("max"), made.id, { status: "succeeded" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const counted = (await core.goals.list(id("mia"))).find((g) => g.id === shared.id);
  assert.deepEqual(
    counted?.milestones.map((m) => [m.title, m.done]),
    [
      ["First step", false],
      ["Do it", true],
    ],
  );
  await core.goals.countTask(core.tasks.get(made.id) as AgentTask);
  assert.equal(
    (await core.goals.list(id("mia"))).find((g) => g.id === shared.id)?.milestones.length,
    2,
  );
});

test("asked again with the same id, a goal is the same goal; the app makes and changes goals by its routes", async () => {
  const first = await goal("max", "Once", { type: "team" }, { id: "goal:abc" });
  const again = await goal("max", "Once", { type: "team" }, { id: "goal:abc" });
  assert.equal(again.id, first.id);
  assert.equal((await core.goals.list(id("max"))).length, 1);
  const made = await call("mia", "POST", "/v1/goals", {
    title: "From the app",
    scope: { type: "person" },
  });
  assert.equal(made.status, 201);
  const mine = await json<Goal>(made);
  const done = await call("mia", "POST", `/v1/goals/${mine.id}`, { status: "completed" });
  assert.equal((await json<Goal>(done)).status, "completed");
  const work = await json<{ goals: Goal[] }>(await call("mia", "GET", "/v1/work"));
  assert.ok(work.goals.some((g) => g.id === mine.id));
  const other = await json<{ goals: Goal[] }>(await call("max", "GET", "/v1/work"));
  assert.ok(!other.goals.some((g) => g.id === mine.id));
  assert.equal((await call("max", "DELETE", `/v1/goals/${mine.id}`)).status, 404);
});
