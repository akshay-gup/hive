import type { AgentTask } from "../../../packages/domain/src/agent";
import { needsYou } from "./board-order";

/** Where a task sits in the list: what needs a person first, then what is moving, then the rest. */
export type TaskGroupId = "needs" | "running" | "todo" | "failed" | "done";

export const taskGroups: { id: TaskGroupId; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "todo", label: "To do" },
  { id: "failed", label: "Failed" },
  { id: "done", label: "Done" },
];

export function taskGroup(task: Pick<AgentTask, "status" | "kind">): TaskGroupId {
  if (task.kind !== "manual" && needsYou(task.status)) return "needs";
  if (task.status === "running") return "running";
  if (task.status === "failed") return "failed";
  if (task.status === "succeeded" || task.status === "cancelled") return "done";
  return "todo";
}

const dayOf = (value: string | null | undefined): number =>
  value ? Date.parse(`${value}T00:00:00Z`) : Number.POSITIVE_INFINITY;

/**
 * Tasks in groups, empty groups left out. What waits for a person is in the order it has waited
 * (longest first); the rest by due date, then by what changed last.
 */
export function groupTasks<T extends AgentTask>(
  tasks: T[],
): { id: TaskGroupId; label: string; tasks: T[] }[] {
  return taskGroups
    .map((group) => {
      const members = tasks.filter((task) => taskGroup(task) === group.id);
      members.sort((a, b) =>
        group.id === "needs"
          ? Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
          : dayOf(a.dueAt) - dayOf(b.dueAt) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
      return { ...group, tasks: members };
    })
    .filter((group) => group.tasks.length > 0);
}

export const DAY_MS = 86_400_000;

/** The start of a day, in UTC, for a `yyyy-mm-dd` date. */
export const parseDay = (value: string): number => Date.parse(`${value}T00:00:00Z`);

/** Midnight (UTC) of the day `now` falls on in the person's own calendar. */
export function todayStart(now = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

const mondayOf = (ms: number): number => {
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return ms - weekday * DAY_MS;
};

export type TimelineScale = "weeks" | "months";

export interface TimelineWindow {
  /** The first day shown (a Monday), in milliseconds. */
  start: number;
  days: number;
  /** How many days from the start the chart is today. */
  today: number;
}

/** A task as the chart draws it: from a day to a day, or a single mark on its due day. */
export interface Placement {
  startOffset: number;
  endOffset: number;
  /** A task with only a due date is a diamond on that day, not a bar. */
  milestone: boolean;
}

/** Where a task falls on the calendar, by days from the first day shown; null when it has no dates. */
export function placeTask(
  task: Pick<AgentTask, "startAt" | "dueAt">,
  startMs: number,
): Placement | null {
  const start = task.startAt ? parseDay(task.startAt) : null;
  const due = task.dueAt ? parseDay(task.dueAt) : null;
  if (start === null && due === null) return null;
  if (start === null && due !== null)
    return {
      startOffset: Math.round((due - startMs) / DAY_MS),
      endOffset: Math.round((due - startMs) / DAY_MS),
      milestone: true,
    };
  const from = start as number;
  const to = Math.max(due ?? from, from);
  return {
    startOffset: Math.round((from - startMs) / DAY_MS),
    endOffset: Math.round((to - startMs) / DAY_MS),
    milestone: false,
  };
}

/**
 * The days a chart shows: from the Monday before the first thing (or a few days before today) to
 * a couple of weeks past the last (or past today), never more than half a year.
 */
export function timelineWindow(
  tasks: Pick<AgentTask, "startAt" | "dueAt">[],
  today: number,
  scale: TimelineScale,
): TimelineWindow {
  let first = today - 3 * DAY_MS;
  let last = today + (scale === "weeks" ? 21 : 56) * DAY_MS;
  for (const task of tasks) {
    for (const value of [task.startAt, task.dueAt]) {
      if (!value) continue;
      const ms = parseDay(value);
      if (Number.isNaN(ms)) continue;
      first = Math.min(first, ms - DAY_MS);
      last = Math.max(last, ms + 7 * DAY_MS);
    }
  }
  const start = mondayOf(first);
  const days = Math.min(182, Math.max(28, Math.ceil((last - start) / DAY_MS) + 1));
  return { start, days, today: Math.round((today - start) / DAY_MS) };
}

/** The pairs where one task waits on another that is also on the chart: from the first to the second. */
export function dependencyLinks(
  tasks: Pick<AgentTask, "id" | "blockedBy">[],
  placed: ReadonlySet<string>,
): { from: string; to: string }[] {
  const links: { from: string; to: string }[] = [];
  for (const task of tasks) {
    if (!placed.has(task.id)) continue;
    for (const before of task.blockedBy)
      if (placed.has(before)) links.push({ from: before, to: task.id });
  }
  return links;
}

export interface MonthSpan {
  label: string;
  /** Days from the first day shown, and how many. */
  offset: number;
  days: number;
}

/** The months the window passes through, for the labels along the top. */
export function monthSpans(window: TimelineWindow): MonthSpan[] {
  const spans: MonthSpan[] = [];
  for (let day = 0; day < window.days; day++) {
    const date = new Date(window.start + day * DAY_MS);
    const label = date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const last = spans[spans.length - 1];
    if (last?.label === label) last.days++;
    else spans.push({ label, offset: day, days: 1 });
  }
  return spans;
}
