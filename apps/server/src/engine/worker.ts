import { randomUUID } from "node:crypto";
import {
  type AgentTask,
  ORCHESTRATOR_CHANNEL_ID,
  type RunEvent,
} from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";

export class LostLeaseError extends Error {
  constructor() {
    super("Task was paused, cancelled or taken over by another worker");
    this.name = "LostLeaseError";
  }
}
export interface TaskContext {
  signal: AbortSignal;
  guard(): Promise<void>;
  checkpoint(patch: Partial<AgentTask>): Promise<AgentTask>;
  event(kind: RunEvent["kind"], title: string, detail?: string): Promise<void>;
}
export type TaskHandler = (
  owner: string,
  task: AgentTask,
  context: TaskContext,
) => Promise<Partial<AgentTask>>;
export class TaskWorker {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private active = new Map<string, AbortController>();
  /** When each running task last did something: wrote an event, saved progress, or checked its lease. */
  private lastActivity = new Map<string, number>();
  private stalled = new Set<string>();
  lastTickAt?: string;
  constructor(
    private readonly db: Store,
    private readonly execute: TaskHandler,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      settled?: (owner: string, task: AgentTask) => Promise<void>;
      /** Told when a run is over and its outcome is settled: the task as it now stands. */
      finished?: (owner: string, task: AgentTask) => Promise<void>;
      /** A run that has done nothing for this long is stopped and started again. Default 20 minutes. */
      stallMs?: number;
      /** How long a stopped run gets to wind down before it is let go of. Default 60 seconds. */
      stallGraceMs?: number;
      /** Runs in a row that may be cut off by a crash or a stall before the task is stopped. Default 3. */
      maxInterruptions?: number;
      /**
       * When set, this worker only claims tasks belonging to the channel.
       * Unset (the default) claims everything: the pre-channels behavior,
       * used by the orchestrator worker.
       */
      channelId?: string;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get running() {
    return Boolean(this.timer);
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      // Timer callbacks cannot await runs; each run owns its durable error state.
      void this.tick().catch((error) => backgroundFailure("task worker tick", error));
    }, this.options.pollMs ?? 1000);
    void this.tick().catch((error) => backgroundFailure("initial task worker tick", error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size || this.ticking) await new Promise((r) => setTimeout(r, 10));
  }
  abort(taskId: string) {
    this.active.get(taskId)?.abort();
  }
  async tick() {
    if (this.stopping) return;
    if (this.running)
      await this.db.put("system", "worker-status", {
        id: this.options.channelId ? `tasks:${this.options.channelId}` : "tasks",
        lastTickAt: new Date(this.now()).toISOString(),
      });
    await this.releaseStalled();
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.now()).toISOString();
    try {
      const records = await this.db.scan<AgentTask>("tasks");
      const channelId = this.options.channelId;
      const due = records.filter(
        ({ value: t }) =>
          t.kind !== "manual" &&
          !this.active.has(t.id) &&
          (channelId === undefined || (t.channelId ?? ORCHESTRATOR_CHANNEL_ID) === channelId) &&
          (t.status === "queued" ||
            (t.status === "scheduled" && Date.parse(t.nextRunAt ?? "") <= this.now()) ||
            (t.status === "running" && Date.parse(t.leaseUntil ?? "") <= this.now()) ||
            t.status === "waiting_approval"),
      );
      const eligible = [];
      for (const record of due) {
        if (record.value.status === "waiting_approval") {
          const action = record.value.actionId
            ? await this.db.get<{ status: string; expiresAt?: string }>(
                record.owner,
                "actions",
                record.value.actionId,
              )
            : null;
          if (
            record.value.actionId &&
            action?.status === "awaiting_review" &&
            Date.parse(action.expiresAt ?? "") <= this.now()
          )
            await this.db.compareAndSwap(
              record.owner,
              "actions",
              record.value.actionId,
              { status: "awaiting_review", expiresAt: action.expiresAt },
              { status: "expired" },
            );
          else if (action && ["awaiting_review", "executing"].includes(action.status)) continue;
        }
        eligible.push(record);
        if (eligible.length === 3) break;
      }
      // Tasks are shared, but each runs as the person who asked for it.
      await Promise.all(
        eligible.map(({ owner, value }) => this.run(value.createdBy ?? owner, value)),
      );
    } finally {
      this.ticking = false;
    }
  }
  /**
   * A run that has said nothing for too long is stuck (a hung tool, a lost connection to the model).
   * It is stopped, which puts the task back in the queue to continue in its session. If it will not
   * wind down, it is let go of so the task can be picked up anyway; its lease no longer matches, so
   * anything it still tries to write is refused.
   */
  private async releaseStalled() {
    const stallMs = this.options.stallMs ?? 20 * 60_000;
    for (const [taskId, last] of this.lastActivity) {
      if (this.stalled.has(taskId) || this.now() - last < stallMs) continue;
      const controller = this.active.get(taskId);
      if (!controller) continue;
      this.stalled.add(taskId);
      controller.abort();
      const grace = setTimeout(() => {
        if (this.active.get(taskId) === controller) {
          this.active.delete(taskId);
          this.lastActivity.delete(taskId);
          this.releasers.get(taskId)?.();
        }
      }, this.options.stallGraceMs ?? 60_000);
      (grace as unknown as { unref?: () => void }).unref?.();
    }
  }
  /** Ends the wait on a run that was let go of, so the worker can tick again while it is still stuck. */
  private releasers = new Map<string, () => void>();
  private async run(owner: string, previous: AgentTask) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releasers.set(previous.id, release);
    try {
      await Promise.race([this.runTask(owner, previous), released]);
    } finally {
      if (this.releasers.get(previous.id) === release) this.releasers.delete(previous.id);
    }
  }
  private async runTask(owner: string, previous: AgentTask) {
    if (this.stopping) return;
    const leaseId = randomUUID(),
      leaseMs = this.options.leaseMs ?? 60000;
    const expected: Record<string, unknown> = {
      status: previous.status,
      leaseId: previous.leaseId ?? null,
    };
    if (previous.status === "running") expected.leaseUntil = previous.leaseUntil;
    const claimedAt = new Date(this.now()).toISOString();
    // A task still marked running whose lease has run out was cut off: the process died with it.
    const crashed = previous.status === "running";
    const interruptions = (previous.interruptions ?? 0) + (crashed ? 1 : 0);
    if (crashed && interruptions > (this.options.maxInterruptions ?? 3)) {
      const stopped = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        previous.id,
        expected,
        {
          status: "failed",
          error: `Stopped after being cut off ${interruptions - 1} times in a row. Look at what it did, then send it back to try again.`,
          leaseId: null,
          leaseUntil: null,
          updatedAt: claimedAt,
        },
      );
      if (stopped) {
        await this.db
          .put(owner, "run-events", {
            id: randomUUID(),
            taskId: previous.id,
            date: claimedAt,
            kind: "error",
            title: "Task needs attention",
            detail: stopped.error ?? "",
          })
          .catch((error) => backgroundFailure("record task error", error));
        if (this.options.settled) await this.options.settled(owner, stopped);
        if (this.options.finished) await this.options.finished(owner, stopped);
      }
      return;
    }
    let task = await this.db.compareAndSwap<AgentTask>(owner, "tasks", previous.id, expected, {
      status: "running",
      leaseId,
      leaseUntil: new Date(this.now() + leaseMs).toISOString(),
      runStartedAt: claimedAt,
      updatedAt: claimedAt,
      attempts: previous.attempts + 1,
      ...(crashed ? { interruptedAt: claimedAt, interruptions } : {}),
    });
    if (!task) return;
    const controller = new AbortController();
    this.active.set(task.id, controller);
    const taskId = task.id;
    const touch = () => this.lastActivity.set(taskId, this.now());
    touch();
    const guard = async () => {
      touch();
      const latest = await this.db.get<AgentTask>(owner, "tasks", taskId);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest.status !== "running")
        throw new LostLeaseError();
    };
    const checkpoint = async (patch: Partial<AgentTask>) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      touch();
      const next = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        taskId,
        { leaseId, status: "running" },
        { ...patch, updatedAt: new Date(this.now()).toISOString() },
      );
      if (!next) throw new LostLeaseError();
      task = next;
      return next;
    };
    const event = async (kind: RunEvent["kind"], title: string, detail = "") => {
      await guard();
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        date: new Date(this.now()).toISOString(),
        kind,
        title,
        detail,
      });
    };
    const startedAt = new Date(this.now()).toISOString();
    const heartbeat = setInterval(
      () => {
        // A run that was let go of must not keep the lease, or the timer, alive.
        if (this.active.get(taskId) !== controller) {
          clearInterval(heartbeat);
          return;
        }
        void this.db
          .compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "running" },
            { leaseUntil: new Date(this.now() + leaseMs).toISOString() },
          )
          .then((value) => {
            if (!value) controller.abort();
          })
          .catch(() => controller.abort());
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    try {
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        status: "running",
      });
      const result = await this.execute(owner, task, {
        signal: controller.signal,
        guard,
        checkpoint,
        event,
      });
      await checkpoint({
        ...result,
        leaseId: null,
        leaseUntil: null,
        interruptedAt: null,
        interruptions: 0,
      });
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        status: result.status ?? task.status,
      });
    } catch (error) {
      if (error instanceof LostLeaseError || controller.signal.aborted) {
        // Put back in the queue to continue where it was. A stop for an update is no fault of the
        // task's; a stall counts against it, so a task that always hangs is stopped in the end.
        const stalled = this.stalled.has(taskId);
        const requeued = await this.db.compareAndSwap<AgentTask>(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          {
            status: "queued",
            leaseId: null,
            leaseUntil: null,
            interruptedAt: new Date(this.now()).toISOString(),
            ...(stalled ? { interruptions: (task.interruptions ?? 0) + 1 } : {}),
          },
        );
        if (requeued && stalled)
          await this.db
            .put(owner, "run-events", {
              id: randomUUID(),
              taskId,
              date: new Date(this.now()).toISOString(),
              kind: "status",
              title: "Stopped responding",
              detail:
                "The agent did nothing for a long while, so it was stopped and will pick the task up again.",
            })
            .catch((error) => backgroundFailure("record task stall", error));
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        await event("error", "Task needs attention", detail).catch((error) =>
          backgroundFailure("record task error", error),
        );
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          {
            status: "failed",
            error: detail,
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date(this.now()).toISOString(),
          },
        );
      }
      await this.db.compareAndSwap(
        owner,
        "runs",
        leaseId,
        { status: "running" },
        {
          status: controller.signal.aborted ? "interrupted" : "failed",
          finishedAt: new Date(this.now()).toISOString(),
        },
      );
    } finally {
      clearInterval(heartbeat);
      // A run that was let go of may end after the task has been picked up again; leave that one's marks.
      if (this.active.get(taskId) === controller) {
        this.active.delete(taskId);
        this.lastActivity.delete(taskId);
        this.stalled.delete(taskId);
      }
    }
    const settled = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (settled && this.options.settled) await this.options.settled(owner, settled);
    if (settled && this.options.finished) await this.options.finished(owner, settled);
  }
}
