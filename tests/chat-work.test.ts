import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ChatCore } from "../apps/chat/src/core.ts";
import type { AgentTask, Project } from "../packages/domain/src/agent.ts";
import { chatWorld } from "./helpers/chat-world.ts";

/**
 * The board in the chat service: a project is open (the team sees and works on it), limited (the team sees
 * it, its members work on it) or private (only its members see it), as in Jira. Those who run the
 * workspace see all of them. These are the rules the machine used to keep, kept where the people are.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  gus: { id: "acct_gus", email: "Gus@Example.com", name: "Gus", role: "guest" },
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

const json = <T>(response: Response) => response.json() as Promise<T>;
const make = async (who: Who, body: object) => {
  const response = await call(who, "POST", "/v1/projects", body);
  assert.equal(response.status, 201, await response.clone().text());
  return json<Project>(response);
};
const projectsOf = async (who: Who) =>
  (await json<{ projects: Project[] }>(await call(who, "GET", "/v1/work"))).projects;
const tasksOf = async (who: Who) =>
  (await json<{ tasks: AgentTask[] }>(await call(who, "GET", "/v1/work"))).tasks;
const manual = (project: Project, title: string) => ({
  title,
  kind: "manual",
  projectId: project.id,
  input: {},
});
const add = async (who: Who, body: object, status = 201) => {
  const response = await call(who, "POST", "/v1/tasks", body);
  assert.equal(response.status, status, await response.clone().text());
  return json<AgentTask>(response);
};

test("a project is open unless it says otherwise, and whoever makes it runs it", async () => {
  const open = await make("max", { name: "Website" });
  assert.equal(open.access, "open");
  assert.deepEqual(open.members, [{ email: "max@example.com", role: "admin" }]);
  assert.deepEqual(open.you, { role: "admin", canWork: true, canManage: true });
  const seen = (await projectsOf("mia")).find((p) => p.id === open.id);
  assert.deepEqual(seen?.you, { role: null, canWork: true, canManage: false });
  assert.equal(
    (await call("mia", "POST", "/v1/tasks", manual(open, "Fix the footer"))).status,
    201,
  );
  // A guest is only ever in what they are named in.
  assert.equal(
    (await projectsOf("gus")).some((p) => p.id === open.id),
    false,
  );
});

test("a limited project is seen by the team and worked on by its members", async () => {
  const limited = await make("max", { name: "Launch plan", access: "limited" });
  assert.ok((await projectsOf("mia")).some((p) => p.id === limited.id));
  assert.equal(
    (await call("mia", "POST", "/v1/tasks", manual(limited, "Add a slide"))).status,
    403,
  );
  const added = await call("max", "PATCH", `/v1/projects/${limited.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "MIA@example.com", role: "member" },
    ],
  });
  assert.equal(added.status, 200);
  assert.equal(
    (await call("mia", "POST", "/v1/tasks", manual(limited, "Add a slide"))).status,
    201,
  );
});

test("a private project and its tasks are its members' alone, and those who run the workspace see them", async () => {
  const secret = await make("max", { name: "Reorg", access: "private" });
  const task = await add("max", manual(secret, "Draft the memo"));
  assert.equal(
    (await projectsOf("mia")).some((p) => p.id === secret.id),
    false,
  );
  assert.equal(
    (await tasksOf("mia")).some((t) => t.id === task.id),
    false,
  );
  assert.equal((await call("mia", "GET", `/v1/tasks/${task.id}`)).status, 404);
  assert.equal((await call("mia", "POST", "/v1/tasks", manual(secret, "Sneak in"))).status, 404);
  assert.equal(
    (await call("mia", "PATCH", `/v1/projects/${secret.id}`, { name: "x" })).status,
    404,
  );
  for (const who of ["olive", "ada"] as const) {
    assert.ok(
      (await projectsOf(who)).some((p) => p.id === secret.id),
      who,
    );
    assert.ok(
      (await tasksOf(who)).some((t) => t.id === task.id),
      who,
    );
  }
  // A viewer sees it and cannot change what is in it.
  await call("max", "PATCH", `/v1/projects/${secret.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "viewer" },
    ],
  });
  assert.ok((await tasksOf("mia")).some((t) => t.id === task.id));
  assert.equal((await call("mia", "GET", `/v1/tasks/${task.id}`)).status, 200);
  assert.equal(
    (await call("mia", "PATCH", `/v1/tasks/${task.id}`, { priority: "high" })).status,
    403,
  );
  assert.equal((await call("mia", "DELETE", `/v1/tasks/${task.id}`)).status, 403);
  assert.equal((await call("mia", "POST", "/v1/tasks", manual(secret, "More"))).status, 403);
});

test("only a project's admins change who is in it, and it always keeps one", async () => {
  const project = await make("max", { name: "Hiring", access: "limited" });
  const mia = { email: "mia@example.com", role: "member" };
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [{ email: "max@example.com", role: "admin" }, mia],
  });
  assert.equal(
    (await call("mia", "PATCH", `/v1/projects/${project.id}`, { access: "open" })).status,
    403,
  );
  assert.equal((await call("mia", "DELETE", `/v1/projects/${project.id}`)).status, 403);
  assert.equal(
    (await call("max", "PATCH", `/v1/projects/${project.id}`, { members: [mia] })).status,
    422,
  );
  assert.equal(
    (await call("olive", "PATCH", `/v1/projects/${project.id}`, { access: "private" })).status,
    200,
  );
  assert.equal((await call("max", "DELETE", `/v1/projects/${project.id}`)).status, 200);
});

test("a guest sees a project only when named in it, and a task cannot be moved where its person may not work", async () => {
  const project = await make("max", { name: "Client work", access: "private" });
  assert.equal(
    (await projectsOf("gus")).some((p) => p.id === project.id),
    false,
  );
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "gus@example.com", role: "viewer" },
    ],
  });
  assert.ok((await projectsOf("gus")).some((p) => p.id === project.id));
  const loose = await add("mia", { title: "Loose", kind: "manual", input: {} });
  const moved = await call("mia", "PATCH", `/v1/tasks/${loose.id}`, { projectId: project.id });
  assert.equal(moved.status, 404);
});

test("the people a project can name are the workspace's, and a guest is not told who they are", async () => {
  const named = await json<{ email: string; role: string }[]>(
    await call("max", "GET", "/v1/projects/people"),
  );
  assert.ok(named.some((person) => person.email === "mia@example.com" && person.role === "member"));
  assert.equal((await call("gus", "GET", "/v1/projects/people")).status, 403);
});

test("every task is in a project: work that names none is in General, which everyone may use and no one may take away", async () => {
  const task = await add("mia", { title: "Loose", kind: "manual", input: {} });
  assert.equal(task.projectId, "general");
  const project = await make("max", { name: "Audit", access: "private" });
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "viewer" },
    ],
  });
  await add("mia", { title: "Mine", kind: "manual", input: {} });
  const out = await call("mia", "PATCH", `/v1/tasks/${task.id}`, { projectId: null });
  assert.ok(out.status >= 400 && out.status < 500);
  assert.equal((await call("olive", "DELETE", "/v1/projects/general")).status, 422);
  assert.equal(
    (await call("olive", "PATCH", "/v1/projects/general", { access: "private" })).status,
    422,
  );
  const doomed = await make("max", { name: "Short lived" });
  const inside = await add("max", manual(doomed, "Goes to General"));
  assert.equal((await call("max", "DELETE", `/v1/projects/${doomed.id}`)).status, 200);
  assert.equal((await tasksOf("max")).find((t) => t.id === inside.id)?.projectId, "general");
});

test("deleting a project moves its tasks to a project of the person's choosing, or deletes them with it", async () => {
  const from = await make("max", { name: "Old site" });
  const to = await make("max", { name: "New site" });
  const moved = await add("max", manual(from, "Carry over"));
  const result = await call("max", "DELETE", `/v1/projects/${from.id}`, { moveTo: to.id });
  assert.deepEqual(await json(result), { deleted: from.id, moved: 1, removed: 0 });
  assert.equal((await tasksOf("max")).find((t) => t.id === moved.id)?.projectId, to.id);

  const keep = await make("max", { name: "Keep" });
  const closed = await make("mia", { name: "Mia's own", access: "private" });
  await add("max", manual(keep, "Stays"));
  for (const [body, status] of [
    [{ moveTo: keep.id }, 422],
    [{ moveTo: closed.id }, 404],
    [{ moveTo: "general", deleteTasks: true }, 422],
  ] as const) {
    const refused = await call("max", "DELETE", `/v1/projects/${keep.id}`, body);
    assert.equal(refused.status, status, JSON.stringify(body));
  }
  assert.ok((await projectsOf("max")).some((p) => p.id === keep.id));

  const gone = await add("max", manual(keep, "Goes too"));
  const removed = await call("max", "DELETE", `/v1/projects/${keep.id}`, { deleteTasks: true });
  assert.deepEqual(await json(removed), { deleted: keep.id, moved: 0, removed: 2 });
  assert.equal(
    (await tasksOf("max")).some((t) => t.id === gone.id),
    false,
  );
  const plain = await make("max", { name: "Plain" });
  const kept = await add("max", manual(plain, "Kept"));
  await call("max", "DELETE", `/v1/projects/${plain.id}`);
  assert.equal((await tasksOf("max")).find((t) => t.id === kept.id)?.projectId, "general");
});

test("a guest makes only manual work, in a project they were named in, and sees no goals", async () => {
  const none = await call("gus", "POST", "/v1/tasks", { title: "x", kind: "manual", input: {} });
  assert.equal(none.status, 403);
  const project = await make("max", { name: "Shared with Gus", access: "limited" });
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "gus@example.com", role: "member" },
    ],
  });
  await add("gus", manual(project, "Gus's task"));
  const goal = await call("gus", "POST", "/v1/tasks", {
    ...manual(project, "g"),
    goalId: "goal-1",
  });
  assert.equal(goal.status, 404);
});

test("what a task depends on must be seen by the person, and cannot loop", async () => {
  const secret = await make("max", { name: "Secret", access: "private" });
  const hidden = await add("max", manual(secret, "Hidden"));
  const a = await add("mia", { title: "A", kind: "manual", input: {} });
  // Naming a task they cannot see is the same as naming one that is not there.
  const peek = await call("mia", "PATCH", `/v1/tasks/${a.id}`, { blockedBy: [hidden.id] });
  assert.equal(peek.status, 404);
  const b = await add("mia", { title: "B", kind: "manual", input: {}, blockedBy: [a.id] });
  assert.equal(
    (await call("mia", "PATCH", `/v1/tasks/${a.id}`, { blockedBy: [b.id] })).status,
    422,
  );
  assert.equal(
    (await call("mia", "PATCH", `/v1/tasks/${a.id}`, { blockedBy: [a.id] })).status,
    422,
  );
  // A task that is deleted is no longer waited for.
  await call("mia", "DELETE", `/v1/tasks/${a.id}`);
  assert.deepEqual((await tasksOf("mia")).find((t) => t.id === b.id)?.blockedBy, []);
});

test("asking twice for the same thing makes it once, and a person has only so many open tasks", async () => {
  const input = { prompt: "Summarise the week", kind: "agent", input: {} };
  const first = await core.work.createTask(people.max.id, input, { key: "k1" });
  const again = await core.work.createTask(people.max.id, input, { key: "k1" });
  assert.equal(first.id, again.id);
  assert.equal((await tasksOf("max")).filter((t) => t.title.startsWith("Summarise")).length, 1);
  for (let i = 0; i < 99; i++) await add("max", { title: `t${i}`, kind: "manual", input: {} });
  const over = await call("max", "POST", "/v1/tasks", {
    title: "one more",
    kind: "manual",
    input: {},
  });
  assert.equal(over.status, 409);
});

test("an agent task needs words to go on, and starts waiting for the agent", async () => {
  assert.equal(
    (await call("mia", "POST", "/v1/tasks", { kind: "agent", title: "x", input: {} })).status,
    422,
  );
  const task = await add("mia", { kind: "agent", prompt: "Find three venues", input: {} });
  assert.equal(task.status, "queued");
  assert.equal(task.title, "Find three venues");
  assert.equal(core.tasks.nextDue()?.id, task.id);
});

test("the agent's work is paused, resumed and stopped, and only a person marks it done", async () => {
  const task = await add("mia", { kind: "agent", prompt: "Do it", input: {} });
  const control = (action: string) =>
    call("mia", "POST", `/v1/tasks/${task.id}/control`, { action });
  assert.equal((await json<AgentTask>(await control("pause"))).status, "paused");
  assert.equal((await control("pause")).status, 200);
  assert.equal((await json<AgentTask>(await control("resume"))).status, "queued");
  assert.equal((await control("retry")).status, 409);
  const done = await call("mia", "PATCH", `/v1/tasks/${task.id}`, { status: "succeeded" });
  assert.equal(done.status, 422);
  assert.equal((await json<AgentTask>(await control("cancel"))).status, "cancelled");
  assert.equal((await control("resume")).status, 409);
  // The agent, as a tool, may never mark work done either.
  await assert.rejects(
    core.work.updateTask(people.mia.id, task.id, { status: "succeeded" }, "agent"),
    /Only a person can mark/,
  );
});

test("a task handed to the agent is given out, and handed back it waits for a person", async () => {
  const task = await add("mia", { title: "Plan", kind: "manual", input: {} });
  const handed = await json<AgentTask>(
    await call("mia", "PATCH", `/v1/tasks/${task.id}`, { assignee: "agent" }),
  );
  assert.equal(handed.kind, "agent");
  assert.equal(core.tasks.nextDue()?.id, task.id);
  const back = await json<AgentTask>(
    await call("mia", "PATCH", `/v1/tasks/${task.id}`, { assignee: null }),
  );
  assert.equal(back.kind, "manual");
  assert.equal(back.status, "cancelled");
  assert.equal(core.tasks.nextDue(), null);
});

test("notes are the team's running instructions: kept, answered, taken back before they are read", async () => {
  const task = await add("mia", { kind: "agent", prompt: "Draft", input: {} });
  const note = await json<AgentTask>(
    await call("mia", "POST", `/v1/tasks/${task.id}/notes`, { text: "Keep it short" }),
  );
  assert.equal(note.notes?.length, 1);
  assert.equal(note.notes?.[0]?.mine, true);
  assert.equal(note.notes?.[0]?.createdByName, "Mia");
  const id = note.notes?.[0]?.id as string;
  // Someone else cannot take it back.
  assert.equal((await call("max", "DELETE", `/v1/tasks/${task.id}/notes/${id}`)).status, 403);
  const gone = await json<AgentTask>(
    await call("mia", "DELETE", `/v1/tasks/${task.id}/notes/${id}`),
  );
  assert.equal(gone.notes?.length, 0);
  // A task waiting for input is answered, and goes back to be worked.
  core.tasks.change(task.id, { status: "waiting_input", question: "Which venue?" } as never);
  const answered = await json<AgentTask>(
    await call("max", "POST", `/v1/tasks/${task.id}/input`, { answer: "The first" }),
  );
  assert.equal(answered.status, "queued");
  assert.equal(answered.notes?.[0]?.kind, "answer");
  assert.equal(answered.question, undefined);
  assert.equal(
    (await call("max", "POST", `/v1/tasks/${task.id}/input`, { answer: "again" })).status,
    409,
  );
});

test("only those who may see a task are told it changed", async () => {
  const secret = await make("max", { name: "Quiet", access: "private" });
  const before = published.length;
  const task = await add("max", manual(secret, "Hush"));
  await new Promise((r) => setTimeout(r, 10));
  const told = published
    .slice(before)
    .filter((e) => e.type === "task.changed")
    .map((e) => e.userId)
    .sort();
  // Max (a member of the project), the owner and the admin: not Mia, not the guest.
  assert.deepEqual(told, [people.ada.id, people.max.id, people.olive.id].sort());
  assert.ok(task.id);
});

test("a guest keeps the board of their project but does not start, steer or answer the agent", async () => {
  const project = await make("max", { name: "With Gus", access: "limited" });
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "gus@example.com", role: "member" },
    ],
  });
  // An agent task is not theirs to start.
  const agent = { kind: "agent", prompt: "Do it", projectId: project.id, input: {} };
  assert.equal((await call("gus", "POST", "/v1/tasks", agent)).status, 403);
  const own = await add("gus", manual(project, "Gus's own"));
  const theirs = await add("max", { ...agent, title: "Max's agent task" });
  const refused = [
    call("gus", "PATCH", `/v1/tasks/${own.id}`, { assignee: "agent" }),
    call("gus", "PATCH", `/v1/tasks/${theirs.id}`, { priority: "high" }),
    call("gus", "DELETE", `/v1/tasks/${theirs.id}`),
    call("gus", "POST", `/v1/tasks/${own.id}/control`, { action: "pause" }),
    call("gus", "POST", `/v1/tasks/${own.id}/notes`, { text: "hi" }),
    call("gus", "POST", `/v1/tasks/${theirs.id}/input`, { answer: "yes" }),
  ];
  for (const response of await Promise.all(refused)) assert.equal((await response).status, 403);
  // Their own item they keep, and they can look at the agent's.
  assert.equal(
    (await call("gus", "PATCH", `/v1/tasks/${own.id}`, { priority: "high" })).status,
    200,
  );
  assert.equal((await call("gus", "GET", `/v1/tasks/${theirs.id}`)).status, 200);
  assert.equal((await call("gus", "DELETE", `/v1/tasks/${own.id}`)).status, 200);
});

test("a task is given to a person who can work in its project, and not to the agent as well", async () => {
  const project = await make("max", { name: "Launch", access: "private" });
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "member" },
    ],
  });
  const task = await add("max", manual(project, "Write copy"));
  const give = (email: string | null) =>
    call("max", "PATCH", `/v1/tasks/${task.id}`, { assigneeEmail: email });
  const mia = await json<AgentTask>(await give("Mia@Example.com"));
  assert.equal(mia.assigneeEmail, "mia@example.com");
  // Each person is told whether it is theirs, and by what name.
  const seenBy = async (who: Who) => (await tasksOf(who)).find((t) => t.id === task.id);
  assert.equal((await seenBy("mia"))?.assignedToMe, true);
  assert.equal((await seenBy("max"))?.assignedToMe, false);
  assert.equal((await seenBy("max"))?.assigneeName, "Mia");
  // Those who run the workspace can work anywhere; a stranger, and a guest not named in it, cannot hold it.
  assert.equal((await give("olive@example.com")).status, 200);
  assert.equal((await give("nobody@example.com")).status, 422);
  assert.equal((await give("gus@example.com")).status, 422);
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "viewer" },
    ],
  });
  assert.equal((await give("mia@example.com")).status, 422);
  await call("max", "PATCH", `/v1/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "member" },
    ],
  });
  // Handing it to the agent lets go of the person; and it cannot go back to one while the agent has it.
  await give("mia@example.com");
  const agent = await json<AgentTask>(
    await call("max", "PATCH", `/v1/tasks/${task.id}`, { assignee: "agent" }),
  );
  assert.ok(!agent.assigneeEmail);
  assert.equal((await give("mia@example.com")).status, 422);
  // A guest cannot give work out.
  assert.equal(
    (await call("gus", "PATCH", `/v1/tasks/${task.id}`, { assigneeEmail: null })).status >= 400,
    true,
  );
});

test("a task leaves its person when it moves to a project they cannot work in", async () => {
  const closed = await make("max", { name: "Closed", access: "private" });
  const task = await add("mia", { title: "Loose", kind: "manual", input: {} });
  await call("mia", "PATCH", `/v1/tasks/${task.id}`, { assigneeEmail: "mia@example.com" });
  await call("max", "PATCH", `/v1/projects/${closed.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "member" },
    ],
  });
  const kept = await json<AgentTask>(
    await call("mia", "PATCH", `/v1/tasks/${task.id}`, { projectId: closed.id }),
  );
  assert.equal(kept.assigneeEmail, "mia@example.com");
  // Back in General, Mia is still on the team, so the task stays hers.
  const back = await json<AgentTask>(
    await call("mia", "PATCH", `/v1/tasks/${task.id}`, { projectId: "general" }),
  );
  assert.equal(back.assigneeEmail, "mia@example.com");
  // Moved to a private project she is not in, it cannot go with her. Max (a member) moves it there.
  const other = await make("max", { name: "Other", access: "private" });
  const away = await json<AgentTask>(
    await call("max", "PATCH", `/v1/tasks/${task.id}`, { projectId: other.id }),
  );
  assert.ok(!away.assigneeEmail);
});
