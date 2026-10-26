import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { conversationTools } from "../apps/server/src/engine/tools.ts";
import type {
  AgentMemory,
  AgentTask,
  Channel,
  ChannelThread,
  ChannelView,
} from "../packages/domain/src/agent.ts";
import { managedWorkspace } from "./helpers/managed.ts";

/**
 * Channels and the people in them: a channel is public (the team
 * finds it and joins it) or private (found only by the people in it), its managers look after who
 * is in it, and a guest has only the channels that name them. Owner and admin run the workspace.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let world: Awaited<ReturnType<typeof managedWorkspace<typeof people>>>;
before(async () => {
  world = await managedWorkspace(people, "wpeople");
});
after(async () => {
  await world.close();
});

const call = (who: Who, method: string, path: string, body?: unknown) =>
  world.call(who, method, path, body);
const json = (response: Response) => response.json();
const members = (id: string) => `/api/agent/channels/${id}/members`;
const channelsOf = async (who: Who) =>
  (await json(await call(who, "GET", "/api/agent/channels"))) as ChannelView[];
const namesOf = async (who: Who) =>
  (await channelsOf(who))
    .filter((c) => c.id !== "orchestrator")
    .map((c) => c.name)
    .sort();
const make = async (who: Who, name: string, visibility?: "public" | "private") => {
  const response = await call(who, "POST", "/api/agent/channels", { name, visibility });
  assert.equal(response.status, 201, name);
  return (await json(response)) as Channel;
};
const add = (who: Who, id: string, ...emails: string[]) =>
  call(who, "POST", members(id), { add: emails });
const remove = (who: Who, id: string, ...emails: string[]) =>
  call(who, "POST", members(id), { remove: emails });
const stored = (id: string) => world.db.get<Channel>("shared", "channels", id);

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
  assert.equal((await call("mia", "GET", `/api/agent/channels/${design.id}/tasks`)).status, 200);
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
  await world.db.put("shared", "channels", {
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

/**
 * A private channel with a conversation in it, and a piece of work in a private project of its own: who sees
 * the work is the project's say, and not the channel's.
 */
async function finance() {
  const channel = await make("max", "Finance", "private");
  const project = (await json(
    await call("max", "POST", "/api/agent/projects", { name: "Finance", access: "private" }),
  )) as { id: string };
  const thread = (await world.server.agent.registerThread(
    world.owner("max"),
    channel.id,
    "Budget",
  )) as ChannelThread;
  const task = (await world.server.agent.createTask(world.owner("max"), {
    prompt: "Check the payroll run",
    channelId: channel.id,
    projectId: project.id,
  })) as AgentTask;
  return { channel, thread, task };
}
const secret: { channel?: Channel; thread?: ChannelThread; task?: AgentTask } = {};
async function privateWorld() {
  if (!secret.channel) Object.assign(secret, await finance());
  return secret as { channel: Channel; thread: ChannelThread; task: AgentTask };
}

