import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ChatCore } from "../apps/chat/src/core.ts";
import { taskNotice } from "../apps/chat/src/work-notices.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ChatNotice } from "../packages/domain/src/chat.ts";
import { chatWorld } from "./helpers/chat-world.ts";

/**
 * The agent's news for a person (a task is ready for review, needs them, failed) is kept by the room as that
 * person's own notice, so it shows while the machine sleeps, and nobody else, an admin included, can read it.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
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
const noticesOf = async (who: Who, query = "") =>
  json<ChatNotice[]>(await call(who, "GET", `/v1/notifications${query}`));
const agentTask = async (who: Who, title: string) => {
  const response = await call(who, "POST", "/v1/tasks", {
    title,
    kind: "agent",
    prompt: "do it",
    held: true,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return json<AgentTask>(response);
};
/** The machine's report that the task reached a state. */
const reach = (task: AgentTask, patch: Partial<AgentTask>) => {
  const before = core.tasks.get(task.id) as AgentTask;
  const saved = core.tasks.change(task.id, { ...patch, updatedAt: new Date().toISOString() });
  assert.ok(saved);
  core.workNotices.taskChanged(saved as AgentTask, before);
  return saved as AgentTask;
};

test("what a task coming to a state says is the same as the machine said, and a person's own to-do says nothing", () => {
  const task = { id: "t1", title: "Fix it", kind: "agent", attempts: 1 } as AgentTask;
  const of = (status: AgentTask["status"], extra: Partial<AgentTask> = {}) =>
    taskNotice(
      { ...task, ...extra, status } as AgentTask,
      { ...task, status: "running" } as AgentTask,
    );
  assert.deepEqual(of("succeeded", { result: "All good" }), {
    title: "Fix it",
    body: "All good",
    key: "task-done:t1",
  });
  assert.equal(of("in_review")?.title, "Ready for your review");
  assert.equal(of("failed", { error: "boom" })?.body, "boom");
  assert.equal(of("waiting_input", { question: "Which one?" })?.body, "Which one?");
  assert.equal(of("running"), null);
  assert.equal(
    taskNotice({ ...task, kind: "manual", status: "succeeded" } as AgentTask, null),
    null,
  );
  // The same state again is not news.
  assert.equal(
    taskNotice(
      { ...task, status: "in_review" } as AgentTask,
      { ...task, status: "in_review" } as AgentTask,
    ),
    null,
  );
});

test("the person who started a task is told when it needs them, once, and nobody else sees it", async () => {
  const task = await agentTask("mia", "Write the report");
  reach(task, { status: "in_review", attempts: 1 });
  const mine = await noticesOf("mia");
  assert.equal(mine.length, 1);
  assert.deepEqual(
    [mine[0]?.kind, mine[0]?.title, mine[0]?.body, mine[0]?.taskId, mine[0]?.read],
    ["work", "Ready for your review", "Write the report", task.id, false],
  );
  // Not the owner, not an admin.
  assert.deepEqual(await noticesOf("olive"), []);
  assert.deepEqual(await noticesOf("ada"), []);
  // Said again, it is the same news.
  core.workNotices.taskChanged(core.tasks.get(task.id) as AgentTask, null);
  assert.equal((await noticesOf("mia")).length, 1);
  // Sent back for more work, it is news again: a new attempt (the lease counts attempts, which a test does not run).
  const current = core.tasks.get(task.id) as AgentTask;
  core.workNotices.taskChanged(
    { ...current, status: "in_review", attempts: 2 },
    { ...current, status: "running", attempts: 2 },
  );
  assert.equal((await noticesOf("mia")).length, 2);
  // The person is told live, by their own event.
  assert.ok(published.some((e) => e.type === "notification.new" && e.userId === "acct_mia"));
  assert.ok(!published.some((e) => e.type === "notification.new" && e.userId === "acct_ada"));
});

test("a notice is read, unread and dismissed like any other, and a dismissed one does not come back", async () => {
  const task = await agentTask("mia", "Write the report");
  reach(task, { status: "failed", error: "It broke", attempts: 1 });
  const [notice] = await noticesOf("mia");
  assert.ok(notice);
  assert.equal((await call("mia", "POST", `/v1/notifications/${notice.id}/read`)).status, 200);
  assert.equal((await noticesOf("mia"))[0]?.read, true);
  assert.deepEqual(await noticesOf("mia", "?unread=1"), []);
  await call("mia", "POST", `/v1/notifications/${notice.id}/unread`);
  assert.equal((await noticesOf("mia", "?unread=1")).length, 1);
  // Someone else cannot touch it.
  const other = await json<{ changed: number }>(
    await call("ada", "POST", `/v1/notifications/${notice.id}/dismiss`),
  );
  assert.equal(other.changed, 0);
  assert.equal((await noticesOf("mia")).length, 1);
  await call("mia", "POST", `/v1/notifications/${notice.id}/dismiss`);
  assert.deepEqual(await noticesOf("mia"), []);
  // The same failure reported again is not new news, even though the notice is gone from the list.
  core.workNotices.taskChanged(core.tasks.get(task.id) as AgentTask, null);
  assert.deepEqual(await noticesOf("mia"), []);
  // Everything at once.
  const second = await agentTask("mia", "Another");
  reach(second, { status: "in_review", attempts: 1 });
  assert.equal((await noticesOf("mia")).length, 1);
  await call("mia", "POST", "/v1/notifications/read-all");
  assert.deepEqual(await noticesOf("mia", "?unread=1"), []);
  await call("mia", "POST", "/v1/notifications/dismiss-all");
  assert.deepEqual(await noticesOf("mia"), []);
});

test("a person who has turned off news of the agent's work is not shown it", async () => {
  const task = await agentTask("mia", "Write the report");
  reach(task, { status: "in_review", attempts: 1 });
  assert.equal((await noticesOf("mia")).length, 1);
  const prefs = await call("mia", "PUT", "/v1/notification-prefs", {
    mentions: true,
    work: false,
    muted: [],
  });
  assert.equal(prefs.status, 200);
  assert.deepEqual(await noticesOf("mia"), []);
});
