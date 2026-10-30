import {
  type AgentTask,
  type TaskColumn,
  type TaskStatus,
  taskColumn,
} from "../../../packages/domain/src/agent";

/** The agent has stopped for a person: to approve a prepared action, to answer, or to review its work. */
export function needsYou(status: TaskStatus): boolean {
  return status === "waiting_approval" || status === "waiting_input" || status === "in_review";
}

/**
 * One board column, with the cards that need a person on top and the one that has waited longest
 * first. The rest keep the order they came in.
 */
export function orderColumn<T extends Pick<AgentTask, "status" | "updatedAt">>(tasks: T[]): T[] {
  const waiting = tasks
    .filter((task) => needsYou(task.status))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || 0);
  return [...waiting, ...tasks.filter((task) => !needsYou(task.status))];
}

/** How long a run has gone on: `2:14` up to an hour, then `1h 05m`, then `2d 3h`. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * When the run that is going on began, in milliseconds. The workspace records it when the agent
 * picks the task up. A workspace made before it did leaves it out, and then all that is known is
 * when this screen saw the task start (`seen`), if it did.
 */
export function runStartedAt(
  task: Pick<AgentTask, "runStartedAt">,
  seen?: number,
): number | undefined {
  const recorded = task.runStartedAt ? Date.parse(task.runStartedAt) : Number.NaN;
  return Number.isFinite(recorded) ? recorded : seen;
}

/**
 * Notices the moment a task starts running while the screen is watching. A task that was already
 * running when the screen opened is not given a time, since the time would be wrong.
 */
export function watchRuns() {
  const last = new Map<string, TaskStatus>();
  const began = new Map<string, number>();
  return (tasks: Pick<AgentTask, "id" | "status">[], now: number): ReadonlyMap<string, number> => {
    for (const task of tasks) {
      const before = last.get(task.id);
      if (task.status !== "running") began.delete(task.id);
      else if (before !== undefined && before !== "running" && !began.has(task.id))
        began.set(task.id, now);
      last.set(task.id, task.status);
    }
    return began;
  };
}

/** The status a manual issue takes when it is dropped in a board column. */
export function statusForColumn(column: TaskColumn): TaskStatus {
  switch (column) {
    case "doing":
      return "running";
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

/**
 * Where dropping a card in a column takes it, if it takes it anywhere. Only a manual issue is moved by hand: an
 * agent task is where the agent has it, and a card dropped in the column it is in stays.
 */
export function moveTarget(
  task: Pick<AgentTask, "kind" | "status">,
  column: TaskColumn,
): TaskStatus | null {
  if (task.kind !== "manual" || taskColumn(task.status) === column) return null;
  return statusForColumn(column);
}
