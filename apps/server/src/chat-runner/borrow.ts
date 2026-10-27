import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type {
  RoomFrame,
  RunnerFrame,
  TaskLease,
  TaskStart,
} from "../../../../packages/domain/src/chat-agent.ts";

type EndFrame = Extract<RunnerFrame, { t: "task.end" }>;

/** What the machine keeps for a task while it holds it, and what runs it. */
export interface BorrowDeps {
  /** The connection to the chat service; this says only what a frame says. */
  send: (frame: RunnerFrame) => boolean;
  /** The machine's copy of a task: the worker runs the copy, and it is gone when the task is given back. */
  copies: {
    get(owner: string, id: string): Promise<AgentTask | null>;
    put(owner: string, task: AgentTask): Promise<void>;
    remove(owner: string, id: string): Promise<void>;
    /** Add notes people wrote while it ran, for the agent to be told of. */
    addNotes(owner: string, id: string, notes: NonNullable<AgentTask["notes"]>): Promise<void>;
  };
  /** The person the task is for, and the channel it is kept in the folder of, made known here before it runs. */
  prepare: (start: TaskStart) => Promise<void>;
  /** Runs what is waiting in the machine's copies (the worker), now rather than at its next tick. */
  run: () => void;
  /** Stops a run of the worker's. */
  abort: (taskId: string) => void;
  /** Tasks it works on at once. */
  maxTasks?: number;
  /** How often it looks for progress to report. */
  syncEveryMs?: number;
  beatEveryMs?: number;
  log?: (line: string) => void;
}

interface Active {
  start: TaskStart;
  owner: string;
  /** What the room was last told of the run's own fields, to say only what changed. */
  told: Map<string, string>;
  timer: ReturnType<typeof setInterval>;
  /** The room let go of it (paused, cancelled, or the lease is not ours any more): nothing more is said of it. */
  dropped: boolean;
}

/** What a run writes of its task, and so what the room is told of. The rest is people's and stays the room's. */
const RUN_FIELDS = [
  "state",
  "plan",
  "evidence",
  "artifactIds",
  "actionId",
  "result",
  "error",
  "question",
  "nextRunAt",
  "interruptedAt",
  "interruptions",
  "runStartedAt",
] as const;

/** How a run can leave a task for good (for now): any other status means the worker has it again. */
const ENDED = new Set([
  "succeeded",
  "failed",
  "in_review",
  "waiting_approval",
  "waiting_input",
  "scheduled",
  "paused",
  "cancelled",
]);

