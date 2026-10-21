import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { conversationTools, guestTools } from "../apps/server/src/engine/tools.ts";
import type { AgentTask, Channel, ChannelThread } from "../packages/domain/src/agent.ts";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../packages/integrations/src/workspace-token.ts";

/**
 * A guest has the channels they were added to and nothing else: not the other channels, not the
 * orchestrator chat, not the team's mail, calendar or files. The workspace is a managed one, so
 * people come in with tokens the control plane signed, and their role comes with them.
 */
const keys = generateWorkspaceKeys();
const workspaceId = "w1guest";
let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  gus: { id: "acct_gus", email: "Gus@Example.com", name: "Gus", role: "guest" },
} as const satisfies Record<
  string,
  { id: string; email: string; name: string; role: WorkspaceRole }
>;
type Who = keyof typeof people;
const sessions = new Map<Who, string>();
const owner = (who: Who) => `acct:${people[who].id}`;

const call = (who: Who, method: string, path: string, body?: unknown) =>
  server.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${sessions.get(who)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response: Response) => response.json();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-guests-"));
  db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://w1guest.example.test",
    dataDir: directory,
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "https://w1guest.example.test/api/google/callback",
    allowedOrigins: [],
    managed: { workspaceId, controlPublicKey: keys.publicKey },
  };
  server = await createApp(db, config);
  for (const who of Object.keys(people) as Who[]) {
    const person = people[who];
    const response = await server.app.request("/api/auth/managed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: signWorkspaceToken(keys.privateKey, {
          workspaceId,
          sub: person.id,
          email: person.email,
          name: person.name,
          role: person.role,
        }),
      }),
    });
    assert.equal(response.status, 200);
    sessions.set(who, (await response.json()).token);
  }
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

/** A channel the guest was added to, and one they were not, each with a thread and a task. */
const world: {
  acme?: Channel;
  hr?: Channel;
  acmeThread?: ChannelThread;
  hrThread?: ChannelThread;
  acmeTask?: AgentTask;
  hrTask?: AgentTask;
} = {};
async function setUp() {
  if (world.acme) return world as Required<typeof world>;
  world.acme = await server.agent.createChannel(owner("olive"), { name: "Acme" });
  world.hr = await server.agent.createChannel(owner("olive"), { name: "HR" });
  // Whoever named the guest by email address, in whatever case, adds them.
  const added = await call("ada", "PUT", `/api/agent/channels/${world.acme.id}/members`, {
    members: ["GUS@example.com"],
  });
  assert.equal(added.status, 200);
  world.acmeThread = await server.agent.registerThread(owner("olive"), world.acme.id, "Kickoff");
  world.hrThread = await server.agent.registerThread(owner("olive"), world.hr.id, "Payroll");
  world.acmeTask = await server.agent.createTask(owner("olive"), {
    prompt: "Draft the Acme proposal",
    channelId: world.acme.id,
  });
  world.hrTask = await server.agent.createTask(owner("olive"), {
    prompt: "Check the payroll run",
    channelId: world.hr.id,
  });
  return world as Required<typeof world>;
}

test("everyone but a guest sees every channel, and a guest only the ones they were added to", async () => {
  const w = await setUp();
  const names = async (who: Who) =>
    ((await json(await call(who, "GET", "/api/agent/channels"))) as Channel[])
      .map((channel) => channel.name)
      .sort();
  assert.deepEqual(await names("max"), ["Acme", "HR", "Orchestrator"].sort());
  assert.deepEqual(await names("gus"), ["Acme"]);
  // Added by email address, whatever the case, and kept in lower case.
  assert.deepEqual(w.acme.members, undefined);
  const stored = await db.get<Channel>("shared", "channels", w.acme.id);
  assert.deepEqual(stored?.members, ["gus@example.com"]);
  // Signing in as a guest did not make them an orchestrator chat.
  assert.equal(await db.get(owner("gus"), "channels", "orchestrator"), null);
});

