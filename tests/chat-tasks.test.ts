import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunnerLink } from "../apps/chat/src/agent-link.ts";
import { ChatCore } from "../apps/chat/src/core.ts";
import { TaskBorrower } from "../apps/server/src/chat-runner/borrow.ts";
import { createStore } from "../apps/server/src/db.ts";
import { type TaskContext, TaskWorker } from "../apps/server/src/engine/worker.ts";
import { RUN_LIMITS } from "../packages/chat-core/src/runs.ts";
import type { Sql } from "../packages/chat-core/src/sql.ts";
import { TASK_LIMITS } from "../packages/chat-core/src/work.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { RoomFrame, RunnerFrame } from "../packages/domain/src/chat-agent.ts";
import { memorySql } from "./helpers/do-shim.ts";

const max = { id: "acct_max", email: "max@example.com", name: "Max", role: "member" } as const;

type Handler = (owner: string, task: AgentTask, ctx: TaskContext) => Promise<Partial<AgentTask>>;

interface Machine {
  borrower: TaskBorrower;
  worker: TaskWorker;
  /** What it holds locally, as the worker sees it. */
  db: Awaited<ReturnType<typeof createStore>>;
  /** Frames the machine sent, in order. */
  sent: RunnerFrame[];
  /** Frames the room sent it. */
  got: RoomFrame[];
  handler: { current: Handler };
  /** The machine is gone: nothing reaches it and nothing it says reaches the room. */
  dead: boolean;
}

let sql: Sql;
let core: ChatCore;
let clock: number;
let woken: number;
let connected: Machine | null;
/** One local store for the whole file (a database apiece is too much for a small box); a machine starts with it empty. */
let local: Awaited<ReturnType<typeof createStore>>;

before(async () => {
  local = await createStore();
});
after(async () => {
  await local.close();
});

const build = async (shared: Sql = sql) => {
  core = new ChatCore(shared, {
    clock: () => clock,
    runner: () =>
      connected
        ? ({
            send: (text) => {
              const m = connected;
              if (!m || m.dead) return;
              const frame = JSON.parse(text) as RoomFrame;
              m.got.push(frame);
              m.borrower.onFrame(frame);
            },
            close: () => undefined,
          } satisfies RunnerLink)
        : null,
    wake: () => {
      woken++;
    },
  });
  await core.syncPeople([{ sub: max.id, email: max.email, name: max.name, role: max.role }]);
};

beforeEach(async () => {
  sql = memorySql();
  clock = 1_000_000;
  woken = 0;
  connected = null;
  await build();
});

const machines: Machine[] = [];
afterEach(() => {
  for (const m of machines.splice(0)) {
    m.dead = true;
    m.borrower.stop();
  }
});

const task = (id: string, extra: Partial<AgentTask> = {}) =>
  core.tasks.create({
    id,
    kind: "agent",
    status: "queued",
    createdBy: max.id,
    title: id,
    prompt: `do ${id}`,
    ...extra,
  } as AgentTask);

const machine = async (
  handler: Handler,
  options: { syncEveryMs?: number; maxTasks?: number } = {},
): Promise<Machine> => {
  const db = local;
  for (const kind of ["tasks", "runs", "run-events"])
    for (const row of await db.scan<{ id: string }>(kind))
      await db.remove(row.owner, kind, row.value.id);
  const m: Machine = {
    sent: [],
    got: [],
    dead: false,
    handler: { current: handler },
    borrower: undefined as never,
    worker: undefined as never,
    db,
  };
  m.worker = new TaskWorker(db, (owner, t, ctx) => m.handler.current(owner, t, ctx), {
    finished: (owner, t) => m.borrower.finished(owner, t),
  });
  m.borrower = new TaskBorrower({
    send: (frame) => {
      if (m.dead) return false;
      m.sent.push(frame);
      void core.agent.onFrame(JSON.stringify(frame));
      return true;
    },
    copies: {
      get: (owner, id) => db.get<AgentTask>(owner, "tasks", id),
      put: async (owner, t) => void (await db.put(owner, "tasks", t)),
      remove: (owner, id) => db.remove(owner, "tasks", id),
      addNotes: async (owner, id, notes) => {
        for (const note of notes) await db.appendItem(owner, "tasks", id, "notes", note);
      },
    },
    prepare: async () => undefined,
    run: () => void m.worker.tick(),
    abort: (id) => m.worker.abort(id),
    syncEveryMs: options.syncEveryMs ?? 10,
    maxTasks: options.maxTasks,
  });
  machines.push(m);
  return m;
};

