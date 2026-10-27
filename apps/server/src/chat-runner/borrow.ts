import type { AgentTask, RunEvent } from "../../../../packages/domain/src/agent.ts";
import type {
  RoomFrame,
  RunnerFrame,
  TaskLease,
  TaskStart,
} from "../../../../packages/domain/src/chat-agent.ts";
import { LostLeaseError, type TaskContext } from "../engine/worker.ts";

type EndFrame = Extract<RunnerFrame, { t: "task.end" }>;

export interface BorrowDeps {
  /** The connection to the chat service; this says only what a frame says. */
  send: (frame: RunnerFrame) => boolean;
  /** Works the task as the worker did: the same handler, over the copy of it the room gave. */
  run: (owner: string, task: AgentTask, context: TaskContext) => Promise<Partial<AgentTask>>;
  /** Writes down what the run did, on this machine. */
  event: (
    owner: string,
    taskId: string,
    kind: RunEvent["kind"],
    title: string,
    detail: string,
  ) => Promise<void>;
  /** Tasks it works on at once. */
  maxTasks?: number;
  /** The least between two reports of progress; what comes between is joined into the next. */
  checkpointEveryMs?: number;
  beatEveryMs?: number;
  log?: (line: string) => void;
}

interface Active {
  start: TaskStart;
  owner: string;
  /** The task as the run sees it: what the room gave, with its own progress laid over. */
  task: AgentTask;
  controller: AbortController;
  /** Progress not yet reported. */
  pending: Record<string, unknown>;
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The room let go of it (paused, cancelled, or the lease is not ours any more): nothing more is said of it. */
  dropped: boolean;
}

const lay = <T extends object>(base: T, patch: Record<string, unknown>): T => {
  const next = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
};

/**
 * Tasks the room lends this machine. The room holds the task; the machine is given one under a lease,
 * works it with the same code the worker used (it is handed a copy), tells the room how far it gets, and
 * gives it back with how it ended. It keeps nothing of a task when it restarts: the room is told by the
 * next hello which it still holds, and cuts off the rest.
 */