test("a private channel is found only by the people in it, whoever else is asking", async () => {
  const { channel, thread, task } = await privateWorld();
  assert.deepEqual(
    [channel.visibility, channel.everyone, channel.members],
    ["private", false, ["max@example.com"]],
  );
  // It is in no one else's list: not the team's, not the admin's, not the owner's, not a guest's.
  assert.ok((await namesOf("max")).includes("Finance"));
  for (const who of ["mia", "ada", "olive", "gus"] as const)
    assert.ok(!(await namesOf(who)).includes("Finance"), who);
  // And nothing that names it, or its conversation, or its work, gets through: it is not there.
  const hidden: [string, string, unknown?][] = [
    ["GET", members(channel.id)],
    ["POST", members(channel.id), { add: ["mia@example.com"] }],
    ["POST", `/api/agent/channels/${channel.id}/managers`, { add: ["mia@example.com"] }],
    ["PATCH", `/api/agent/channels/${channel.id}`, { visibility: "public" }],
    ["POST", `/api/agent/channels/${channel.id}/archive`, {}],
    ["GET", `/api/agent/channels/${channel.id}/files`],
    ["GET", `/api/agent/channels/${channel.id}/files/info?path=a`],
    ["GET", `/api/agent/channels/${channel.id}/tasks`],
    ["GET", `/api/agent/channels/${channel.id}/threads`],
    ["POST", `/api/agent/channels/${channel.id}/threads`, { name: "Sneaky" }],
    ["GET", `/api/agent/threads/${thread.threadId}/channel`],
    ["GET", `/api/agent/threads/${thread.threadId}/tasks`],
    ["PATCH", `/api/agent/threads/${thread.threadId}`, { name: "Mine now" }],
    ["GET", `/api/conversation?threadId=channel:${channel.id}`],
    ["GET", `/api/conversation?threadId=${thread.threadId}`],
    ["PUT", `/api/conversation?threadId=${thread.threadId}`, { messages: [] }],
    ["POST", "/api/agent/tasks", { title: "x", kind: "manual", channelId: channel.id }],
    ["POST", "/api/agent/threads/bind", { threadId: "t-new", channelId: channel.id }],
    ["GET", `/api/agent/opencode/live?threadId=${thread.threadId}`],
    ["POST", "/api/agent/opencode/stop", { threadId: thread.threadId }],
    ["POST", "/api/agent/opencode/start", { threadId: thread.threadId }],
    ["POST", "/api/agent/opencode/queue", { threadId: thread.threadId, message: { id: "m" } }],
    ["POST", "/api/agent/opencode/run", { threadId: thread.threadId, runId: "r", messages: [] }],
    ["POST", "/api/copilotkit/agent/default/run", { threadId: thread.threadId }],
    ["POST", "/api/copilotkit/agent/default/connect", { threadId: thread.threadId }],
    ["POST", `/api/copilotkit/agent/default/stop/${thread.threadId}`, {}],
    ["GET", `/api/agent/opencode/threads/${thread.threadId}/permissions/pending`],
    ["GET", `/api/agent/opencode/threads/${thread.threadId}/questions/pending`],
    ["GET", `/api/agent/opencode/threads/${thread.threadId}/permissions/rules`],
    ["GET", `/api/agent/opencode/threads/${thread.threadId}/permissions/mode`],
    ["PUT", `/api/agent/opencode/threads/${thread.threadId}/permissions/mode`, { mode: "auto" }],
    ["GET", `/api/agent/opencode/channels/${channel.id}/permissions`],
    ["PUT", `/api/agent/opencode/channels/${channel.id}/permissions/mode`, { mode: "auto" }],
  ];
  for (const who of ["mia", "ada", "olive"] as const)
    for (const [method, path, body] of hidden) {
      const response = await call(who, method, path, body);
      assert.ok(
        [404, 403].includes(response.status),
        `${who} ${method} ${path} ${response.status}`,
      );
      if (response.status === 404 && !path.includes("/tasks/")) {
        const error = (await json(response)).error as string;
        assert.match(error, /not found/i, `${who} ${method} ${path}: ${error}`);
      }
    }
  // Its work is the project's: those who may not see the project are told there is no such task, and the
  // owner and admins, who see every project, are not.
  const ofTask: [string, string, unknown?][] = [
    ["GET", `/api/agent/tasks/${task.id}`],
    ["PATCH", `/api/agent/tasks/${task.id}`, { title: "Different" }],
    ["DELETE", `/api/agent/tasks/${task.id}`],
    ["POST", `/api/agent/tasks/${task.id}/notes`, { text: "hello" }],
    ["POST", `/api/agent/tasks/${task.id}/control`, { action: "pause" }],
    ["POST", `/api/agent/tasks/${task.id}/input`, { answer: "yes" }],
    ["POST", `/api/agent/tasks/${task.id}/accept`, {}],
    ["POST", `/api/agent/tasks/${task.id}/delegate`, { target: "orchestrator" }],
  ];
  for (const [method, path, body] of ofTask)
    assert.equal((await call("mia", method, path, body)).status, 404, `mia ${method} ${path}`);
  assert.equal((await call("ada", "GET", `/api/agent/tasks/${task.id}`)).status, 200);
  assert.equal((await call("olive", "GET", `/api/agent/tasks/${task.id}`)).status, 200);
  // The people in it use all of it.
  for (const path of ["tasks", "threads", "files", "members"])
    assert.equal(
      (await call("max", "GET", `/api/agent/channels/${channel.id}/${path}`)).status,
      200,
    );
  assert.equal((await call("max", "GET", `/api/agent/tasks/${task.id}`)).status, 200);
  assert.equal(
    (await call("max", "GET", `/api/conversation?threadId=${thread.threadId}`)).status,
    200,
  );
  assert.equal(
    (await call("max", "GET", `/api/agent/opencode/threads/${thread.threadId}/permissions/pending`))
      .status,
    200,
  );
  assert.equal(
    (await call("max", "GET", `/api/agent/opencode/threads/${thread.threadId}/questions/pending`))
      .status,
    200,
  );
});

