import { createHash } from "node:crypto";
import type { RunEvent } from "../../../../packages/domain/src/agent.ts";
import { WITHHELD } from "../agent-watch/egress.ts";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";
import type { OpenCodeEvent } from "./events.ts";

/** Public assistant text and tool activity only; synthetic context and reasoning are excluded. */
export class TaskRunLog {
  private readonly roles = new Map<string, string>();
  private readonly buffered = new Map<string, Map<string, OpenCodeEvent>>();
  private readonly records = new Map<string, RunEvent>();
  private readonly dirty = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  constructor(
    private readonly db: Store,
    private readonly owner: string,
    private readonly taskId: string,
    private readonly runId: string,
    private readonly guard: () => Promise<void>,
  ) {}
  /** Calls whose result is not to be shown (see agent-watch/egress.ts). */
  private readonly withheld = new Set<string>();
  withhold(callId: string) {
    this.withheld.add(callId);
  }
  handle(event: OpenCodeEvent) {
    const props = event.properties;
    if (event.type === "message.updated") {
      const info = props.info as { id?: string; role?: string } | undefined;
      if (!info?.id || !info.role) return;
      this.roles.set(info.id, info.role);
      const pending = this.buffered.get(info.id);
      this.buffered.delete(info.id);
      if (info.role === "assistant") for (const part of pending?.values() ?? []) this.handle(part);
      return;
    }
    if (event.type !== "message.part.updated" && event.type !== "message.part.delta") return;
    const part = props.part as
      | {
          id?: string;
          messageID?: string;
          type?: string;
          text?: string;
          synthetic?: boolean;
          callID?: string;
          tool?: string;
          state?: { status?: string; input?: unknown; output?: string; error?: string };
        }
      | undefined;
    const messageId = part?.messageID ?? (props.messageID as string | undefined);
    const partId = part?.id ?? (props.partID as string | undefined);
    if (!messageId || !partId || part?.synthetic || part?.type === "reasoning") return;
    if (!this.roles.has(messageId)) {
      const pending = this.buffered.get(messageId) ?? new Map();
      if (event.type === "message.part.updated") pending.set(partId, event);
      this.buffered.set(messageId, pending);
      return;
    }
    if (this.roles.get(messageId) !== "assistant") return;
    const id = createHash("sha256").update(`${this.taskId}:${this.runId}:${partId}`).digest("hex");
    const previous = this.records.get(id);
    let record: RunEvent;
    if (event.type === "message.part.delta") {
      if (
        previous?.kind !== "message" ||
        (props.field && props.field !== "text") ||
        typeof props.delta !== "string"
      )
        return;
      record = { ...previous, detail: previous.detail + props.delta };
    } else if (part?.type === "text" && typeof part.text === "string") {
      record = {
        ...(previous ?? this.base(id)),
        kind: "message",
        title: "Hive",
        detail: part.text,
      };
    } else if (part?.type === "tool" && part.tool && part.state) {
      const toolName = part.tool.replace(/^hive_[a-f0-9]{16}_/, "");
      record = {
        ...(previous ?? this.base(id)),
        kind: "tool",
        title: toolName,
        toolName,
        toolCallId: part.callID,
        toolState: part.state.status,
        toolInput: part.state.input,
        detail:
          part.callID && this.withheld.has(part.callID)
            ? WITHHELD
            : (part.state.error ?? part.state.output ?? ""),
      };
    } else return;
    if (record.detail.length > 200000)
      record.detail = `${record.detail.slice(0, 200000)}\n[Output truncated]`;
    this.records.set(id, record);
    this.dirty.add(id);
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error) => backgroundFailure("task run log", error));
      }, 500);
  }
  private base(id: string): RunEvent {
    return {
      id,
      taskId: this.taskId,
      runId: this.runId,
      sequence: this.sequence++,
      date: new Date().toISOString(),
      kind: "message",
      title: "Hive",
      detail: "",
    };
  }
  flush() {
    const updates = [...this.dirty].map((id) => ({ ...this.records.get(id)! }));
    this.dirty.clear();
    this.queue = this.queue.then(async () => {
      if (!updates.length) return;
      await this.guard();
      for (const record of updates) await this.db.put(this.owner, "run-events", record);
    });
    return this.queue;
  }
  async close() {
    clearTimeout(this.timer);
    await this.flush();
  }
}