export class TaskBorrower {
  private readonly held = new Map<string, Active>();
  /** How tasks ended, kept until the room confirms them. */
  private readonly finals = new Map<string, EndFrame>();
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: BorrowDeps) {}

  private log(line: string) {
    this.deps.log?.(`[chat-runner] ${line}`);
  }

  get active(): number {
    return this.held.size;
  }

  /** What it holds, for the hello: tasks being worked, and tasks done whose end the room has not confirmed. */
  leases(): TaskLease[] {
    return [
      ...[...this.held.values()].map((a) => ({
        taskId: a.task.id,
        leaseId: a.start.leaseId,
      })),
      ...[...this.finals.values()].map((f) => ({ taskId: f.taskId, leaseId: f.leaseId })),
    ];
  }

  /** The connection is open again: say again how tasks ended that the room has not confirmed. */
  onOpen() {
    for (const frame of this.finals.values()) this.deps.send(frame);
  }

  onFrame(frame: RoomFrame) {
    switch (frame.t) {
      case "welcome": {
        const keep = new Set(frame.resumeTasks ?? []);
        for (const a of this.held.values()) if (!keep.has(a.start.leaseId)) this.letGo(a);
        return;
      }
      case "task.start":
        void this.start(frame.start).catch((error) =>
          this.log(`could not start task ${frame.start.task.id}: ${String(error)}`),
        );
        return;
      case "task.stop": {
        const a = this.held.get(frame.taskId);
        if (a && a.start.leaseId === frame.leaseId) this.letGo(a);
        return;
      }
      case "task.ended":
        if (this.finals.get(frame.taskId)?.leaseId === frame.leaseId)
          this.finals.delete(frame.taskId);
        return;
      default:
        return;
    }
  }

  stop() {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    for (const a of this.held.values()) this.letGo(a);
  }

  /** The room no longer wants it: the run is stopped and nothing more is said of it. */
  private letGo(a: Active) {
    a.dropped = true;
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
    a.controller.abort();
  }

  private beating() {
    if (this.beat || this.held.size === 0) return;
    this.beat = setInterval(() => {
      if (this.held.size === 0) {
        if (this.beat) clearInterval(this.beat);
        this.beat = null;
        return;
      }
      this.deps.send({ t: "beat", runIds: [], tasks: this.leases().slice(0, 16) });
    }, this.deps.beatEveryMs ?? 15_000);
    (this.beat as unknown as { unref?: () => void }).unref?.();
  }

  private async start(start: TaskStart) {
    const { task, leaseId } = start;
    const known = this.held.get(task.id);
    if (known?.start.leaseId === leaseId) {
      // Given again (the room asked twice): it is being worked on.
      this.deps.send({ t: "task.ack", taskId: task.id, leaseId });
      return;
    }
    const finished = this.finals.get(task.id);
    if (finished?.leaseId === leaseId) {
      this.deps.send(finished);
      return;
    }
    // The room took the task from an earlier run (it went quiet) and gave it out again: that run is let go of.
    if (known) this.letGo(known);
    this.deps.send({ t: "task.ack", taskId: task.id, leaseId });
    if (this.held.size - (known ? 1 : 0) >= (this.deps.maxTasks ?? 3)) {
      this.finish({ start, owner: start.owner.id, task } as Active, { requeue: true });
      return;
    }
    const a: Active = {
      start,
      owner: start.owner.id,
      task,
      controller: new AbortController(),
      pending: {},
      lastSent: 0,
      timer: null,
      dropped: false,
    };
    this.held.set(task.id, a);
    this.beating();
    try {
      const result = await this.deps.run(a.owner, a.task, this.contextOf(a));
      this.finish(a, { patch: { ...result, interruptedAt: null, interruptions: 0 } });
    } catch (error) {
      if (a.dropped) return this.forget(a);
      if (error instanceof LostLeaseError || a.controller.signal.aborted)
        this.finish(a, { requeue: true });
      else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        await this.deps
          .event(a.owner, task.id, "error", "Task needs attention", detail)
          .catch(() => undefined);
        this.finish(a, { patch: { status: "failed", error: detail } });
      }
    }
  }

  private contextOf(a: Active): TaskContext {
    const guard = async () => {
      if (a.dropped || a.controller.signal.aborted) throw new LostLeaseError();
    };
    return {
      signal: a.controller.signal,
      guard,
      checkpoint: async (patch) => {
        await guard();
        a.task = lay(a.task, { ...patch, updatedAt: new Date().toISOString() });
        a.pending = { ...a.pending, ...patch };
        this.flush(a);
        return a.task;
      },
      event: async (kind, title, detail = "") => {
        await guard();
        await this.deps.event(a.owner, a.task.id, kind, title, detail);
      },
    };
  }

  /** Report progress, at most every so often; what comes between is joined into one report. */
  private flush(a: Active) {
    if (a.dropped || Object.keys(a.pending).length === 0 || a.timer) return;
    const every = this.deps.checkpointEveryMs ?? 2_000;
    const wait = a.lastSent + every - Date.now();
    const send = () => {
      a.timer = null;
      if (a.dropped || Object.keys(a.pending).length === 0) return;
      const patch = a.pending;
      a.pending = {};
      a.lastSent = Date.now();
      this.deps.send({
        t: "task.checkpoint",
        taskId: a.task.id,
        leaseId: a.start.leaseId,
        patch,
      });
    };
    if (wait <= 0) return send();
    a.timer = setTimeout(send, wait);
    (a.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Give the task back, with how it ended; said again until the room has it. */
  private finish(a: Active, how: { patch?: Record<string, unknown>; requeue?: boolean }) {
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
    const frame: EndFrame = {
      t: "task.end",
      taskId: a.task.id,
      leaseId: a.start.leaseId,
      patch: how.requeue ? {} : { ...a.pending, ...(how.patch ?? {}) },
      ...(how.requeue ? { requeue: true } : {}),
    };
    this.forget(a);
    this.finals.set(a.task.id, frame);
    this.deps.send(frame);
  }

  private forget(a: Active) {
    if (this.held.get(a.task.id) === a) this.held.delete(a.task.id);
  }
}