test("the work in a private project, and the notices of it, are shown to its people and to those who run the workspace", async () => {
  const { channel, task } = await privateWorld();
  await world.server.agent.notify(world.owner("max"), "Payroll is ready", "Look it over", task.id);
  await world.db.put("shared", "memories", {
    id: "mem-finance",
    text: "Payroll runs on the 25th",
    source: "chat",
    createdAt: new Date().toISOString(),
    channelId: channel.id,
  } satisfies AgentMemory);
  await world.db.put("shared", "memories", {
    id: "mem-team",
    text: "Standup is at ten",
    source: "chat",
    createdAt: new Date().toISOString(),
  } satisfies AgentMemory);
  const seen = async (who: Who) =>
    (await json(await call(who, "GET", "/api/agent"))) as {
      tasks: AgentTask[];
      notifications: { taskId?: string }[];
      memories: AgentMemory[];
    };
  const mine = await seen("max");
  assert.ok(mine.tasks.some((t) => t.id === task.id));
  assert.ok(mine.notifications.some((n) => n.taskId === task.id));
  assert.deepEqual(mine.memories.map((m) => m.id).sort(), ["mem-finance", "mem-team"]);
  // What the agent learned in the channel is the channel's; the work is the project's.
  for (const who of ["mia", "ada", "olive"] as const) {
    const theirs = await seen(who);
    assert.deepEqual(
      theirs.memories.map((m) => m.id),
      ["mem-team"],
      who,
    );
  }
  const mia = await seen("mia");
  assert.ok(!mia.tasks.some((t) => t.id === task.id));
  assert.ok(!mia.notifications.some((n) => n.taskId === task.id));
  for (const who of ["ada", "olive"] as const)
    assert.ok(
      (await seen(who)).tasks.some((t) => t.id === task.id),
      who,
    );
  const notifications = (await json(await call("mia", "GET", "/api/agent/notifications"))) as {
    taskId?: string;
  }[];
  assert.ok(!notifications.some((n) => n.taskId === task.id));
  // The agent working for someone outside the channel does not reach into it either.
  const tools = (who: Who) =>
    conversationTools(
      world.server.agent,
      world.owner(who),
      {
        threadId: "elsewhere",
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      { signal: new AbortController().signal, requestKey: "r" },
    );
  const run = (who: Who, name: string, args: Record<string, unknown>) => {
    const tool = tools(who).find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    return (tool.execute as (args: unknown) => Promise<unknown>)(args);
  };
  await assert.rejects(run("mia", "update_task", { taskId: task.id, title: "Mine" }), /not found/i);
  await assert.rejects(run("mia", "delete_task", { taskId: task.id }), /not found/i);
  const status = (await run("mia", "agent_status", {})) as { tasks: AgentTask[] };
  assert.ok(!status.tasks.some((t) => t.id === task.id));
  assert.equal(
    ((await run("max", "update_task", { taskId: task.id, title: "Payroll" })) as AgentTask).title,
    "Payroll",
  );
});

test("the reviews and receipts of a private channel's work, and clearing notices, are for the people in it", async () => {
  const { task } = await privateWorld();
  const now = new Date().toISOString();
  await world.db.put("shared", "actions", {
    id: "act-finance",
    title: "Send the payroll summary",
    kind: "email",
    data: {},
    status: "awaiting_review",
    hash: "h",
    createdAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    taskId: task.id,
  });
  await world.db.put("shared", "actions", {
    id: "act-team",
    title: "Send the standup notes",
    kind: "email",
    data: {},
    status: "awaiting_review",
    hash: "h2",
    createdAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await world.db.put("shared", "activity", {
    id: "rec-finance",
    title: "Sent the payroll summary",
    detail: "",
    date: now,
    status: "succeeded",
    actionId: "act-finance",
  });
  const seen = async (who: Who) =>
    (await json(await call(who, "GET", "/api/workspace"))) as {
      actions: { id: string }[];
      activity: { id: string }[];
    };
  const mine = await seen("max");
  assert.deepEqual(mine.actions.map((a) => a.id).sort(), ["act-finance", "act-team"]);
  assert.deepEqual(
    mine.activity.map((a) => a.id),
    ["rec-finance"],
  );
  const theirs = await seen("mia");
  assert.deepEqual(
    theirs.actions.map((a) => a.id),
    ["act-team"],
  );
  assert.deepEqual(theirs.activity, []);
  // Someone who clears their notices does not clear the ones they were never shown.
  await world.server.agent.notify(world.owner("max"), "Payroll posted", "Done", task.id, "k-pay");
  await world.server.agent.notify(world.owner("max"), "Team lunch", "Noon");
  const cleared = await call("mia", "POST", "/api/agent/notifications/dismiss-all", {});
  assert.equal(cleared.status, 200);
  const left = (await json(await call("max", "GET", "/api/agent/notifications"))) as {
    title: string;
  }[];
  assert.ok(left.some((n) => n.title === "Payroll posted"));
  assert.ok(!left.some((n) => n.title === "Team lunch"));
});

test("what the agent learns in a private channel stays in it", async () => {
  const { channel, thread } = await privateWorld();
  const tool = conversationTools(
    world.server.agent,
    world.owner("max"),
    {
      threadId: thread.threadId,
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    { signal: new AbortController().signal, requestKey: "remember", channelId: channel.id },
  ).find((candidate) => candidate.name === "remember_fact");
  assert.ok(tool);
  const memory = (await (tool.execute as (args: unknown) => Promise<AgentMemory>)({
    text: "The audit is in March",
  })) as AgentMemory;
  assert.equal(memory.channelId, channel.id);
  const open = await make("max", "Plans");
  const elsewhere = conversationTools(
    world.server.agent,
    world.owner("max"),
    {
      threadId: "t-plans",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    { signal: new AbortController().signal, requestKey: "remember-open", channelId: open.id },
  ).find((candidate) => candidate.name === "remember_fact");
  assert.ok(elsewhere);
  const shared = (await (elsewhere.execute as (args: unknown) => Promise<AgentMemory>)({
    text: "Launch is in June",
  })) as AgentMemory;
  assert.equal(shared.channelId, undefined);
  const miaSees = (
    (await json(await call("mia", "GET", "/api/agent"))) as { memories: AgentMemory[] }
  ).memories;
  assert.ok(!miaSees.some((m) => m.id === memory.id));
  assert.ok(miaSees.some((m) => m.id === shared.id));
});

test("goals the agent makes in a private channel are shown only to the people in it, and monitors follow their task", async () => {
  const { channel, thread, task } = await privateWorld();
  const tool = (name: string, channelId: string) => {
    const found = conversationTools(
      world.server.agent,
      world.owner("max"),
      {
        threadId: thread.threadId,
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      { signal: new AbortController().signal, requestKey: `k-${name}-${channelId}`, channelId },
    ).find((candidate) => candidate.name === name);
    assert.ok(found, name);
    return (found.execute as (args: unknown) => Promise<{ id: string }>)(
      (found.parameters as { parse: (value: unknown) => unknown }).parse(
        name === "create_goal"
          ? { title: "Close the books", description: "", category: "finance", milestones: [] }
          : { name: "Audit" },
      ),
    );
  };
  const goal = await tool("create_goal", channel.id);
  // A monitor belongs to its task, which is its project's.
  await world.db.put("shared", "monitors", {
    id: "mon-finance",
    taskId: task.id,
    title: "Rates page",
    url: "https://example.org",
    condition: "change",
    value: "",
    intervalMinutes: 60,
    status: "paused",
    nextCheckAt: new Date().toISOString(),
    checks: 0,
  });
  const seen = async (who: Who) =>
    (await json(await call(who, "GET", "/api/agent"))) as {
      goals: { id: string }[];
      monitors: { id: string }[];
    };
  const mine = await seen("max");
  assert.ok(mine.goals.some((g) => g.id === goal.id));
  assert.ok(mine.monitors.some((m) => m.id === "mon-finance"));
  for (const who of ["mia", "ada", "olive"] as const)
    assert.ok(!(await seen(who)).goals.some((g) => g.id === goal.id), who);
  assert.ok(!(await seen("mia")).monitors.some((m) => m.id === "mon-finance"));
  for (const who of ["ada", "olive"] as const)
    assert.ok(
      (await seen(who)).monitors.some((m) => m.id === "mon-finance"),
      who,
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
      await call("mia", "POST", `/api/agent/channels/${club.id}/managers`, {
        add: ["mia@example.com"],
      })
    ).status,
    403,
  );
  // A manager does, and chooses others, among the people in the channel and not a guest.
  const managers = (who: Who, body: unknown) =>
    call(who, "POST", `/api/agent/channels/${club.id}/managers`, body);
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
  const set = (who: Who, body: unknown) =>
    call(who, "PATCH", `/api/agent/channels/${lab.id}`, body);
  // Anyone in the team can read a public channel; no one outside it can read a private one.
  assert.equal((await call("ada", "GET", `/api/agent/channels/${lab.id}/tasks`)).status, 200);
  assert.equal((await set("mia", { visibility: "private" })).status, 403);
  const closed = await set("max", { visibility: "private" });
  assert.equal(closed.status, 200);
  assert.equal((await json(closed)).visibility, "private");
  assert.equal((await call("ada", "GET", `/api/agent/channels/${lab.id}/tasks`)).status, 404);
  assert.equal((await call("mia", "GET", `/api/agent/channels/${lab.id}/tasks`)).status, 200);
  // A manager cannot open it up again; an owner can once they are in it.
  assert.equal((await set("max", { visibility: "public" })).status, 403);
  assert.equal((await add("max", lab.id, "olive@example.com")).status, 200);
  assert.equal((await set("olive", { visibility: "public" })).status, 200);
  assert.equal((await call("ada", "GET", `/api/agent/channels/${lab.id}/tasks`)).status, 200);
  // Archived, it is read-only: no one is added or taken out.
  assert.equal(
    (await call("max", "POST", `/api/agent/channels/${lab.id}/archive`, {})).status,
    200,
  );
  const frozen = await add("max", lab.id, "ada@example.com");
  assert.equal(frozen.status, 409);
  assert.match((await json(frozen)).error, /archived/);
});

test("everyone in the workspace can be put in a channel by an owner or admin, and taken out without losing anyone who is here", async () => {
  const town = await make("max", "Town hall");
  const everyone = (who: Who, on: boolean) =>
    call(who, "PATCH", `/api/agent/channels/${town.id}`, { everyone: on });
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
  const bad = await call("ada", "PATCH", `/api/agent/channels/${town.id}`, {
    visibility: "private",
    everyone: true,
  });
  assert.equal(bad.status, 409);
});

test("an older channel everyone is in becomes private only by an owner or admin, and keeps the people who are here", async () => {
  const now = new Date().toISOString();
  await world.db.put("shared", "channels", {
    id: "ops",
    name: "Ops",
    status: "active",
    createdBy: "acct:someone",
    createdAt: now,
    updatedAt: now,
    members: ["gus@example.com"],
  });
  assert.equal(
    (await call("max", "PATCH", "/api/agent/channels/ops", { visibility: "private" })).status,
    403,
  );
  const closed = await call("ada", "PATCH", "/api/agent/channels/ops", { visibility: "private" });
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
  const archive = (who: Who, id: string) =>
    call(who, "POST", `/api/agent/channels/${id}/archive`, {});
  assert.equal((await archive("gus", spare.id)).status, 403);
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
  const directory = async (who: Who) => call(who, "GET", "/api/agent/admin/channels");
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
  assert.equal((await call("ada", "GET", `/api/agent/channels/${lost.id}/threads`)).status, 404);
  assert.equal(
    (await call("max", "POST", `/api/agent/admin/channels/${lost.id}/join`)).status,
    403,
  );
  // Joining names them in it, for the people there to see, and opens it to them.
  const joined = await call("ada", "POST", `/api/agent/admin/channels/${lost.id}/join`);
  assert.equal(joined.status, 200);
  const entry = await json(joined);
  assert.deepEqual([entry.joined, entry.count], [true, 2]);
  assert.deepEqual((await stored(lost.id))?.members, ["ada@example.com", "max@example.com"]);
  assert.equal((await call("ada", "GET", `/api/agent/channels/${lost.id}/threads`)).status, 200);
  // And archives one they are not in, which would otherwise be left for good.
  const gone = await make("max", "Gone quiet", "private");
  const archived = await call("ada", "POST", `/api/agent/admin/channels/${gone.id}/archive`, {});
  assert.equal(archived.status, 200);
  assert.equal((await json(archived)).archived, true);
  assert.equal(
    (await call("max", "POST", `/api/agent/admin/channels/${team.id}/archive`, {})).status,
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
  // A thread registered meanwhile does not undo a person leaving.
  await Promise.all([
    remove("mia", board.id, "mia@example.com"),
    world.server.agent.registerThread(world.owner("max"), board.id, "Notes"),
  ]);
  assert.ok(!(await stored(board.id))?.members?.includes("mia@example.com"));
});

test("the browser windows the agent opened in a private channel are shown to the people in it", async () => {
  const { thread } = await privateWorld();
  const open = await make("max", "Reading");
  const publicThread = await world.server.agent.registerThread(
    world.owner("max"),
    open.id,
    "Links",
  );
  const window = (id: string) => ({
    id,
    url: "https://example.org",
    title: id,
    status: "idle" as const,
    updatedAt: new Date().toISOString(),
  });
  await world.db.put("shared", "chat-browsers", { id: thread.threadId, sessionId: "w-private" });
  await world.db.put("shared", "chat-browsers", {
    id: publicThread.threadId,
    sessionId: "w-public",
  });
  const all = [window("w-private"), window("w-public"), window("w-unknown")];
  const ids = async (who: Who) =>
    (await world.server.agent.visibleBrowsers(world.owner(who), all)).map((w) => w.id);
  assert.deepEqual(await ids("max"), ["w-private", "w-public", "w-unknown"]);
  assert.deepEqual(await ids("mia"), ["w-public", "w-unknown"]);
});

test("a thread bound right after a lookup found it bound to nothing is found at once", async () => {
  const room = await make("max", "Quick");
  const id = "t-quick-1";
  assert.equal(await world.server.agent.channelOfThread(world.owner("max"), id), null);
  await world.server.agent.ensureThreadBinding(world.owner("max"), id, room.id, "Quick");
  assert.equal(
    (await world.server.agent.channelOfThread(world.owner("max"), id))?.channelId,
    room.id,
  );
  // And a person outside a private channel is refused its new thread at once.
  const hidden = await make("max", "Quick private", "private");
  await world.server.agent.ensureThreadBinding(world.owner("max"), "t-quick-2", hidden.id, "x");
  assert.equal((await call("mia", "GET", "/api/conversation?threadId=t-quick-2")).status, 404);
});

test("a workspace that keeps no list of people has no one to be in a channel", async () => {
  const { createApp } = await import("../apps/server/src/app.ts");
  const { createStore } = await import("../apps/server/src/db.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomBytes } = await import("node:crypto");
  const dir = await mkdtemp(join(tmpdir(), "hive-solo-"));
  const db = await createStore();
  const solo = await createApp(db, {
    mode: "live",
    port: 8788,
    host: "127.0.0.1",
    publicUrl: "https://solo.example.test",
    dataDir: dir,
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "https://solo.example.test/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const channel = await solo.agent.createChannel("alice", { name: "Plain" });
    assert.equal(channel.members, undefined);
    await assert.rejects(
      solo.agent.createChannel("alice", { name: "Secret", visibility: "private" }),
      /knows its people/,
    );
    await assert.rejects(
      solo.agent.people.get("alice", channel.id),
      /does not keep a list of people/,
    );
    const listed = await solo.agent.listChannels("alice");
    assert.ok(listed.some((c) => c.id === channel.id));
  } finally {
    await solo.agent.stop();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