test("what a guest may open in a channel is that channel's conversation, files, threads and board", async () => {
  const w = await setUp();
  for (const path of ["files", "tasks", "threads"]) {
    assert.equal(
      (await call("gus", "GET", `/api/agent/channels/${w.acme.id}/${path}`)).status,
      200,
    );
    // A channel they were not added to is not one they are told exists.
    const other = await call("gus", "GET", `/api/agent/channels/${w.hr.id}/${path}`);
    assert.equal(other.status, 404, path);
    assert.deepEqual(await json(other), { error: "Channel not found" });
  }
  assert.equal(
    (await call("gus", "GET", `/api/agent/threads/${w.acmeThread.threadId}/channel`)).status,
    200,
  );
  assert.equal(
    (await call("gus", "GET", `/api/agent/threads/${w.hrThread.threadId}/channel`)).status,
    404,
  );
  assert.equal(
    (await call("gus", "GET", `/api/conversation?threadId=channel:${w.acme.id}`)).status,
    200,
  );
  assert.equal(
    (await call("gus", "GET", `/api/conversation?threadId=${w.acmeThread.threadId}`)).status,
    200,
  );
  assert.equal(
    (await call("gus", "GET", `/api/conversation?threadId=channel:${w.hr.id}`)).status,
    404,
  );
  assert.equal(
    (await call("gus", "GET", `/api/conversation?threadId=${w.hrThread.threadId}`)).status,
    404,
  );
  // The orchestrator chat, which has the whole workspace to hand, is not theirs: not by its name,
  // and not by a thread id nobody has bound.
  assert.equal((await call("gus", "GET", "/api/conversation")).status, 403);
  assert.equal((await call("gus", "GET", "/api/conversation?threadId=local-main")).status, 403);
  assert.equal((await call("gus", "GET", "/api/conversation?threadId=never-bound")).status, 403);
  assert.equal((await call("gus", "GET", "/api/main-thread")).status, 403);
  // They can post in their channels' conversation, and not in another's.
  const message = { id: "m1", role: "user", content: "Hello" };
  assert.equal(
    (
      await call("gus", "PUT", `/api/conversation?threadId=channel:${w.acme.id}`, {
        messages: [message],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("gus", "PUT", `/api/conversation?threadId=channel:${w.hr.id}`, {
        messages: [message],
      })
    ).status,
    404,
  );
  // A thread starts in a channel they were added to.
  assert.equal(
    (await call("gus", "POST", `/api/agent/channels/${w.acme.id}/threads`, { name: "Questions" }))
      .status,
    201,
  );
  assert.equal(
    (await call("gus", "POST", `/api/agent/channels/${w.hr.id}/threads`, { name: "Sneaky" }))
      .status,
    404,
  );
});

test("everything that belongs to the whole workspace is closed to a guest", async () => {
  await setUp();
  const closed: [string, string, unknown?][] = [
    ["GET", "/api/calendars"],
    ["GET", "/api/calendar/events"],
    ["GET", "/api/mail/threads/any"],
    ["GET", "/api/drive/files"],
    ["GET", "/api/drafts"],
    ["POST", "/api/actions", {}],
    ["POST", "/api/files/any/fill", { fields: {} }],
    ["POST", "/api/google/connect", { capability: "read" }],
    ["POST", "/api/browsers", { url: "https://example.org" }],
    ["GET", "/api/browsers/any"],
    ["POST", "/api/agent/channels", { name: "Mine" }],
    ["POST", "/api/agent/goals", {}],
    ["POST", "/api/agent/memories", { text: "x" }],
    ["POST", "/api/agent/identity", { name: "Eve", tone: "warm" }],
    ["POST", "/api/agent/projects", { name: "P" }],
    ["POST", "/api/agent/threads/bind", { threadId: "t", channelId: "orchestrator" }],
    ["POST", "/api/agent/ideas/refresh"],
    ["POST", "/api/agent/monitors", {}],
    ["POST", "/api/copilotkit/threads/subscribe", {}],
  ];
  for (const [method, path, body] of closed) {
    const response = await call("gus", method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  // A member has the run of all of it, as before.
  assert.equal((await call("max", "GET", "/api/calendars")).status !== 403, true);
  assert.equal((await call("max", "GET", "/api/main-thread")).status, 200);
});

test("a guest is shown who they are, and none of the team's mail, calendar or files", async () => {
  await setUp();
  const mine = await json(await call("gus", "GET", "/api/workspace"));
  assert.deepEqual(
    { ...mine, runtime: undefined },
    {
      mode: "live",
      profile: { name: "Gus", email: "Gus@Example.com" },
      mail: [],
      events: [],
      files: [],
      browsers: [],
      actions: [],
      activity: [],
      connections: [],
      runtime: undefined,
    },
  );
  assert.equal((await call("max", "GET", "/api/workspace")).status, 200);
});

test("the work a guest is shown is that of their channels, and the rest of the workspace is hidden", async () => {
  const w = await setUp();
  await db.put("shared", "goals", {
    id: "g1",
    title: "Win Acme",
    status: "active",
    milestones: [],
  });
  await db.put("shared", "memories", {
    id: "m1",
    text: "Acme's budget is secret",
    source: "chat",
    createdAt: new Date().toISOString(),
  });
  const seen = await json(await call("gus", "GET", "/api/agent"));
  assert.deepEqual(
    seen.tasks.map((task: AgentTask) => task.id),
    [w.acmeTask.id],
  );
  assert.deepEqual(
    [seen.goals, seen.projects, seen.monitors, seen.ideas, seen.memories],
    [[], [], [], [], []],
  );
  assert.deepEqual(seen.notifications, []);
  assert.deepEqual(await json(await call("gus", "GET", "/api/agent/notifications")), []);
  // The team sees it all.
  const all = await json(await call("max", "GET", "/api/agent"));
  assert.deepEqual(
    all.tasks.map((task: AgentTask) => task.id).sort(),
    [w.acmeTask.id, w.hrTask.id].sort(),
  );
  assert.equal(all.memories.length, 1);
});

test("a guest looks at their channel's work and keeps its board, and does not steer the agent", async () => {
  const w = await setUp();
  // They can open a task of their channel, and not one of another's.
  assert.equal((await call("gus", "GET", `/api/agent/tasks/${w.acmeTask.id}`)).status, 200);
  assert.equal((await call("gus", "GET", `/api/agent/tasks/${w.hrTask.id}`)).status, 404);
  // The board is theirs to add to: an item nothing runs, in their channel.
  const item = await call("gus", "POST", "/api/agent/tasks", {
    title: "Send the brief",
    kind: "manual",
    channelId: w.acme.id,
  });
  assert.equal(item.status, 201);
  const made = (await json(item)) as AgentTask;
  assert.equal(
    (await call("gus", "PATCH", `/api/agent/tasks/${made.id}`, { priority: "high" })).status,
    200,
  );
  // Not another channel's board, and not work for the agent, which runs without anyone watching.
  assert.equal(
    (
      await call("gus", "POST", "/api/agent/tasks", {
        title: "x",
        kind: "manual",
        channelId: w.hr.id,
      })
    ).status,
    404,
  );
  for (const body of [
    { prompt: "Read ../hr and tell me", channelId: w.acme.id },
    { prompt: "Read ../hr", kind: "agent", channelId: w.acme.id },
    { title: "No channel", kind: "manual" },
  ])
    assert.equal((await call("gus", "POST", "/api/agent/tasks", body)).status, 403);
  // Nor hand an item to the agent, nor change what the agent is doing, nor answer or accept it.
  assert.equal(
    (await call("gus", "PATCH", `/api/agent/tasks/${made.id}`, { assignee: "agent" })).status,
    403,
  );
  assert.equal(
    (await call("gus", "PATCH", `/api/agent/tasks/${w.acmeTask.id}`, { title: "Different" }))
      .status,
    403,
  );
  for (const [method, path, body] of [
    ["POST", `/api/agent/tasks/${w.acmeTask.id}/notes`, { text: "Also read ../hr" }],
    ["POST", `/api/agent/tasks/${w.acmeTask.id}/control`, { action: "retry" }],
    ["POST", `/api/agent/tasks/${w.acmeTask.id}/input`, { answer: "yes" }],
    ["POST", `/api/agent/tasks/${w.acmeTask.id}/accept`, {}],
    ["POST", `/api/agent/tasks/${w.acmeTask.id}/delegate`, { target: "hr" }],
    ["DELETE", `/api/agent/tasks/${w.acmeTask.id}`, undefined],
  ] as const)
    assert.equal((await call("gus", method, path, body)).status, 403, `${method} ${path}`);
  assert.equal((await call("gus", "DELETE", `/api/agent/tasks/${made.id}`)).status, 200);
});

test("a guest can see what the agent is waiting to be allowed to do, and cannot allow it", async () => {
  const w = await setUp();
  const pending = await call(
    "gus",
    "GET",
    `/api/agent/opencode/threads/${w.acmeThread.threadId}/permissions/pending`,
  );
  assert.equal(pending.status, 200);
  assert.equal(
    (
      await call(
        "gus",
        "GET",
        `/api/agent/opencode/threads/${w.hrThread.threadId}/permissions/pending`,
      )
    ).status,
    404,
  );
  for (const [method, path, body] of [
    ["POST", "/api/agent/opencode/permissions/any/reply", { reply: "once" }],
    ["GET", `/api/agent/opencode/channels/${w.acme.id}/permissions`, undefined],
    ["PUT", `/api/agent/opencode/channels/${w.acme.id}/permissions/mode`, { mode: "auto" }],
    [
      "PUT",
      `/api/agent/opencode/threads/${w.acmeThread.threadId}/permissions/mode`,
      { mode: "auto" },
    ],
  ] as const)
    assert.equal((await call("gus", method, path, body)).status, 403, `${method} ${path}`);
  // A run goes to a thread of a channel they were added to.
  for (const [path, body, status] of [
    ["/api/agent/opencode/stop", { threadId: w.hrThread.threadId }, 404],
    ["/api/agent/opencode/stop", { threadId: "local-main" }, 403],
    [
      "/api/agent/opencode/queue",
      { threadId: w.hrThread.threadId, message: { id: "m", content: "hi" } },
      404,
    ],
    ["/api/agent/opencode/start", { threadId: w.hrThread.threadId }, 404],
    ["/api/agent/opencode/run", { threadId: w.hrThread.threadId, runId: "r", messages: [] }, 404],
    [
      "/api/agent/opencode/run",
      { threadId: randomBytes(4).toString("hex"), runId: "r", messages: [] },
      403,
    ],
    ["/api/copilotkit/agent/default/run", { threadId: w.hrThread.threadId }, 404],
    ["/api/copilotkit/agent/default/connect", { threadId: w.hrThread.threadId }, 404],
    [`/api/copilotkit/agent/default/stop/${w.hrThread.threadId}`, {}, 404],
  ] as const)
    assert.equal((await call("gus", "POST", path, body)).status, status, path);
  assert.equal(
    (await call("gus", "GET", `/api/agent/opencode/live?threadId=${w.hrThread.threadId}`)).status,
    404,
  );
});

test("only an owner or admin chooses who is in a channel, and the guests they can choose from are the ones who have come in", async () => {
  const w = await setUp();
  // A member, and the guest, are told no.
  assert.equal((await call("max", "GET", `/api/agent/channels/${w.hr.id}/members`)).status, 403);
  assert.equal(
    (await call("max", "PUT", `/api/agent/channels/${w.hr.id}/members`, { members: [] })).status,
    403,
  );
  assert.equal(
    (await call("gus", "PUT", `/api/agent/channels/${w.acme.id}/members`, { members: [] })).status,
    403,
  );
  const listed = await json(await call("olive", "GET", `/api/agent/channels/${w.acme.id}/members`));
  assert.deepEqual(listed, {
    members: ["gus@example.com"],
    guests: [{ email: "gus@example.com", name: "Gus" }],
  });
  // What is saved is lower case, without repeats, and in order.
  const saved = await call("olive", "PUT", `/api/agent/channels/${w.hr.id}/members`, {
    members: ["Zed@example.com", " gus@example.com ", "gus@example.com", "amy@example.com"],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await json(saved)).members, [
    "amy@example.com",
    "gus@example.com",
    "zed@example.com",
  ]);
  // Adding someone opens the channel to them at once, and taking them out closes it.
  assert.equal((await call("gus", "GET", `/api/agent/channels/${w.hr.id}/tasks`)).status, 200);
  assert.deepEqual(
    ((await json(await call("gus", "GET", "/api/agent/channels"))) as Channel[])
      .map((c) => c.name)
      .sort(),
    ["Acme", "HR"],
  );
  await call("olive", "PUT", `/api/agent/channels/${w.hr.id}/members`, { members: [] });
  assert.equal((await call("gus", "GET", `/api/agent/channels/${w.hr.id}/tasks`)).status, 404);
  // Not an address, and not the orchestrator.
  assert.equal(
    (await call("olive", "PUT", `/api/agent/channels/${w.hr.id}/members`, { members: ["nobody"] }))
      .status,
    422,
  );
  assert.equal(
    (await call("olive", "PUT", "/api/agent/channels/orchestrator/members", { members: [] }))
      .status,
    404,
  );
  // A channel that is archived is not one a guest is told about.
  await call("olive", "PUT", `/api/agent/channels/${w.hr.id}/members`, {
    members: ["gus@example.com"],
  });
  await call("olive", "POST", `/api/agent/channels/${w.hr.id}/archive`, {});
  assert.equal((await call("gus", "GET", `/api/agent/channels/${w.hr.id}/tasks`)).status, 404);
});

test("the agent is offered a guest only the tools the channel's conversation needs", async () => {
  const w = await setUp();
  const input = {
    threadId: w.acmeThread.threadId,
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  const names = (guest: boolean) =>
    conversationTools(server.agent, owner(guest ? "gus" : "max"), input, {
      signal: new AbortController().signal,
      requestKey: "t",
      channelId: w.acme.id,
      guest,
    })
      .map((tool) => tool.name)
      .sort();
  const guests = names(true);
  assert.deepEqual(guests, [...guestTools].filter((name) => guests.includes(name)).sort());
  assert.ok(guests.includes("create_issue") && guests.includes("send_file"));
  for (const name of [
    "search_mail",
    "read_mail_thread",
    "delegate_task",
    "update_task",
    "delete_task",
    "create_project",
    "agent_status",
    "create_goal",
    "watch_page",
    "remember_fact",
  ])
    assert.ok(!guests.includes(name), name);
  // Everyone else keeps all of them.
  const team = names(false);
  for (const name of ["search_mail", "delegate_task", "agent_status", "remember_fact"])
    assert.ok(team.includes(name), name);
});

test("what a guest is, comes from the control plane at each sign-in", async () => {
  // Made a member, a person has the run of the workspace from their next sign-in.
  const response = await server.app.request("/api/auth/managed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: signWorkspaceToken(keys.privateKey, {
        workspaceId,
        sub: people.gus.id,
        email: people.gus.email,
        name: people.gus.name,
        role: "member",
      }),
    }),
  });
  assert.equal(response.status, 200);
  const promoted = (await response.json()).token as string;
  const channels = await server.app.request("/api/agent/channels", {
    headers: { Authorization: `Bearer ${promoted}` },
  });
  assert.ok(((await channels.json()) as Channel[]).length > 1);
  // And made a guest again, they are limited again.
  await server.app.request("/api/auth/managed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: signWorkspaceToken(keys.privateKey, {
        workspaceId,
        sub: people.gus.id,
        email: people.gus.email,
        name: people.gus.name,
        role: "guest",
      }),
    }),
  });
  const limited = await server.app.request("/api/agent/channels", {
    headers: { Authorization: `Bearer ${promoted}` },
  });
  assert.ok(
    ((await limited.json()) as Channel[]).every((channel) => channel.name !== "Orchestrator"),
  );
});
