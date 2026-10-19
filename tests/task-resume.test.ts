import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { sessionDirectory } from "../apps/server/src/opencode/sessions.ts";
import { runOpencodeTask } from "../apps/server/src/opencode/tasks.ts";
import {
  type AgentTask,
  ORCHESTRATOR_CHANNEL_ID,
  type RunEvent,
} from "../packages/domain/src/agent.ts";

/** Tasks that were running when the workspace restarted, and what the next run knows about it. */
function task(over: Partial<AgentTask> = {}): AgentTask {
  const now = new Date().toISOString();
  return {
    id: "task1",
    title: "Check a source",
    prompt: "Check a source",
    kind: "agent",
    status: "queued",
    priority: "medium",
    blockedBy: [],
    labels: [],
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
    ...over,
  };
}
const saved = (db: Awaited<ReturnType<typeof createStore>>, id = "task1") =>
  db.get<AgentTask>("owner", "tasks", id);
const events = async (db: Awaited<ReturnType<typeof createStore>>) =>
  (await db.list<RunEvent>("owner", "run-events")).map((event) => event.title);

test("a task cut off by a crash is picked up again and marked as interrupted", async () => {
  const db = await createStore();
  try {
    await db.put(
      "owner",
      "tasks",
      task({
        status: "running",
        attempts: 1,
        leaseId: "dead",
        leaseUntil: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    let seen: AgentTask | undefined;
    await new TaskWorker(db, async (_owner, value) => {
      seen = value;
      return { status: "succeeded" as const, result: "done" };
    }).tick();
    assert.ok(seen?.interruptedAt, "the run is told it follows an interruption");
    assert.equal(seen?.interruptions, 1);
    assert.equal(seen?.attempts, 2);
    const done = await saved(db);
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.interruptedAt, null, "cleared once a run ends");
    assert.equal(done?.interruptions, 0);
  } finally {
    await db.close();
  }
});

test("a task stopped for an update goes back in the queue to continue, without a mark against it", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new TaskWorker(db, async (_owner, _value, ctx) => {
      started();
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
      await ctx.guard();
      return { status: "succeeded" as const };
    });
    const tick = worker.tick();
    await running;
    await worker.stop();
    await tick;
    const stopped = await saved(db);
    assert.equal(stopped?.status, "queued");
    assert.ok(stopped?.interruptedAt);
    assert.equal(stopped?.interruptions ?? 0, 0, "an update is not the task's fault");
  } finally {
    await db.close();
  }
});

test("a task that keeps being cut off is stopped and needs a person", async () => {
  const db = await createStore();
  try {
    await db.put(
      "owner",
      "tasks",
      task({
        status: "running",
        attempts: 4,
        interruptions: 3,
        leaseId: "dead",
        leaseUntil: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    let calls = 0;
    let settled: AgentTask | undefined;
    await new TaskWorker(
      db,
      async () => {
        calls++;
        return { status: "succeeded" as const };
      },
      {
        settled: async (_owner, value) => {
          settled = value;
        },
      },
    ).tick();
    assert.equal(calls, 0, "it is not started a fourth time");
    const stopped = await saved(db);
    assert.equal(stopped?.status, "failed");
    assert.match(stopped?.error ?? "", /cut off 3 times/);
    assert.equal(settled?.status, "failed", "the people on the task are told");
    assert.deepEqual(await events(db), ["Task needs attention"]);
  } finally {
    await db.close();
  }
});

test("a run that does nothing for too long is stopped and the task starts again", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let clock = 1_000_000;
    let runs = 0;
    const worker = new TaskWorker(
      db,
      async (_owner, value, ctx) => {
        runs++;
        if (runs === 2) {
          assert.ok(value.interruptedAt, "the second run knows the first was cut off");
          return { status: "succeeded" as const };
        }
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
        await ctx.guard();
        return { status: "succeeded" as const };
      },
      { now: () => clock, stallMs: 10 * 60_000, pollMs: 1_000_000 },
    );
    const first = worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock += 5 * 60_000;
    await worker.tick();
    assert.equal(runs, 1, "five quiet minutes is not a stall");
    clock += 6 * 60_000;
    await worker.tick();
    await first;
    const requeued = await saved(db);
    assert.equal(requeued?.status, "queued");
    assert.equal(requeued?.interruptions, 1, "a stall counts against the task");
    assert.deepEqual(await events(db), ["Stopped responding"]);
    await worker.tick();
    assert.equal(runs, 2);
    assert.equal((await saved(db))?.status, "succeeded");
  } finally {
    await db.close();
  }
});

test("a stalled run that will not wind down is let go of, and the task can be claimed again", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let clock = 1_000_000;
    let runs = 0;
    const worker = new TaskWorker(
      db,
      async () => {
        runs++;
        if (runs === 1) await new Promise(() => undefined); // never ends, ignores the stop
        return { status: "succeeded" as const };
      },
      { now: () => clock, stallMs: 60_000, stallGraceMs: 1, pollMs: 1_000_000, leaseMs: 3_000 },
    );
    void worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock += 120_000;
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Its lease is still in the database, so another worker sees a running task whose lease runs out.
    await db.compareAndSwap(
      "owner",
      "tasks",
      "task1",
      { status: "running" },
      { leaseUntil: new Date(clock - 1).toISOString() },
    );
    await worker.tick();
    assert.equal(runs, 2);
    assert.equal((await saved(db))?.status, "succeeded");
  } finally {
    await db.close();
  }
});