/** The machine connects and says hello, as it does when it opens the connection. */
const connect = async (m: Machine, maxTasks = 3) => {
  connected = m;
  await core.agent.onFrame(
    JSON.stringify({
      t: "hello",
      v: 1,
      identity: { name: "Hive" },
      capacity: { maxRuns: 2, maxTasks },
      active: [],
      tasks: m.borrower.leases(),
    }),
  );
  m.borrower.onOpen();
};

const settle = () => sleep(30);
const finished = (id: string) => core.tasks.get(id);

test("a due task is given to the machine, worked, and given back with how it ended", async () => {
  task("t1");
  const seen: AgentTask[] = [];
  const m = await machine(async (owner, t, ctx) => {
    seen.push(t);
    assert.equal(owner, max.id);
    await ctx.checkpoint({ state: { step: 1 } });
    await ctx.checkpoint({ state: { step: 2 }, result: "partial" });
    return { status: "in_review", result: "all done" };
  });
  await connect(m);
  await settle();
  const done = finished("t1") as AgentTask;
  assert.equal(done.status, "in_review");
  assert.equal(done.result, "all done");
  assert.deepEqual(done.state, { step: 2 });
  assert.equal(done.leaseId, null);
  assert.equal(done.attempts, 1);
  assert.equal(seen[0]?.prompt, "do t1");
  // The room has the end, so the machine let go of it.
  assert.equal(m.borrower.leases().length, 0);
  assert.ok(m.got.some((f) => f.t === "task.ended"));
});

test("a manual task, and one scheduled for later, are not given out", async () => {
  task("manual", { kind: "manual" });
  task("later", { status: "scheduled", nextRunAt: new Date(clock + 60_000).toISOString() });
  const m = await machine(async () => ({ status: "succeeded" }));
  await connect(m);
  await settle();
  assert.equal(m.got.filter((f) => f.t === "task.start").length, 0);
  clock += 61_000;
  await core.agent.maintain();
  await settle();
  assert.equal(finished("later")?.status, "succeeded");
  assert.equal(finished("manual")?.status, "queued");
});

test("no more tasks are given out than the machine says it takes", async () => {
  for (const id of ["a", "b", "c"]) task(id);
  const release: (() => void)[] = [];
  const m = await machine(
    (_o, _t, ctx) =>
      new Promise((resolve) => {
        release.push(() => resolve({ status: "succeeded" }));
        ctx.signal.addEventListener("abort", () => resolve({}));
      }),
  );
  await connect(m, 2);
  await settle();
  assert.equal(m.got.filter((f) => f.t === "task.start").length, 2);
  release[0]?.();
  await settle();
  assert.equal(m.got.filter((f) => f.t === "task.start").length, 3);
});

test("a flood of progress goes to the room as a few reports, and the last one wins", async () => {
  task("busy");
  const m = await machine(
    async (_o, _t, ctx) => {
      for (let i = 1; i <= 60; i++) {
        await ctx.checkpoint({ state: { n: i }, error: `step ${i}` });
        await sleep(5);
      }
      return { status: "succeeded" };
    },
    { syncEveryMs: 30 },
  );
  await connect(m);
  await sleep(500);
  const reports = m.sent.filter((f) => f.t === "task.checkpoint").length;
  assert.ok(reports >= 2 && reports <= 20, `${reports} reports for 60 changes`);
  const done = finished("busy") as AgentTask;
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.state, { n: 60 });
});

test("a machine that restarts under a task is told it lost it: the task is cut off and given out again", async () => {
  task("t2");
  const hang: Handler = (_o, _t, ctx) =>
    new Promise((_resolve, reject) =>
      ctx.signal.addEventListener("abort", () => reject(new Error("x"))),
    );
  const first = await machine(hang);
  await connect(first);
  await settle();
  assert.equal(finished("t2")?.status, "running");
  // The machine restarts: a new one knows nothing of the task.
  first.dead = true;
  const second = await machine(async () => ({ status: "succeeded", result: "second try" }));
  await connect(second);
  await settle();
  const done = finished("t2") as AgentTask;
  assert.equal(done.status, "succeeded");
  assert.equal(done.result, "second try");
  assert.equal(done.attempts, 2);
  // A good finish clears the marks against it.
  assert.equal(done.interruptions, 0);
});

