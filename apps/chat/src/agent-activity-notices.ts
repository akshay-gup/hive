import type { Access } from "../../../packages/chat-core/src/access.ts";
import type { AgentFlags } from "../../../packages/chat-core/src/agent-flags.ts";
import type { Entries } from "../../../packages/chat-core/src/entries.ts";
import type { ChatNotice } from "../../../packages/domain/src/chat.ts";

export const AGENT_ACTIVITY_NOTICE = "agent-activity";
const STATE = "agent_activity_notice";
interface NoticeState {
  latestId: string;
  read: boolean;
  dismissed: boolean;
}

/** A current summary, not a history of warnings in the bell. Only personal read/dismiss state is stored. */
export class AgentActivityNotices {
  constructor(
    private readonly deps: {
      access: Access;
      flags: AgentFlags;
      entries: Entries;
      emit: (type: string, data: unknown, userId: string) => void;
    },
  ) {}

  private async current(owner: string) {
    if (!(await this.deps.access.manages(owner))) return null;
    const summary = this.deps.flags.attention();
    if (!summary) return null;
    const saved = this.deps.entries.get(`${STATE}:${owner}`)?.data as unknown as
      | NoticeState
      | undefined;
    const state =
      saved?.latestId === summary.latestId
        ? saved
        : { latestId: summary.latestId, read: false, dismissed: false };
    return { summary, state };
  }

  async list(owner: string, options: { unreadOnly?: boolean } = {}): Promise<ChatNotice[]> {
    const current = await this.current(owner);
    if (!current || current.state.dismissed || (options.unreadOnly && current.state.read))
      return [];
    const { summary, state } = current;
    return [
      {
        id: AGENT_ACTIVITY_NOTICE,
        kind: "update",
        target: "agent-activity",
        title: "Agent activity needs review",
        body:
          summary.count === 1
            ? "1 warning needs review."
            : `${summary.count} warnings need review.`,
        createdAt: summary.at,
        read: state.read,
      },
    ];
  }

  async state(
    owner: string,
    action: "read" | "unread" | "dismiss",
    ids?: string[],
  ): Promise<number> {
    if (ids && !ids.includes(AGENT_ACTIVITY_NOTICE)) return 0;
    const current = await this.current(owner);
    if (!current || (action === "unread" && current.state.dismissed)) return 0;
    const { state } = current;
    const next =
      action === "dismiss"
        ? { ...state, read: true, dismissed: true }
        : { ...state, read: action === "read" };
    if (next.read === state.read && next.dismissed === state.dismissed) return 0;
    this.deps.entries.put({
      id: `${STATE}:${owner}`,
      kind: STATE,
      scope: { type: "person", id: owner },
      createdBy: owner,
      data: next,
    });
    this.deps.emit("notification.changed", { action, ids: [AGENT_ACTIVITY_NOTICE] }, owner);
    return 1;
  }

  /** No command, path or channel details are sent through notification events. */
  async changed(): Promise<void> {
    for (const [id, person] of await this.deps.access.byId()) {
      if (person.role !== "owner" && person.role !== "admin") continue;
      this.deps.emit("agent-flags.changed", {}, id);
      this.deps.emit("notification.changed", { id: AGENT_ACTIVITY_NOTICE, kind: "update" }, id);
    }
  }
}