/** A runtime that records which OpenCode session the run used and what it was told. */
async function agentRun(over: Partial<AgentTask>, existingSession: boolean) {
  const directory = await mkdtemp(`${tmpdir()}/hive-resume-`);
  let listener: (event: unknown) => void = () => {};
  const calls = { created: 0, prompts: [] as string[], used: [] as string[] };
  const records = new Map<string, unknown>([
    [
      "task1",
      {
        id: "task1",
        sessionId: "ses-old",
        directory: sessionDirectory(
          { dataDir: directory } as never,
          "owner",
          ORCHESTRATOR_CHANNEL_ID,
        ),
      },
    ],
  ]);
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) =>
        existingSession && sessionID === "ses-old" ? { data: { id: sessionID } } : { error: {} },
      create: async () => {
        calls.created++;
        return { data: { id: "ses-new" } };
      },
      promptAsync: async ({
        sessionID,
        parts,
      }: {
        sessionID: string;
        parts: Array<{ text: string }>;
      }) => {
        calls.used.push(sessionID);
        calls.prompts.push(parts.map((part) => part.text).join("\n"));
        listener({
          id: "e1",
          type: "message.part.updated",
          properties: {
            sessionID,
            part: { id: "p1", messageID: "m1", type: "text", text: "HIVE_TASK_COMPLETE: ok" },
          },
        });
        listener({ type: "session.idle", properties: {} });
        return {};
      },
    },
  };
  const eventTitles: string[] = [];
  const written = new Map<string, unknown>();
  try {
    await runOpencodeTask(
      {
        config: { dataDir: directory },
        pool: { forDirectory: () => client },
        tracker: {},
        bus: {
          track: () => {},
          onEvent: (_scope: string, next: (event: unknown) => void) => {
            listener = next;
            return () => {};
          },
          waitForConnection: async () => {},
          enqueue: async (_scope: string, action: () => unknown) => action(),
        },
      } as never,
      {
        db: {
          get: async (_o: string, kind: string, id: string) =>
            kind === "task-sessions" ? (records.get(id) ?? null) : null,
          list: async () => [],
          put: async (_o: string, kind: string, value: { id: string }) => {
            written.set(`${kind}:${value.id}`, value);
            return value;
          },
        },
        prepareBrief: async (_owner: string, claimed: unknown) => ({
          task: claimed,
          files: [],
          names: new Map(),
          text: "NOTE: use the new figures",
          noteIds: [],
        }),
        markNotesDelivered: async () => {},
        pendingUpdate: async () => null,
        artifact: async () => ({ id: "a1" }),
        submitForReview: async () => ({ status: "in_review" as const }),
      } as never,
      "owner",
      task(over) as never,
      {
        signal: new AbortController().signal,
        guard: async () => {},
        event: async (_kind: string, title: string) => {
          eventTitles.push(title);
        },
        checkpoint: async (patch: Partial<AgentTask>) => ({ ...task(over), ...patch }),
      } as never,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { ...calls, eventTitles, written };
}

test("after an interruption the agent goes back into its own session and is told to check before repeating", async () => {
  const run = await agentRun({ interruptedAt: new Date().toISOString() }, true);
  assert.equal(run.created, 0, "no new session");
  assert.deepEqual(run.used, ["ses-old"]);
  assert.match(run.prompts[0] ?? "", /Resumed after an interruption/);
  assert.match(run.prompts[0] ?? "", /whether it already happened/);
  assert.match(run.prompts[0] ?? "", /NOTE: use the new figures/, "notes added since still arrive");
  assert.ok(run.eventTitles.includes("Back in the same session"));
});

test("when the old session is gone the agent starts a new one that says it was interrupted", async () => {
  const run = await agentRun({ interruptedAt: new Date().toISOString() }, false);
  assert.equal(run.created, 1);
  assert.deepEqual(run.used, ["ses-new"]);
  assert.match(run.prompts[0] ?? "", /## Interrupted/);
  assert.ok(run.eventTitles.includes("Starting a new session"));
  assert.ok(run.written.has("task-sessions:task1"), "the new session is written down");
});

test("a task that was not interrupted always gets a fresh session, even with an old one on record", async () => {
  const run = await agentRun({}, true);
  assert.equal(run.created, 1);
  assert.doesNotMatch(run.prompts[0] ?? "", /Interrupted|Resumed after/);
});