test("what a machine says after its lease is gone is dropped, and it is told to let go", async () => {
  task("t3");
  const hang: Handler = (_o, _t, ctx) =>
    new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({})));
  const slow = await machine(hang);
  await connect(slow);
  await settle();
  const old = slow.borrower.leases()[0];
  assert.ok(old, "the slow machine holds the task");
  // The room gives up on this machine (it went quiet) and another takes the task.
  // Without a connection a task gets longer to come back before it is given up on.
  connected = null;
  clock += TASK_LIMITS.beatStaleMs + RUN_LIMITS.lostGraceMs + 1_000;
  await core.agent.maintain();
  assert.equal(finished("t3")?.status, "queued");
  assert.equal(finished("t3")?.interruptions, 1);
  const other = await machine(async () => ({ status: "succeeded", result: "good" }));
  await connect(other);
  await settle();
  assert.equal(finished("t3")?.result, "good");
  // The slow one wakes up and reports on the lease it had.
  await core.agent.onFrame(
    JSON.stringify({ t: "task.checkpoint", ...old, patch: { state: { stale: true } } }),
  );
  await core.agent.onFrame(
    JSON.stringify({ t: "task.end", ...old, patch: { status: "succeeded", result: "stale" } }),
  );
  await settle();
  assert.equal(finished("t3")?.state, undefined);
  assert.equal(finished("t3")?.result, "good");
  assert.ok(
    other.got.some((f) => f.t === "task.stop" && f.leaseId === old.leaseId),
    "the machine that reported on a lease it lost is told to let go",
  );
});

test("a task cut off too many times in a row is stopped", async () => {
  task("t4");
  for (let i = 0; i <= TASK_LIMITS.maxInterruptions; i++) {
    const m = await machine(
      (_o, _t, ctx) =>
        new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("x")))),
    );
    await connect(m);
    await settle();
    m.dead = true;
    connected = null;
    clock += TASK_LIMITS.beatStaleMs + RUN_LIMITS.lostGraceMs + 1_000;
    await core.agent.maintain();
  }
  const stopped = finished("t4") as AgentTask;
  assert.equal(stopped.status, "failed");
  assert.match(String(stopped.error), /cut off/);
});

test("the room restarting under a running task does not cost the machine the task", async () => {
  task("t5");
  let finish!: () => void;
  const m = await machine(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ status: "succeeded", result: "kept going" });
      }),
  );
  await connect(m);
  await settle();
  // A new room over the same storage: it knows nothing but what was written down.
  await build(sql);
  await connect(m);
  assert.ok(m.got.some((f) => f.t === "welcome" && f.resumeTasks?.length === 1));
  finish();
  await settle();
  assert.equal(finished("t5")?.status, "succeeded");
  assert.equal(finished("t5")?.result, "kept going");
  assert.equal(finished("t5")?.attempts, 1);
});

test("how a task ended is said again after the connection drops, until the room has it", async () => {
  task("t6");
  const m = await machine(async () => ({ status: "succeeded", result: "done while away" }));
  // The room does not hear the end: the connection is down when it is sent.
  let drop = false;
  const send = m.borrower["deps"].send;
  m.borrower["deps"].send = (frame) => (drop && frame.t === "task.end" ? true : send(frame));
  drop = true;
  await connect(m);
  await settle();
  assert.equal(finished("t6")?.status, "running");
  assert.equal(m.borrower.leases().length, 1);
  drop = false;
  await connect(m);
  await settle();
  assert.equal(finished("t6")?.status, "succeeded");
  assert.equal(finished("t6")?.result, "done while away");
  assert.equal(m.borrower.leases().length, 0);
});

test("a task given out and not taken before the connection dropped goes back to wait", async () => {
  task("t7");
  connected = null;
  await core.agent.pump();
  assert.ok(woken > 0, "the machine is woken for a due task");
  // Given out, but the machine never says it took it.
  const m = await machine(async () => ({ status: "succeeded" }));
  m.borrower.onFrame = () => undefined;
  await connect(m);
  assert.equal(finished("t7")?.status, "running");
  connected = null;
  await core.agent.disconnected();
  const back = finished("t7") as AgentTask;
  assert.equal(back.status, "queued");
  assert.equal(back.attempts, 0);
});
