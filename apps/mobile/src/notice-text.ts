import type { AgentNotification } from "../../../packages/domain/src/agent";

/** What a notice is about: a person naming you, the agent answering or finishing for you, or the workspace's own news. */
export type NoticeKind = "mention" | "agent" | "update";
export type NoticeTab = "all" | NoticeKind;

export const noticeKind = (
  note: Pick<AgentNotification, "channelId" | "taskId" | "by" | "byName">,
): NoticeKind =>
  note.channelId && (note.by || note.byName)
    ? "mention"
    : note.channelId || note.taskId
      ? "agent"
      : "update";

export const noticeTabs: { id: NoticeTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mention", label: "Mentions" },
  { id: "agent", label: "Hive" },
  { id: "update", label: "Updates" },
];

/** Newest first. */
export const newestFirst = <T extends { createdAt: string }>(notes: T[]): T[] =>
  [...notes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** The notices a tab and the unread switch show. */
export function noticesFor(
  notes: AgentNotification[],
  tab: NoticeTab,
  unreadOnly: boolean,
): AgentNotification[] {
  return newestFirst(notes).filter(
    (note) => (tab === "all" || noticeKind(note) === tab) && (!unreadOnly || !note.read),
  );
}

/** How many are unread in each tab, for the number beside its name. */
export function unreadCounts(notes: AgentNotification[]): Record<NoticeTab, number> {
  const counts: Record<NoticeTab, number> = { all: 0, mention: 0, agent: 0, update: 0 };
  for (const note of notes) {
    if (note.read) continue;
    counts.all++;
    counts[noticeKind(note)]++;
  }
  return counts;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** The heading of the day a notice is from: Today, Yesterday, or the date. */
export function dayLabel(iso: string, now = new Date()): string {
  const day = new Date(iso);
  if (Number.isNaN(day.getTime())) return "Earlier";
  if (sameDay(day, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(day, yesterday)) return "Yesterday";
  return day.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Notices in groups by day, in the order they are given (newest first when they were sorted so). */
export function groupByDay(
  notes: AgentNotification[],
  now = new Date(),
): { label: string; notes: AgentNotification[] }[] {
  const groups: { label: string; notes: AgentNotification[] }[] = [];
  for (const note of notes) {
    const label = dayLabel(note.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.notes.push(note);
    else groups.push({ label, notes: [note] });
  }
  return groups;
}

/** The name to put beside a notice: who it is from, if a person, else nothing. */
export const noticeFrom = (note: Pick<AgentNotification, "byName" | "by">): string =>
  note.byName || note.by || "";

/** What opening a notice does, in words for its button. */
export const noticeAction = (
  note: Pick<AgentNotification, "channelId" | "taskId" | "target">,
): string =>
  note.target === "agent-activity"
    ? "View agent activity"
    : note.taskId
      ? "View task"
      : note.channelId
        ? "Open channel"
        : "";
