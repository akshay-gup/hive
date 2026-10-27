import type { AgentTask, Project } from "../../domain/src/agent.ts";
import { first, type Sql } from "./sql.ts";

/** How tasks are held out to the machine: how long one may go unheard of, and how often a cut-off one is tried again. */
export const TASK_LIMITS = {
  /** A task the machine holds that has not been heard of for this long is thought lost. */
  beatStaleMs: 90_000,
  /** Runs in a row that may be cut off before the task is stopped. */
  maxInterruptions: 3,
  /** Tasks the machine works on at once, unless it says. */
  defaultMaxTasks: 3,
  /** The most a machine's report of progress may weigh. */
  maxPatchBytes: 200_000,
} as const;

interface Row {
  id: string;
  project_id: string | null;
  created_by: string;
  kind: AgentTask["kind"];
  status: AgentTask["status"];
  next_run_ms: number | null;
  lease_id: string | null;
  acked: number;
  lease_ms: number | null;
  attempts: number;
  interruptions: number;
  created_ms: number;
  updated_ms: number;
  data: string;
}

/** What a task keeps in its columns rather than in `data`: the room decides with these. */
const COLUMNS = new Set([
  "id",
  "projectId",
  "createdBy",
  "kind",
  "status",
  "nextRunAt",
  "leaseId",
  "leaseUntil",
  "attempts",
  "interruptions",
  "createdAt",
  "updatedAt",
]);

const iso = (ms: number | null) => (ms === null ? undefined : new Date(ms).toISOString());

const toTask = (row: Row): AgentTask => {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    ...data,
    id: row.id,
    kind: row.kind,
    status: row.status,
    projectId: row.project_id,
    createdBy: row.created_by,
    attempts: row.attempts,
    interruptions: row.interruptions,
    createdAt: new Date(row.created_ms).toISOString(),
    updatedAt: new Date(row.updated_ms).toISOString(),
    ...(row.next_run_ms !== null ? { nextRunAt: iso(row.next_run_ms) } : {}),
    leaseId: row.lease_id,
    leaseUntil: iso(row.lease_ms),
  } as AgentTask;
};

