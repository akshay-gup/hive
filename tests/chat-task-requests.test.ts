import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask, Channel } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import type { RoomFrame } from "../packages/domain/src/chat-agent.ts";
import type { SourceTaskAudience, SourceTaskView } from "../packages/domain/src/task-source.ts";
import { chatWorld } from "./helpers/chat-world.ts";

const people = {
  ada: { id: "ada", email: "ada@example.com", name: "Ada", role: "admin" },
  mia: { id: "mia", email: "mia@example.com", name: "Mia", role: "member" },
  max: { id: "max", email: "max@example.com", name: "Max", role: "member" },
  gus: { id: "gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

async function world() {
  let clock = Date.now();
  let connected = true;
  const frames: RoomFrame[] = [];
  const w = await chatWorld(people, {
    clock: () => clock,
    runner: () => (connected ? { send: (s) => frames.push(JSON.parse(s)), close() {} } : null),
  });
  const channel = await w.ok<Channel>(
    await w.call("mia", "POST", "/v1/channels", { name: "Private", visibility: "private" }),
    201,
  );
  const post = async (
    who: Who = "mia",
    threadRoot?: string,
    body = "Write the proposal\nOnly these details should be copied",
  ) =>
    w.ok<ChatMessage>(
      await w.call(who, "POST", `/v1/channels/${channel.id}/messages`, { body, threadRoot }),
      201,
    );
  const message = await post();
  const propose = async (
    who: Who = "mia",
    messageId = message.id,
    clientId: string = crypto.randomUUID(),
  ) =>
    w.ok<SourceTaskView>(
      await w.call(who, "POST", "/v1/task-requests", { messageId, clientId }),
      201,
    );
  const audience = async (request: SourceTaskView, projectId = "general", who: Who = "mia") =>
    w.ok<SourceTaskAudience>(
      await w.call(who, "GET", `/v1/task-requests/${request.id}/projects/${projectId}`),
    );
  const confirm = (
    request: SourceTaskView,
    preview: SourceTaskAudience,
    extra: object = {},
    who: Who = "mia",
  ) =>
    w.call(who, "POST", `/v1/task-requests/${request.id}/confirm`, {
      projectId: preview.projectId,
      fingerprint: preview.fingerprint,
      share: true,
      ...extra,
    });
  return {
    ...w,
    channel,
    message,
    post,
    propose,
    audience,
    confirm,
    frames,
    advance: (ms: number) => {
      clock += ms;
    },
    disconnect: () => {
      connected = false;
    },
  };
}

test("a private-channel task stays off the board until the asker chooses and confirms its current audience", async () => {
  const w = await world();
  const request = await w.propose();
  assert.equal(request.status, "pending");
  assert.equal(request.title, "Write the proposal");
  assert.equal(w.core.tasks.all().length, 0);
  assert.ok(request.projects.some((p) => p.id === "general"));
  const preview = await w.audience(request);
  assert.deepEqual(
    preview.outside.map((p) => [p.id, p.name, p.email]),
    [
      ["ada", "Ada", "ada@example.com"],
      ["max", "Max", "max@example.com"],
    ],
  );
  assert.equal(preview.confirmed, false);
  assert.equal((await w.confirm(request, preview, { share: false })).status, 409);
  assert.equal(w.core.tasks.all().length, 0);
  w.disconnect();
  const made = await w.ok<SourceTaskView>(await w.confirm(request, preview));
  const task = w.core.tasks.get(made.taskId!)!;
  assert.equal(made.status, "created");
  assert.equal(task.createdBy, "mia");
  assert.equal(task.projectId, "general");
  assert.equal(task.channelId, w.channel.id);
  assert.equal(task.threadId, w.message.id);
  assert.equal(task.kind, "manual");
  assert.equal(task.input.privateConversation, true);
  assert.equal(task.prompt, w.message.body);
  assert.equal((await w.call("max", "GET", `/v1/tasks/${task.id}`)).status, 200);
  assert.equal((await w.call("max", "GET", `/v1/channels/${w.channel.id}`)).status, 404);
  assert.ok(
    w.published.filter((e) => e.type === "task-request.changed").every((e) => e.userId === "mia"),
  );
  const privateEvents = w.published.filter((e) => e.type === "task-request.changed");
  assert.doesNotMatch(JSON.stringify(privateEvents), /example.com|Write the proposal/);
});

test("only the asker can see the project choices or approve a pending task, including against an admin", async () => {
  const w = await world();
  await w.call("mia", "POST", `/v1/channels/${w.channel.id}/members`, {
    add: [people.max.email, people.ada.email],
  });
  const secret = await w.core.work.createProject("mia", {
    name: "Mia's project",
    access: "private",
  });
  const request = await w.propose();
  const preview = await w.audience(request, secret.id);
  for (const who of ["max", "ada"] as const) {
    assert.equal((await w.call(who, "GET", `/v1/task-requests/${request.id}`)).status, 404);
    assert.equal(
      (await w.call(who, "GET", `/v1/task-requests/${request.id}/projects/${secret.id}`)).status,
      404,
    );
    assert.equal((await w.confirm(request, preview, {}, who)).status, 404);
    assert.equal(
      (await w.call(who, "POST", `/v1/task-requests/${request.id}/cancel`, {})).status,
      404,
    );
  }
  assert.equal(w.core.tasks.all().length, 0);
});

test("the picker includes only projects the asker can work in, and does not reveal another private project", async () => {
  const w = await world();
  const hidden = await w.core.work.createProject("max", { name: "Hidden", access: "private" });
  const limited = await w.core.work.createProject("max", { name: "Limited", access: "limited" });
  const request = await w.propose();
  assert.ok(!request.projects.some((p) => [hidden.id, limited.id].includes(p.id)));
  assert.equal(
    (await w.call("mia", "GET", `/v1/task-requests/${request.id}/projects/${hidden.id}`)).status,
    404,
  );
  assert.equal(
    (await w.call("mia", "GET", `/v1/task-requests/${request.id}/projects/${limited.id}`)).status,
    403,
  );
  assert.equal(
    (await w.confirm(request, { projectId: hidden.id, fingerprint: "fake" } as SourceTaskAudience))
      .status,
    404,
  );
});

test("sharing is remembered only for the same asker, project and thread, with unchanged people", async () => {
  const w = await world();
  const first = await w.propose();
  await w.ok(await w.confirm(first, await w.audience(first)));
  const reply = await w.post("mia", w.message.id);
  const second = await w.propose("mia", reply.id);
  assert.equal(second.suggestedProjectId, "general");
  assert.equal((await w.audience(second)).confirmed, true);
  const otherProject = await w.core.work.createProject("mia", { name: "Another" });
  assert.equal((await w.audience(second, otherProject.id)).confirmed, false);
  const otherThread = await w.propose("mia", (await w.post()).id);
  assert.equal((await w.audience(otherThread)).confirmed, false);
  await w.call("mia", "POST", `/v1/channels/${w.channel.id}/members`, { add: [people.max.email] });
  assert.equal(
    (await w.audience(second)).confirmed,
    false,
    "a channel audience change resets consent",
  );
  const otherAsker = await w.propose("max", reply.id);
  assert.equal((await w.audience(otherAsker, "general", "max")).confirmed, false);
  const before = await w.audience(second);
  await w.core.syncPeople([
    ...Object.values(people).map((p) => ({
      sub: p.id,
      email: p.email,
      name: p.name,
      role: p.role,
    })),
    { sub: "new", name: "New", email: "new@example.com", role: "member" },
  ]);
  assert.equal((await w.confirm(second, before)).status, 409);
  const after = await w.audience(second);
  assert.ok(after.outside.some((p) => p.id === "new"));
  assert.equal(after.confirmed, false);
  assert.equal(w.core.tasks.all().length, 1);
});

test("a private project's admins outside the channel are named, and its changing members invalidate review", async () => {
  const w = await world();
  const project = await w.core.work.createProject("mia", {
    name: "Private board",
    access: "private",
  });
  const request = await w.propose();
  const before = await w.audience(request, project.id);
  assert.deepEqual(
    before.outside.map((p) => p.id),
    ["ada"],
  );
  await w.core.work.updateProject("mia", project.id, {
    members: [...project.members!, { email: people.gus.email, role: "viewer" }],
  });
  assert.equal((await w.confirm(request, before)).status, 409);
  const after = await w.audience(request, project.id);
  assert.deepEqual(
    after.outside.map((p) => p.id),
    ["ada", "gus"],
  );
  await w.ok(await w.confirm(request, after));
  assert.equal((await w.call("gus", "GET", `/v1/tasks/${w.core.tasks.all()[0]!.id}`)).status, 200);
});

test("a task with no wider audience needs no extra sharing approval", async () => {
  const w = await world();
  await w.call("mia", "POST", `/v1/channels/${w.channel.id}/members`, {
    add: [people.ada.email, people.max.email],
  });
  const request = await w.propose();
  const preview = await w.audience(request);
  assert.deepEqual(preview.outside, []);
  assert.equal((await w.confirm(request, preview, { share: false })).status, 200);
});

test("an audience change during approval preflight cannot slip through the task transaction", async () => {
  const w = await world();
  const project = await w.core.work.createProject("mia", {
    name: "Private board",
    access: "private",
  });
  const request = await w.propose();
  const preview = await w.audience(request, project.id);
  const byId = w.core.access.byId.bind(w.core.access);
  let changed = false;
  w.core.access.byId = async () => {
    const people = await byId();
    if (!changed) {
      changed = true;
      w.core.projects.put({
        ...project,
        members: [...(project.members ?? []), { email: "max@example.com", role: "viewer" }],
      });
    }
    return people;
  };
  assert.equal((await w.confirm(request, preview)).status, 409);
  assert.equal(w.core.tasks.all().length, 0);
  assert.equal(w.core.entries.list("task_sharing").length, 0);
  w.core.access.byId = byId;
  const updated = await w.audience(request, project.id);
  assert.ok(updated.outside.some((person) => person.id === "max"));
  await w.ok(await w.confirm(request, updated));
});

test("retries and simultaneous clicks create one task; cancellation racing confirmation never leaves an orphan", async () => {
  const w = await world();
  const first = await w.propose("mia", w.message.id, "retry");
  assert.equal((await w.propose("mia", w.message.id, "retry")).id, first.id);
  const preview = await w.audience(first);
  const results = await Promise.all([w.confirm(first, preview), w.confirm(first, preview)]);
  const a = await w.ok<SourceTaskView>(results[0]!);
  const b = await w.ok<SourceTaskView>(results[1]!);
  assert.equal(a.taskId, b.taskId);
  assert.equal(w.core.tasks.all().length, 1);
  for (let i = 0; i < 4; i++) {
    const request = await w.propose();
    const audience = await w.audience(request);
    await Promise.all([
      w.call("mia", "POST", `/v1/task-requests/${request.id}/cancel`, {}),
      w.confirm(request, audience),
    ]);
    const value = await w.ok<SourceTaskView>(
      await w.call("mia", "GET", `/v1/task-requests/${request.id}`),
    );
    assert.equal(
      w.core.tasks.all().filter((t) => t.id === value.taskId).length,
      value.status === "created" ? 1 : 0,
    );
  }
});

test("expired, deleted-source, archived and revoked requests cannot create tasks", async () => {
  for (const change of ["expired", "deleted", "archived", "revoked"] as const) {
    const w = await world();
    const request = await w.propose();
    const preview = await w.audience(request);
    if (change === "expired") w.advance(24 * 60 * 60_000 + 1);
    if (change === "deleted") await w.call("mia", "DELETE", `/v1/messages/${w.message.id}`);
    if (change === "archived")
      await w.call("mia", "POST", `/v1/channels/${w.channel.id}/archive`, {});
    if (change === "revoked") {
      await w.call("mia", "POST", `/v1/channels/${w.channel.id}/members`, {
        add: [people.max.email],
      });
      await w.call("mia", "POST", `/v1/channels/${w.channel.id}/managers`, {
        add: [people.max.email],
      });
      await w.call("max", "POST", `/v1/channels/${w.channel.id}/members`, {
        remove: [people.mia.email],
      });
    }
    const result = await w.confirm(request, preview);
    if (change === "expired")
      assert.equal((await w.ok<SourceTaskView>(result)).status, "cancelled");
    else assert.ok([404, 409].includes(result.status), `${change}: ${result.status}`);
    assert.equal(w.core.tasks.all().length, 0, change);
  }
});

test("task limits fail without granting consent or creating a task", async () => {
  const w = await world();
  const request = await w.propose();
  const preview = await w.audience(request);
  for (let i = 0; i < 100; i++)
    w.core.tasks.create({
      id: `cap-${i}`,
      title: "Full",
      kind: "manual",
      status: "queued",
      createdBy: "mia",
    } as AgentTask);
  assert.equal((await w.confirm(request, preview)).status, 409);
  assert.equal(w.core.entries.get(request.id)?.status, "pending");
  assert.equal(w.core.entries.list("task_sharing").length, 0);
  assert.equal(w.core.tasks.all().length, 100);
});

test("raw task creation cannot bypass private-channel confirmation, and DMs and public channels have no new picker", async () => {
  const w = await world();
  for (const privateSource of [undefined, true]) {
    const result = await w.call("mia", "POST", "/v1/tasks", {
      title: "Bypass",
      kind: "manual",
      channelId: w.channel.id,
      privateSource,
      input: {},
    });
    assert.equal(result.status, 409);
  }
  const dm = await w.ok<Channel>(
    await w.call("mia", "POST", "/v1/dms", { email: people.max.email }),
    201,
  );
  const pub = await w.ok<Channel>(
    await w.call("mia", "POST", "/v1/channels", { name: "Public" }),
    201,
  );
  for (const channel of [dm, pub]) {
    const message = await w.ok<ChatMessage>(
      await w.call("mia", "POST", `/v1/channels/${channel.id}/messages`, { body: "hello" }),
      201,
    );
    assert.equal(
      (await w.call("mia", "POST", "/v1/task-requests", { messageId: message.id })).status,
      409,
    );
  }
  assert.equal(w.core.tasks.all().length, 0);
});

test("long message details fit task limits without splitting emoji, and guests choose only their workable projects", async () => {
  const w = await world();
  const long = await w.post("mia", undefined, `a${"😀".repeat(9000)}`);
  const request = await w.propose("mia", long.id);
  assert.ok(request.title.length <= 160);
  assert.ok(request.prompt.length <= 12000);
  assert.ok(!/[\uD800-\uDBFF]$/u.test(request.title));
  assert.ok(!/[\uD800-\uDBFF]$/u.test(request.prompt));
  await w.ok(await w.confirm(request, await w.audience(request)));
  await w.ok(
    await w.call("mia", "POST", `/v1/channels/${w.channel.id}/members`, {
      add: [people.gus.email],
    }),
  );
  const project = await w.core.work.createProject("mia", {
    name: "Client work",
    access: "private",
  });
  await w.core.work.updateProject("mia", project.id, {
    members: [...project.members!, { email: people.gus.email, role: "member" }],
  });
  const guest = await w.propose("gus");
  assert.deepEqual(
    guest.projects.map((p) => p.id),
    [project.id],
  );
  const preview = await w.audience(guest, project.id, "gus");
  const made = await w.ok<SourceTaskView>(await w.confirm(guest, preview, {}, "gus"));
  assert.equal(w.core.tasks.get(made.taskId!)?.createdBy, "gus");
});

test("handing a shared task to the agent never pulls in the private discussion, including for a project outsider", async () => {
  const w = await world();
  const request = await w.propose();
  const made = await w.ok<SourceTaskView>(await w.confirm(request, await w.audience(request)));
  for (const who of ["max", "mia"] as const) {
    const task = await w.ok<AgentTask>(
      await w.call(who, "PATCH", `/v1/tasks/${made.taskId}`, {
        assignee: "agent",
        channelContext: true,
      }),
    );
    assert.equal(task.input.discussion, undefined);
    assert.equal(task.input.privateConversation, true);
    await w.ok(await w.call(who, "PATCH", `/v1/tasks/${made.taskId}`, { assignee: null }));
  }
});

async function agentRequest(
  w: Awaited<ReturnType<typeof world>>,
  task: Record<string, unknown> = {},
  threadRoot?: string,
) {
  await w.ok(await w.call("mia", "PATCH", `/v1/channels/${w.channel.id}`, { agent: true }));
  await w.core.agent.onFrame(
    JSON.stringify({ t: "hello", v: 1, active: [], capacity: { maxRuns: 2 } }),
  );
  const message = await w.post("mia", threadRoot, "@hive create a task");
  const start = w.frames.filter((f) => f.t === "run.start").at(-1);
  assert.ok(start && start.t === "run.start");
  const runId = start.run.id;
  await w.core.agent.onFrame(JSON.stringify({ t: "run.ack", runId }));
  const reqId = crypto.randomUUID();
  await w.core.agent.onFrame(
    JSON.stringify({
      t: "work.call",
      reqId,
      runId,
      key: reqId,
      op: "task.create",
      args: { kind: "manual", title: "Selected details", prompt: "Approved description", ...task },
    }),
  );
  const result = w.frames.find((f) => f.t === "work.result" && f.reqId === reqId);
  assert.ok(result && result.t === "work.result" && result.ok, JSON.stringify(result));
  const body = result.body as {
    created: boolean;
    needsProject?: boolean;
    requestId?: string;
    id?: string;
  };
  return { runId, body, message };
}

test("an agent request creates a room-owned picker, which works after the run finishes and the machine sleeps", async () => {
  const w = await world();
  const { runId, body } = await agentRequest(w);
  assert.equal(body.created, false);
  assert.equal(body.needsProject, true);
  assert.doesNotMatch(JSON.stringify(body), /projects|example.com|general/);
  const run = w.core.runs.get(runId)!;
  assert.equal(run.prompts[0]?.prompt.kind, "task_project");
  assert.equal((w.core.messages.get(run.replyId)?.extra as { v: number } | undefined)?.v, 2);
  assert.equal(w.core.tasks.all().length, 0);
  assert.equal(
    (
      await w.call("mia", "POST", `/v1/runs/${runId}/answer`, {
        promptId: body.requestId,
        choice: { reply: "always" },
      })
    ).status,
    422,
  );
  await w.core.agent.onFrame(
    JSON.stringify({
      t: "run.end",
      runId,
      n: 1,
      status: "done",
      body: "Choose a project in the card.",
      steps: [],
    }),
  );
  w.disconnect();
  const request = await w.ok<SourceTaskView>(
    await w.call("mia", "GET", `/v1/task-requests/${body.requestId}`),
  );
  await w.ok(await w.confirm(request, await w.audience(request)));
  assert.equal(w.core.runs.get(runId)?.prompts[0]?.answered?.by, "mia");
  assert.equal(w.core.tasks.all().length, 1);
});

test("failed and stopped runs cancel task choices without creating tasks", async () => {
  for (const state of ["failed", "stopped"] as const) {
    const w = await world();
    const { runId, body } = await agentRequest(w);
    await w.core.agent.finish(runId, state, state === "stopped" ? "user" : "error");
    assert.equal(w.core.entries.get(body.requestId!)?.status, "cancelled");
    const choice = w.core.runs.get(runId)?.prompts[0]?.answered?.choice;
    assert.ok(choice && "dismiss" in choice && choice.dismiss);
    assert.equal(w.core.tasks.all().length, 0);
  }
});

test("an agent can reuse a named project only after this asker approved it in this thread", async () => {
  const w = await world();
  const first = await w.propose();
  await w.ok(await w.confirm(first, await w.audience(first)));
  const { runId, body } = await agentRequest(w, { projectId: "general" }, w.message.id);
  assert.equal(body.created, true);
  assert.equal(body.needsProject, undefined);
  assert.equal(w.core.runs.get(runId)?.prompts.length, 0);
  assert.equal(w.core.tasks.all().length, 2);
});
