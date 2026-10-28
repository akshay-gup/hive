import type { Entries } from "../../../packages/chat-core/src/entries.ts";
import type { EntryRules } from "../../../packages/chat-core/src/entry-rules.ts";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import type { ChatNotice } from "../../../packages/domain/src/chat.ts";

export const NOTICE = "notice";
/** The most notices kept for one person; the oldest that have been read go first. */
const KEEP = 300;

interface NoticeData {
  title: string;
  body: string;
  key: string;
  taskId?: string;
  read: boolean;
  dismissed: boolean;
}

export interface WorkNoticesDeps {
  entries: Entries;
  rules: EntryRules;
  /** Whether this person wants to hear of the agent's work. */
  wantsWork: (owner: string) => Promise<boolean>;
  /** Tell one person: their notices changed. */
  emit: (type: "notification.new" | "notification.changed", data: unknown, userId: string) => void;
}

/** What a task's coming to this state says to the person who started it, if it says anything. */
export function taskNotice(
  task: AgentTask,
  before: AgentTask | null,
): { title: string; body: string; key: string } | null {
  // A person's own to-do is not the agent's news.
  if (task.kind === "manual") return null;
  if (before?.status === task.status && before.attempts === task.attempts) return null;
  switch (task.status) {
    case "succeeded":
      return {
        title: task.title,
        body: task.result ?? "Work completed",
        key: `task-done:${task.id}`,
      };
    case "in_review":
      return {
        title: "Ready for your review",
        body: task.title,
        key: `task-review:${task.id}:${task.attempts}`,
      };
    case "failed":
      return {
        title: "Task needs attention",
        body: task.error ?? task.title,
        key: `task-error:${task.id}:${task.attempts}`,
      };
    case "waiting_input":
      return {
        title: "Your details are needed",
        body: task.question ?? task.title,
        key: `input:${task.id}:${(task.question ?? "").length}:${task.attempts}`,
      };
    case "waiting_approval":
      return {
        title: "Ready for your review",
        body: task.title,
        key: `review:${task.actionId ?? task.id}`,
      };
    default:
      return null;
  }
}

/**
 * The agent's news for a person, kept by the room (as entries of the kind "notice", the person's own) so it is
 * there whether or not the machine is, and no one else, an admin included, can read it. A notice is made
 * once for each key: it stays, dismissed, so the same news does not come again.
 */
export class WorkNotices {
  constructor(private readonly deps: WorkNoticesDeps) {}

  /** Tell a person. False if they have already been told this (the key is the same). */
  tell(
    userId: string,
    notice: { key: string; title: string; body: string; taskId?: string },
  ): boolean {
    const data: NoticeData = {
      title: notice.title.slice(0, 200),
      body: notice.body.slice(0, 2000),
      key: notice.key,
      ...(notice.taskId ? { taskId: notice.taskId } : {}),
      read: false,
      dismissed: false,
    };
    const { entry, made } = this.deps.entries.putIfAbsent({
      id: `notice:${userId}:${notice.key}`.slice(0, 200),
      kind: NOTICE,
      scope: { type: "person", id: userId },
      createdBy: userId,
      status: "active",
      data: data as never,
    });
    if (!made) return false;
    this.trim(userId);
    this.deps.emit("notification.new", { kind: "work", id: entry.id }, userId);
    return true;
  }

  /** Tell the person who started a task, if the task's news is something to tell. */
  taskChanged(task: AgentTask, before: AgentTask | null) {
    const notice = taskNotice(task, before);
    if (notice && task.createdBy) this.tell(task.createdBy, { ...notice, taskId: task.id });
  }

  /** What this person has been told, newest first, as the chat's notices are shown. */
  async list(owner: string, options: { unreadOnly?: boolean } = {}): Promise<ChatNotice[]> {
    if (!(await this.deps.wantsWork(owner))) return [];
    return this.deps.entries
      .inScope(NOTICE, { type: "person", id: owner })
      .map((entry) => ({ entry, data: entry.data as unknown as NoticeData }))
      .filter(({ data }) => !data.dismissed && !(options.unreadOnly && data.read))
      .map(({ entry, data }) => ({
        id: entry.id,
        kind: "work" as const,
        ...(data.taskId ? { taskId: data.taskId } : {}),
        title: data.title,
        body: data.body,
        createdAt: entry.createdAt,
        read: data.read,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Read, unread or dismiss some of a person's notices (all of them without ids). How many changed. */
  state(owner: string, action: "read" | "unread" | "dismiss", ids?: string[]): number {
    let changed = 0;
    for (const entry of this.deps.entries.inScope(NOTICE, { type: "person", id: owner })) {
      if (ids && !ids.includes(entry.id)) continue;
      const data = entry.data as unknown as NoticeData;
      const next =
        action === "read"
          ? { ...data, read: true }
          : action === "unread"
            ? { ...data, read: false }
            : { ...data, dismissed: true, read: true };
      if (next.read === data.read && next.dismissed === data.dismissed) continue;
      if (action === "unread" && data.dismissed) continue;
      this.deps.entries.put({ ...entry, data: next as never });
      changed++;
    }
    if (changed) this.deps.emit("notification.changed", { action, ids: ids ?? null }, owner);
    return changed;
  }

  /** Whether a notice id is one of this person's work notices. */
  owns(owner: string, id: string): boolean {
    const entry = this.deps.entries.get(id);
    return entry?.kind === NOTICE && entry.scope.id === owner;
  }

  private trim(userId: string) {
    const mine = this.deps.entries.inScope(NOTICE, { type: "person", id: userId });
    let extra = mine.length - KEEP;
    for (const entry of mine) {
      if (extra <= 0) break;
      const data = entry.data as unknown as NoticeData;
      if (data.read || data.dismissed) {
        // Gone for good: an old one that was read will not come again, whatever its key.
        this.deps.entries.remove(entry.id);
        extra--;
      }
    }
  }
}