/** A patch laid over what the task keeps: a field set to null is taken away. */
const lay = (data: Record<string, unknown>, patch: Record<string, unknown>) => {
  const next = { ...data };
  for (const [key, value] of Object.entries(patch)) {
    if (COLUMNS.has(key)) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};

/** Statuses a task the worker takes may be in: it is waiting for the machine. */
const DUE = "(status = 'queued' OR (status = 'scheduled' AND next_run_ms <= ?))";

/**
 * The workspace's tasks, as rows, and what the machine may do with one it holds. A task is held out to the
 * machine under a lease: `claim` gives one out, `ack` says the machine took it, `beat` keeps it, and
 * `checkpoint` and `end` are taken only from the holder of the lease that is current. Whatever a machine
 * says after its lease is gone is dropped, which is what lets a cut-off task be given to another run.
 */
export class Tasks {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  get(id: string): AgentTask | null {
    const row = first<Row>(this.sql, "SELECT * FROM tasks WHERE id = ?", id);
    return row ? toTask(row) : null;
  }

  /** The task made for this key, if there is one: asking twice for the same thing makes it once. */
  byKey(key: string): AgentTask | null {
    const row = first<Row>(this.sql, "SELECT * FROM tasks WHERE idem = ?", key);
    return row ? toTask(row) : null;
  }

  create(
    task: Pick<AgentTask, "id" | "kind" | "status" | "createdBy"> & Partial<AgentTask>,
    key?: string,
  ): AgentTask {
    const now = this.clock();
    const { id, kind, status, createdBy, projectId, nextRunAt, ...rest } = task;
    this.sql.run(
      `INSERT INTO tasks (id, project_id, created_by, kind, status, next_run_ms, created_ms, updated_ms, idem, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId ?? null,
      createdBy ?? "",
      kind,
      status,
      nextRunAt ? Date.parse(nextRunAt) : null,
      now,
      now,
      key ?? null,
      JSON.stringify(lay({}, rest as Record<string, unknown>)),
    );
    return this.get(id) as AgentTask;
  }

  all(): AgentTask[] {
    return this.sql.all<Row>("SELECT * FROM tasks ORDER BY created_ms, id").map(toTask);
  }

  /**
   * Change a task: `change` is laid over it (or worked out from it, inside the step), and the columns that
   * decide things (status, project, when it is due) are set from it. With `expect`, only if the task still
   * has that status and lease, so a change made from an old read is refused. A lease set to null is let go.
   */
  change(
    id: string,
    change: Partial<AgentTask> | ((current: AgentTask) => Partial<AgentTask>),
    expect?: { status: AgentTask["status"]; leaseId: string | null },
  ): AgentTask | null {
    return this.sql.transaction(() => {
      const row = first<Row>(this.sql, "SELECT * FROM tasks WHERE id = ?", id);
      if (!row) return null;
      if (expect && (row.status !== expect.status || (row.lease_id ?? null) !== expect.leaseId))
        return null;
      const patch = typeof change === "function" ? change(toTask(row)) : change;
      const now = this.clock();
      const release = "leaseId" in patch && patch.leaseId === null ? 1 : 0;
      const nextRun =
        "nextRunAt" in patch
          ? patch.nextRunAt
            ? Date.parse(patch.nextRunAt)
            : null
          : row.next_run_ms;
      this.sql.run(
        `UPDATE tasks SET status = ?, project_id = ?, kind = ?, next_run_ms = ?, updated_ms = ?, data = ?,
           lease_id = CASE WHEN ? THEN NULL ELSE lease_id END,
           acked = CASE WHEN ? THEN 0 ELSE acked END,
           lease_ms = CASE WHEN ? THEN NULL ELSE lease_ms END WHERE id = ?`,
        patch.status ?? row.status,
        "projectId" in patch ? (patch.projectId ?? null) : row.project_id,
        patch.kind ?? row.kind,
        nextRun,
        now,
        JSON.stringify(lay(JSON.parse(row.data), patch as Record<string, unknown>)),
        release,
        release,
        release,
        id,
      );
      return this.get(id);
    });
  }

  remove(id: string): void {
    this.sql.run("DELETE FROM tasks WHERE id = ?", id);
  }

  /** How many tasks the machine holds (given out, or running). */
  inHand(): number {
    return (
      first<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM tasks WHERE lease_id IS NOT NULL")
        ?.n ?? 0
    );
  }

  /** The oldest task that is due and not held, that is agent work. */
  nextDue(): AgentTask | null {
    const row = first<Row>(
      this.sql,
      `SELECT * FROM tasks WHERE lease_id IS NULL AND kind != 'manual' AND ${DUE} ORDER BY created_ms, id LIMIT 1`,
      this.clock(),
    );
    return row ? toTask(row) : null;
  }

  hasDue(): boolean {
    return this.nextDue() !== null;
  }

  /** When the next scheduled task is due, if it is not already. */
  nextScheduledMs(): number | null {
    return (
      first<{ at: number | null }>(
        this.sql,
        "SELECT MIN(next_run_ms) AS at FROM tasks WHERE lease_id IS NULL AND status = 'scheduled' AND kind != 'manual'",
      )?.at ?? null
    );
  }

  /** Give the task out under a new lease. Null if it is not due or someone holds it. */
  claim(id: string, leaseId: string): AgentTask | null {
    const now = this.clock();
    const changed = this.sql.run(
      `UPDATE tasks SET status = 'running', lease_id = ?, acked = 0, lease_ms = ?, attempts = attempts + 1, updated_ms = ?
       WHERE id = ? AND lease_id IS NULL AND kind != 'manual' AND ${DUE}`,
      leaseId,
      now,
      now,
      id,
      now,
    );
    return changed > 0 ? this.get(id) : null;
  }

  /** The leases the machine has been given, to be compared with what it says it holds. */
  leased(): { id: string; leaseId: string; acked: boolean }[] {
    return this.sql
      .all<{ id: string; lease_id: string; acked: number }>(
        "SELECT id, lease_id, acked FROM tasks WHERE lease_id IS NOT NULL",
      )
      .map((r) => ({ id: r.id, leaseId: r.lease_id, acked: r.acked > 0 }));
  }

  /** The machine has taken it. False if the lease is not the current one. */
  ack(id: string, leaseId: string): boolean {
    return (
      this.sql.run(
        "UPDATE tasks SET acked = 1, lease_ms = ? WHERE id = ? AND lease_id = ?",
        this.clock(),
        id,
        leaseId,
      ) > 0
    );
  }

  beat(leases: { taskId: string; leaseId: string }[]): void {
    const now = this.clock();
    for (const l of leases)
      this.sql.run(
        "UPDATE tasks SET lease_ms = ? WHERE id = ? AND lease_id = ?",
        now,
        l.taskId,
        l.leaseId,
      );
  }

  /** Progress from the holder of the lease. Null if the lease is not the current one. */
  checkpoint(id: string, leaseId: string, patch: Record<string, unknown>): AgentTask | null {
    return this.sql.transaction(() => {
      const row = first<Row>(
        this.sql,
        "SELECT * FROM tasks WHERE id = ? AND lease_id = ? AND status = 'running'",
        id,
        leaseId,
      );
      if (!row) return null;
      const now = this.clock();
      this.sql.run(
        "UPDATE tasks SET data = ?, lease_ms = ?, updated_ms = ? WHERE id = ?",
        JSON.stringify(lay(JSON.parse(row.data), patch)),
        now,
        now,
        id,
      );
      return this.get(id);
    });
  }

  /**
   * The holder is done. `patch` says how it ended (its status among it); a task is never put back to running
   * this way. With `requeue` it was cut off and goes back in the queue to carry on, without a mark against it.
   */
  end(
    id: string,
    leaseId: string,
    patch: Record<string, unknown>,
    options: { requeue?: boolean; stalled?: boolean } = {},
  ): AgentTask | null {
    return this.sql.transaction(() => {
      const row = first<Row>(
        this.sql,
        "SELECT * FROM tasks WHERE id = ? AND lease_id = ? AND status = 'running'",
        id,
        leaseId,
      );
      if (!row) return null;
      const now = this.clock();
      const status = options.requeue ? "queued" : String(patch.status ?? "failed");
      const nextRun = typeof patch.nextRunAt === "string" ? Date.parse(patch.nextRunAt) : null;
      this.sql.run(
        `UPDATE tasks SET status = ?, lease_id = NULL, acked = 0, lease_ms = NULL, updated_ms = ?, data = ?,
           next_run_ms = ?, interruptions = ? WHERE id = ?`,
        status === "running" ? "queued" : status,
        now,
        JSON.stringify(lay(JSON.parse(row.data), options.requeue ? {} : patch)),
        options.requeue ? row.next_run_ms : nextRun,
        options.requeue
          ? row.interruptions + (options.stalled ? 1 : 0)
          : "interruptions" in patch
            ? Number(patch.interruptions) || 0
            : 0,
        id,
      );
      return this.get(id);
    });
  }

  /**
   * The machine lost the task (it restarted, or went quiet): back in the queue with a mark against it, or
   * stopped once cut off too many times in a row. Returns what became of it.
   */
  interrupt(id: string, leaseId: string): "requeued" | "failed" | null {
    return this.sql.transaction(() => {
      const row = first<Row>(
        this.sql,
        "SELECT * FROM tasks WHERE id = ? AND lease_id = ? AND status = 'running'",
        id,
        leaseId,
      );
      if (!row) return null;
      const now = this.clock();
      const cut = row.interruptions + 1;
      const failed = cut > TASK_LIMITS.maxInterruptions;
      const data = lay(
        JSON.parse(row.data),
        failed
          ? {
              error: `Stopped after being cut off ${cut - 1} times in a row. Look at what it did, then send it back to try again.`,
            }
          : {},
      );
      this.sql.run(
        `UPDATE tasks SET status = ?, lease_id = NULL, acked = 0, lease_ms = NULL, interruptions = ?, updated_ms = ?, data = ? WHERE id = ?`,
        failed ? "failed" : "queued",
        cut,
        now,
        JSON.stringify({ ...data, interruptedAt: new Date(now).toISOString() }),
        id,
      );
      return failed ? "failed" : "requeued";
    });
  }

  /** A task given out and not taken goes back to wait for the next. */
  requeueUnacked(): void {
    this.sql.run(
      "UPDATE tasks SET status = 'queued', lease_id = NULL, lease_ms = NULL, attempts = attempts - 1 WHERE lease_id IS NOT NULL AND acked = 0",
    );
  }

  /** Held tasks not heard of for a while. */
  quiet(graceMs = 0): { id: string; leaseId: string; acked: boolean }[] {
    const before = this.clock() - TASK_LIMITS.beatStaleMs - graceMs;
    return this.sql
      .all<{ id: string; lease_id: string; acked: number }>(
        "SELECT id, lease_id, acked FROM tasks WHERE lease_id IS NOT NULL AND lease_ms < ?",
        before,
      )
      .map((r) => ({ id: r.id, leaseId: r.lease_id, acked: r.acked > 0 }));
  }

  hasActive(): boolean {
    return first(this.sql, "SELECT 1 FROM tasks WHERE lease_id IS NOT NULL LIMIT 1") !== undefined;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  access: string;
  created_by: string | null;
  created_ms: number;
  updated_ms: number;
  data: string;
}

const toProject = (row: ProjectRow): Project => {
  const data = JSON.parse(row.data) as { description?: string; members?: Project["members"] };
  return {
    id: row.id,
    name: row.name,
    access: row.access as Project["access"],
    createdAt: new Date(row.created_ms).toISOString(),
    updatedAt: new Date(row.updated_ms).toISOString(),
    members: data.members ?? [],
    ...(data.description ? { description: data.description } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
  };
};

/** The workspace's projects, as rows. Who may see one is decided by `access.ts`, not here. */
export class Projects {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  get(id: string): Project | null {
    const row = first<ProjectRow>(this.sql, "SELECT * FROM projects WHERE id = ?", id);
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return this.sql
      .all<ProjectRow>("SELECT * FROM projects ORDER BY created_ms, id")
      .map(toProject);
  }

  /** Keep a project: made if it is new, changed if it is not. */
  put(project: Project): Project {
    const now = this.clock();
    const data = JSON.stringify({
      ...(project.description ? { description: project.description } : {}),
      members: project.members ?? [],
    });
    const changed = this.sql.run(
      "UPDATE projects SET name = ?, access = ?, updated_ms = ?, data = ? WHERE id = ?",
      project.name,
      project.access ?? "open",
      now,
      data,
      project.id,
    );
    if (changed === 0)
      this.sql.run(
        "INSERT INTO projects (id, name, access, created_by, created_ms, updated_ms, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        project.id,
        project.name,
        project.access ?? "open",
        project.createdBy ?? null,
        now,
        now,
        data,
      );
    return this.get(project.id) as Project;
  }

  remove(id: string): void {
    this.sql.run("DELETE FROM projects WHERE id = ?", id);
  }
}