/**
 * Tasks the room lends this machine. The room holds the task; the machine is given one under a lease, keeps
 * a copy while it works it (the worker runs the copy, as it always ran tasks), tells the room how far it
 * gets, and gives it back with how it ended. It keeps nothing of a task when it restarts: the room is told
 * by the next hello which it still holds, and cuts off the rest.
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
        taskId: a.start.task.id,
        leaseId: a.start.leaseId,
      })),
      ...[...this.finals.values()].map((f) => ({ taskId: f.taskId, leaseId: f.leaseId })),
    ].slice(0, 16);
  }

  /** The connection is open again: say again how tasks ended that the room has not confirmed. */
  onOpen() {
    for (const frame of this.finals.values()) this.deps.send(frame);
  }

  onFrame(frame: RoomFrame) {
    switch (frame.t) {
      case "welcome": {
        const keep = new Set(frame.resumeTasks ?? []);
        for (const a of [...this.held.values()]) if (!keep.has(a.start.leaseId)) void this.letGo(a);
        return;
      }
      case "task.start":
        void this.start(frame.start).catch((error) =>
          this.log(`could not start task ${frame.start.task.id}: ${String(error)}`),
        );
        return;
      case "task.note": {
        const a = this.held.get(frame.taskId);
        if (a && a.start.leaseId === frame.leaseId && !a.dropped)
          void this.deps.copies
            .addNotes(a.owner, frame.taskId, frame.notes)
            .catch((error) => this.log(`could not pass on a note: ${String(error)}`));
        return;
      }
      case "task.stop": {
        const a = this.held.get(frame.taskId);
        if (a && a.start.leaseId === frame.leaseId) void this.letGo(a);
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
    for (const a of [...this.held.values()]) void this.letGo(a);
  }

  /** The room no longer wants it: the run is stopped, the copy goes, and nothing more is said of it. */
  private async letGo(a: Active) {
    a.dropped = true;
    clearInterval(a.timer);
    if (this.held.get(a.start.task.id) === a) this.held.delete(a.start.task.id);
    this.deps.abort(a.start.task.id);
    await this.deps.copies.remove(a.owner, a.start.task.id).catch(() => undefined);
  }

  private beating() {
    if (this.beat || this.held.size === 0) return;
    this.beat = setInterval(() => {
      if (this.held.size === 0) {
        if (this.beat) clearInterval(this.beat);
        this.beat = null;
        return;
      }
      this.deps.send({ t: "beat", runIds: [], tasks: this.leases() });
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
    if (known) await this.letGo(known);
    this.deps.send({ t: "task.ack", taskId: task.id, leaseId });
    if (this.held.size >= (this.deps.maxTasks ?? 3)) {
      this.give({ taskId: task.id, leaseId, patch: {}, requeue: true });
      return;
    }
    const owner = start.owner.id;
    await this.deps.prepare(start);
    // The copy is what the worker runs: waiting, with the run's marks as the room has them.
    await this.deps.copies.put(owner, {
      ...task,
      status: "queued",
      leaseId: null,
      leaseUntil: null,
      attempts: Math.max(0, task.attempts - 1),
    });
    const a: Active = {
      start,
      owner,
      told: new Map(RUN_FIELDS.map((k) => [k, JSON.stringify(task[k] ?? null)])),
      timer: setInterval(() => void this.sync(a), this.deps.syncEveryMs ?? 2_000),
      dropped: false,
    };
    (a.timer as unknown as { unref?: () => void }).unref?.();
    this.held.set(task.id, a);
    this.beating();
    this.deps.run();
  }

  /** The run's own fields that changed in the copy since the room was told. */
  private changed(a: Active, copy: AgentTask) {
    const patch: Record<string, unknown> = {};
    for (const key of RUN_FIELDS) {
      const value = copy[key] ?? null;
      if (a.told.get(key) !== JSON.stringify(value)) patch[key] = value;
    }
    // Which notes the agent has read, for the room to mark; it never takes notes from the machine.
    const read = (copy.notes ?? [])
      .filter((n) => n.delivered)
      .map((n) => ({ id: n.id, delivered: true }));
    if (JSON.stringify(read) !== (a.told.get("notes") ?? "[]")) patch.notes = read;
    return patch;
  }

  private remember(a: Active, patch: Record<string, unknown>) {
    for (const [key, value] of Object.entries(patch))
      a.told.set(key, JSON.stringify(key === "notes" ? value : (value ?? null)));
  }

  /** Report progress. */
  private async sync(a: Active) {
    if (a.dropped) return;
    const copy = await this.deps.copies.get(a.owner, a.start.task.id).catch(() => null);
    if (!copy || a.dropped) return;
    const patch = this.changed(a, copy);
    if (Object.keys(patch).length === 0) return;
    this.remember(a, patch);
    this.deps.send({
      t: "task.checkpoint",
      taskId: a.start.task.id,
      leaseId: a.start.leaseId,
      patch,
    });
  }

  /**
   * The worker is done with the copy. If it ended the task (or needs a person), the task is given back with
   * how it ended; if the worker put it back in the queue (it was cut off), it is run again from the copy.
   */
  async finished(owner: string, copy: AgentTask) {
    const a = this.held.get(copy.id);
    if (!a || a.dropped || a.owner !== owner) return;
    if (!ENDED.has(copy.status)) {
      this.deps.run();
      return;
    }
    const patch = { ...this.changed(a, copy), status: copy.status };
    this.give({ taskId: copy.id, leaseId: a.start.leaseId, patch });
    clearInterval(a.timer);
    this.held.delete(copy.id);
    await this.deps.copies.remove(owner, copy.id).catch(() => undefined);
  }

  /** Give the task back, with how it ended; said again until the room has it. */
  private give(end: Omit<EndFrame, "t">) {
    const frame: EndFrame = { t: "task.end", ...end };
    this.finals.set(end.taskId, frame);
    this.deps.send(frame);
  }
}
