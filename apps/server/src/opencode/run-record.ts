/**
 * What a run has said so far, as the messages a chat keeps. The server writes these down itself, so
 * a run that nobody is watching still ends up in the conversation for whoever opens it next.
 */
export type RecordedMessage = Record<string, unknown> & { id: string; role: string };
type Message = RecordedMessage;
type Event = { type: string; [key: string]: unknown };

interface Call {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface Reply extends Message {
  role: "assistant";
  content: string;
  toolCalls: Call[];
}

export class RunRecord {
  private readonly order: Message[] = [];
  private readonly replies = new Map<string, Reply>();
  private readonly calls = new Map<string, Call>();

  private reply(id: string): Reply {
    let reply = this.replies.get(id);
    if (!reply) {
      reply = { id, role: "assistant", content: "", toolCalls: [] };
      this.replies.set(id, reply);
      this.order.push(reply);
    }
    return reply;
  }

  handle(event: object): void {
    const e = event as Event;
    switch (e.type) {
      case "TEXT_MESSAGE_START":
        this.reply(String(e.messageId));
        return;
      case "TEXT_MESSAGE_CONTENT":
        this.reply(String(e.messageId)).content += String(e.delta ?? "");
        return;
      case "TOOL_CALL_START": {
        const call: Call = {
          id: String(e.toolCallId),
          type: "function",
          function: { name: String(e.toolCallName), arguments: "" },
        };
        this.calls.set(call.id, call);
        this.reply(String(e.parentMessageId ?? `reply-${call.id}`)).toolCalls.push(call);
        return;
      }
      case "TOOL_CALL_ARGS": {
        const call = this.calls.get(String(e.toolCallId));
        if (call) call.function.arguments += String(e.delta ?? "");
        return;
      }
      case "TOOL_CALL_RESULT":
        this.order.push({
          id: String(e.messageId),
          role: "tool",
          toolCallId: String(e.toolCallId),
          content: String(e.content ?? ""),
        });
        return;
      default:
        return;
    }
  }

  /**
   * Take up what an earlier try of this run had said, so a run that carries on shows all of it. A tool call
   * that never came back was cut off by the restart, and says so.
   */
  seed(earlier: unknown[]): void {
    const answered = new Set<string>();
    for (const raw of earlier) {
      const message = raw as Message | null;
      if (message?.role === "tool" && typeof message.toolCallId === "string")
        answered.add(message.toolCallId);
    }
    const cut: string[] = [];
    for (const raw of earlier) {
      const message = raw as Message | null;
      if (!message || typeof message.id !== "string") continue;
      if (message.role === "assistant") {
        const reply = this.reply(message.id);
        reply.content = typeof message.content === "string" ? message.content : "";
        const calls = Array.isArray(message.toolCalls) ? (message.toolCalls as Call[]) : [];
        for (const call of calls) {
          const kept: Call = { ...call, function: { ...call.function } };
          this.calls.set(kept.id, kept);
          reply.toolCalls.push(kept);
        }
        for (const call of calls) if (!answered.has(call.id)) cut.push(call.id);
      } else if (message.role === "tool") this.order.push({ ...message });
    }
    for (const id of cut)
      this.order.push({
        id: `interrupted-${id}`,
        role: "tool",
        toolCallId: id,
        content: "error: Interrupted by a restart",
      });
  }

  /** The messages in the order they were said; a reply that has said nothing yet is left out. */
  messages(): Message[] {
    return this.order
      .filter(
        (m) => m.role !== "assistant" || (m as Reply).content || (m as Reply).toolCalls.length,
      )
      .map((m) => {
        if (m.role !== "assistant") return { ...m };
        const { content, toolCalls, ...rest } = m as Reply;
        return {
          ...rest,
          ...(content ? { content } : {}),
          ...(toolCalls.length ? { toolCalls: toolCalls.map((c) => ({ ...c })) } : {}),
        };
      });
  }
}

/** Put `added` into `kept` by id: a message already there is replaced in place, new ones go last. */
export function mergeMessages(kept: Message[], added: Message[]): Message[] {
  const out = [...kept];
  for (const message of added) {
    const at = out.findIndex((m) => m.id === message.id);
    if (at >= 0) out[at] = message;
    else out.push(message);
  }
  return out;
}

/** Of what a page sent with its run, only the message that started it: the rest is already kept. */
export function mergeableMessages(sent: unknown[]): Message[] {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i] as Message | undefined;
    if (m && m.role === "user" && typeof m.id === "string" && typeof m.content === "string")
      return [m];
  }
  return [];
}
