/**
 * AG-UI shim over OpenCode sessions.
 *
 * The CopilotKit runtime's `agents` factory points the chat agent at
 * POST /api/agent/opencode/run on this same server. The shim translates:
 * - AG-UI RunAgentInput -> OpenCode `session.promptAsync`, with a synthetic
 *   context part (channel/thread metadata plus the full visible conversation
 *   transcript, which the model sees but that never surfaces as a real turn)
 *   prepended to the user's prompt;
 * - OpenCode global events -> AG-UI events (`TEXT_MESSAGE_*`, `TOOL_CALL_*`,
 *   `RUN_STARTED/FINISHED/ERROR`), with synthetic parts filtered on egress
 *   and busy/idle derived from `session.status` / `session.idle` only.
 *
 * Mention-only triggering: the agent runs only when the last user message
 * contains the configured mention token (`AGENT_MENTION`, default `@hive`)
 * as a standalone token. Anything else is plain chat — the run completes
 * immediately as a no-op (`RUN_STARTED` then `RUN_FINISHED`, no OpenCode
 * session touched) and the agent stays silent. When triggered, the full
 * transcript of everyone talking (plus attached images as native file parts)
 * goes to the session so the agent catches up on what it missed while idle.
 *
 * One run per thread at a time: a second concurrent run is rejected (409),
 * since two runs on one session would interleave on a single event stream.
 * Prompt dispatch is serialized through the bus's per-thread action queue.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  type ChannelThread,
  ORCHESTRATOR_CHANNEL_ID,
} from "../../../../packages/domain/src/agent.ts";
import {
  WATCH_DOWN_TEXT,
  WATCH_STOP_TEXT,
  type WatchFinding,
} from "../../../../packages/domain/src/agent-watch.ts";
import { jevActionPrefix, parseJevAction } from "../../../../packages/domain/src/jev.ts";
import { Egress } from "../agent-watch/egress.ts";
import type { AgentWatch } from "../agent-watch/watch.ts";
import type { WorkClient } from "../chat-runner/work-link.ts";
import type { Config } from "../config.ts";
import type { AgentService } from "../engine/service.ts";
import { diskOwnerForChannel } from "../engine/threads.ts";
import { conversationTools } from "../engine/tools.ts";
import type { JevService } from "../jev/service.ts";
import type { AskedPermissionProps, AskedQuestionProps, PermissionTracker } from "./approvals.ts";
import type { OpencodeClientPool } from "./client.ts";
import { type OpenCodeEvent, type OpencodeEventBus, sessionErrorMessage } from "./events.ts";
import type { HiveToolBridge } from "./hive-tools.ts";
import { buildSessionRuleset } from "./permissions.ts";
import type { PermissionRulesStore } from "./rules.ts";
import { mergeableMessages, type RecordedMessage, RunRecord } from "./run-record.ts";
import { ensureThreadSession } from "./sessions.ts";

export interface OpencodeShimDeps {
  service: AgentService;
  bus: OpencodeEventBus;
  pool: OpencodeClientPool;
  config: Config;
  tracker: PermissionTracker;
  rules: PermissionRulesStore;
  hiveTools?: HiveToolBridge;
  /** Writes messages into a conversation, so a run nobody is watching is still kept. */
  saveMessages?: (owner: string, threadId: string, messages: RecordedMessage[]) => Promise<void>;
  /** Which runs are going, kept across a restart so an update does not drop a reply half-written. */
  runMarks?: {
    set: (threadId: string, owner: string) => Promise<void>;
    clear: (threadId: string) => Promise<void>;
    all: () => Promise<Array<{ threadId: string; owner: string; startedAt: number }>>;
  };
  /** What a conversation holds now. */
  loadMessages?: (owner: string, threadId: string) => Promise<unknown[]>;
  /** Marks what a run opens of the machine's own data (see agent-watch/watch.ts). */
  watch?: AgentWatch;
}

/**
 * A run that the chat service started for a mention in a channel. It runs as any other, except that
 * nothing about it is kept here (the chat service keeps the conversation), none of the orchestrator's
 * choices or mail tools are offered. Board lookups are checked against every channel reader by the chat service,
 * and everything it asks for is asked of the people in the channel.
 */
export interface ChatOrigin {
  /** Where the session lives: a stand-in for the channel (see chat-runner/stubs.ts). */
  binding: ChannelThread;
  /** The person who asked is a guest. */
  guest: boolean;
  /** The channel is a private one. */
  privateChannel: boolean;
  /** The channel is the person's own conversation with the agent. */
  personal?: boolean;
  /** What the agent is shown ahead of the person's words, given what it is told of its tools. */
  context: (toolNotes: string) => string;
  /** The person's own words. */
  text: string;
  /** Pictures that came with them. */
  files: PromptFilePart[];
  /** Put a file of the channel's folder in the reply. */
  shareFile: (path: string) => Promise<{ sent: true } | { sent: false; error: string }>;
  /** Change the board, as the person who asked. */
  work: WorkClient;
}

const runInputSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  messages: z.array(z.any()),
});

type RunInput = z.infer<typeof runInputSchema>;

/** Bound for a run whose terminal events never arrive (e.g. a reconnect gap). */
const RUN_TIMEOUT_MS = 60 * 60_000;
/** Truncation for tool results forwarded as TOOL_CALL_RESULT content. */
const TOOL_RESULT_LIMIT = 2_000;
/**
 * Tools whose result is the card itself, not a log of what happened: cut short, it is not JSON the
 * client can show. Their size is bounded by the tool's own schema.
 */
const WHOLE_RESULT_TOOLS = new Set(["present_choices"]);

/**
 * What the chat is sent of a tool's result. A page the agent read is long, and cut short it is no
 * longer JSON, so the card would say the page was never returned: keep the fields it shows and
 * trim the page text.
 */
export function forwardedResult(tool: string, content: string): string {
  if (WHOLE_RESULT_TOOLS.has(tool)) return content;
  if (tool === "browse_web" && content.length > TOOL_RESULT_LIMIT) {
    try {
      const page = JSON.parse(content);
      if (page && typeof page === "object" && !Array.isArray(page)) {
        const { text, ...rest } = page as Record<string, unknown>;
        const room = Math.max(0, TOOL_RESULT_LIMIT - JSON.stringify(rest).length - 32);
        const shown = typeof text === "string" ? { ...rest, text: text.slice(0, room) } : rest;
        const out = JSON.stringify(shown);
        if (out.length <= TOOL_RESULT_LIMIT) return out;
        return JSON.stringify(rest).slice(0, TOOL_RESULT_LIMIT);
      }
    } catch {
      // not JSON: fall through to the plain cut
    }
  }
  return content.slice(0, TOOL_RESULT_LIMIT);
}

export function parseModelRef(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** A Hive tool's own name: OpenCode namespaces the ones the bridge offers per run. */
function hiveToolName(tool: string): string {
  return tool.replace(/^hive_[a-f0-9]{16}_/, "");
}

/** Index of the last user message that says something, or -1. */
function lastUserIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && messageText(messages[i])) return i;
  }
  return -1;
}

/** Text of the last user message that says something. */
export function lastUserText(messages: Array<Record<string, unknown>>): string | undefined {
  const index = lastUserIndex(messages);
  return index < 0 ? undefined : messageText(messages[index]);
}

/**
 * What the agent is told when a person picks a card, once the pick has been checked against the
 * panel it came from. A pick that does not check out throws, and says why.
 */
async function readChoice(
  jev: JevService | null | undefined,
  owner: string,
  threadId: string,
  text: string,
): Promise<string> {
  if (!jev) throw new Error("Choices are unavailable in this conversation");
  let action: ReturnType<typeof parseJevAction>;
  try {
    action = parseJevAction(text);
  } catch {
    throw new Error("The choice could not be read");
  }
  if (!action) throw new Error("The choice could not be read");
  return (await jev.select(owner, threadId, action)).continuation;
}

/** Joined text of a message's text content parts (string content included). */
export function messageText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** Normalize the AGENT_MENTION env value to a mention token (default `@hive`). */
export function normalizeMention(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "@hive";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function mentionPattern(mention: string): RegExp {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Standalone token: not glued to a letter, digit, or underscore on either side,
  // so `@hiveX` and `mail@hive` do not count as mentions.
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, "iu");
}

/** True when the text mentions the agent as a standalone token (case-insensitive). */
export function mentionsAgent(text: string, mention: string): boolean {
  return mentionPattern(mention).test(text);
}

/** Remove the mention token from prompt text, collapsing leftover whitespace. */
export function stripMention(text: string, mention: string): string {
  return text
    .replace(new RegExp(mentionPattern(mention).source, "giu"), "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the run should invoke the agent: the last user message mentions it. */
export function shouldTriggerRun(
  messages: Array<Record<string, unknown>>,
  mention: string,
): boolean {
  const text = lastUserText(messages);
  return !!text && mentionsAgent(text, mention);
}

interface ImageSource {
  type?: string;
  value?: string;
  mimeType?: string;
}

export interface PromptFilePart {
  type: "file";
  mime: string;
  url: string;
}

/** Image content parts of one message, mapped to OpenCode native file parts. */
export function messageFileParts(message: Record<string, unknown> | undefined): PromptFilePart[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const parts: PromptFilePart[] = [];
  for (const part of content) {
    if (part?.type !== "image") continue;
    const source = part.source as ImageSource | undefined;
    if (!source || typeof source.value !== "string" || !source.value) continue;
    const mime = source.mimeType?.trim() || "application/octet-stream";
    const url = source.type === "data" ? `data:${mime};base64,${source.value}` : source.value;
    parts.push({ type: "file", mime, url });
  }
  return parts;
}

/** Native file parts from the triggering (last user) message only. */
export function promptFileParts(messages: Array<Record<string, unknown>>): PromptFilePart[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messageFileParts(messages[i]);
  }
  return [];
}

/** Cap for the transcript forwarded in the synthetic context part. */
const TRANSCRIPT_LIMIT = 20_000;

/**
 * The full visible conversation as `Speaker: text` lines, oldest first.
 * Speaker is the message's `name` when present, otherwise the role label —
 * never invented. Image attachments become markers (their native parts only
 * travel with the triggering message). Oldest lines are dropped past the cap
 * so the agent catches up on the most recent discussion.
 */
export function buildTranscript(messages: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const rawName = message.name;
    const speaker =
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim()
        : role === "user"
          ? "User"
          : "Assistant";
    const text = messageText(message);
    const markers = messageFileParts(message).map((f) => `[attached file (${f.mime})]`);
    const body = [text, ...markers].filter(Boolean).join("\n");
    if (!body) continue;
    lines.push(`${speaker}: ${body}`);
  }
  let transcript = lines.join("\n");
  if (transcript.length > TRANSCRIPT_LIMIT) {
    // Drop oldest lines until the tail fits; the recent discussion matters most.
    let dropped = 0;
    for (const line of lines) {
      if (transcript.length - dropped <= TRANSCRIPT_LIMIT) break;
      dropped += line.length + 1; // +1 for the "\n" join separator
    }
    transcript = `[earlier history omitted]\n${transcript.slice(dropped)}`;
  }
  return transcript;
}

interface TextTrack {
  started: boolean;
  emitted: number;
}

interface ToolTrack {
  started: boolean;
  argsSent: boolean;
  ended: boolean;
}

type AguiEvent = Record<string, unknown>;

export interface TranslatorPermissionHooks {
  /** True if the ask was turned down on the spot: nobody is then asked. */
  onAsked?: (props: AskedPermissionProps) => boolean | undefined;
  onReplied?: (requestId: string) => void;
  /** The agent asked the person a question (see approvals.ts), and later it was answered or turned down. */
  onQuestion?: (props: AskedQuestionProps) => void;
  onQuestionDone?: (requestId: string) => void;
}

/**
 * Translates one run's OpenCode events into AG-UI events. Created per run;
 * the bus drops stale-session events before they reach it.
 */
export class RunTranslator {
  private readonly messageRoles = new Map<string, string>();
  private readonly partMeta = new Map<string, { type: string; synthetic?: boolean }>();
  private readonly texts = new Map<string, TextTrack>();
  private readonly tools = new Map<string, ToolTrack>();
  private finished = false;

  constructor(
    private readonly input: RunInput,
    private readonly send: (event: AguiEvent) => void,
    private readonly done: () => void,
    private readonly permissionHooks: TranslatorPermissionHooks = {},
  ) {}

  handle(event: OpenCodeEvent): void {
    if (this.finished) return;
    const props = event.properties;
    switch (event.type) {
      case "message.updated": {
        const info = props.info as { id?: string; role?: string } | undefined;
        if (info?.id && info.role) this.messageRoles.set(info.id, info.role);
        return;
      }
      case "message.part.updated": {
        const part = props.part as {
          id?: string;
          messageID?: string;
          type?: string;
          synthetic?: boolean;
          text?: string;
          callID?: string;
          tool?: string;
          state?: { status?: string; input?: unknown; output?: string; error?: string };
        };
        if (!part?.id || !part.messageID || !part.type) return;
        this.partMeta.set(part.id, { type: part.type, synthetic: part.synthetic });
        if (part.synthetic) return; // egress filter for synthetic context parts
        if (part.type === "text" && typeof part.text === "string") {
          if (this.messageRoles.get(part.messageID) !== "assistant") return;
          this.streamText(part.messageID, part.text);
        } else if (part.type === "tool" && part.callID && part.tool && part.state) {
          this.streamTool(part.messageID, part.callID, part.tool, part.state);
        }
        return;
      }
      case "message.part.delta": {
        const meta = this.partMeta.get(props.partID as string);
        if (!meta || meta.synthetic || meta.type !== "text") return;
        if (this.messageRoles.get(props.messageID as string) !== "assistant") return;
        const delta = props.delta;
        if (typeof delta !== "string" || !delta) return;
        this.streamDelta(props.messageID as string, delta);
        return;
      }
      case "session.status": {
        const status = props.status as { type?: string } | undefined;
        if (status?.type === "idle") this.finish();
        return;
      }
      case "session.idle":
        this.finish();
        return;
      case "session.error":
        this.fail(sessionErrorMessage(props.error, "The OpenCode session reported an error"));
        return;
      case "permission.asked": {
        const asked: AskedPermissionProps = {
          id: props.id as string,
          sessionID: props.sessionID as string,
          permission: props.permission as string,
          patterns: (props.patterns as string[]) ?? [],
          tool: props.tool as { messageID: string; callID: string } | undefined,
          metadata: props.metadata,
        };
        if (this.permissionHooks.onAsked?.(asked)) return;
        // Phase 3 surfaces this for user reply; until then it is informational.
        this.send({
          type: "CUSTOM",
          name: "permission-requested",
          value: {
            requestId: asked.id,
            permission: asked.permission,
            patterns: asked.patterns,
            metadata: props.metadata,
          },
        });
        return;
      }
      case "question.asked": {
        const asked = props as unknown as AskedQuestionProps;
        if (typeof asked.id !== "string") return;
        this.permissionHooks.onQuestion?.(asked);
        this.send({
          type: "CUSTOM",
          name: "question-requested",
          value: { requestId: asked.id, questions: asked.questions },
        });
        return;
      }
      case "question.replied":
      case "question.rejected": {
        const requestId = props.requestID as string | undefined;
        if (requestId) this.permissionHooks.onQuestionDone?.(requestId);
        return;
      }
      case "permission.replied": {
        const requestId = props.requestID as string | undefined;
        if (requestId) this.permissionHooks.onReplied?.(requestId);
        return;
      }
      default:
        return;
    }
  }

  private streamText(messageID: string, fullText: string): void {
    let track = this.texts.get(messageID);
    if (!track) {
      track = { started: false, emitted: 0 };
      this.texts.set(messageID, track);
    }
    if (!track.started) {
      this.send({ type: "TEXT_MESSAGE_START", messageId: messageID, role: "assistant" });
      track.started = true;
    }
    const rest = fullText.slice(track.emitted);
    if (rest) {
      this.send({ type: "TEXT_MESSAGE_CONTENT", messageId: messageID, delta: rest });
      track.emitted = fullText.length;
    }
  }

  private streamDelta(messageID: string, delta: string): void {
    if (!delta) return;
    const track = this.texts.get(messageID);
    if (!track?.started) {
      // Delta arrived before the part snapshot: open the message, then stream.
      this.streamText(messageID, delta);
      return;
    }
    this.send({ type: "TEXT_MESSAGE_CONTENT", messageId: messageID, delta });
    track.emitted += delta.length;
  }

  private streamTool(
    parentMessageId: string,
    callID: string,
    tool: string,
    state: { status?: string; input?: unknown; output?: string; error?: string },
  ): void {
    let track = this.tools.get(callID);
    if (!track) {
      track = { started: false, argsSent: false, ended: false };
      this.tools.set(callID, track);
    }
    const current = track;
    const start = () => {
      this.send({
        type: "TOOL_CALL_START",
        toolCallId: callID,
        toolCallName: hiveToolName(tool),
        parentMessageId,
      });
      current.started = true;
    };
    if (!track.started && (state.status === "pending" || state.status === "running")) start();
    // A call is announced before its arguments are known, so empty ones are not the final word.
    const hasInput =
      state.input != null &&
      (typeof state.input !== "object" || Object.keys(state.input as object).length > 0);
    const finishing = state.status === "completed" || state.status === "error";
    if (!track.started && finishing) start();
    if (track.started && !track.argsSent && (hasInput || (finishing && state.input != null))) {
      this.send({
        type: "TOOL_CALL_ARGS",
        toolCallId: callID,
        delta: JSON.stringify(state.input),
      });
      track.argsSent = true;
    }
    if (!track.ended && (state.status === "completed" || state.status === "error")) {
      if (!track.started) start();
      this.send({ type: "TOOL_CALL_END", toolCallId: callID });
      const content =
        state.status === "completed" ? (state.output ?? "") : `error: ${state.error ?? "unknown"}`;
      this.send({
        type: "TOOL_CALL_RESULT",
        messageId: `toolresult-${callID}`,
        toolCallId: callID,
        role: "tool",
        content: forwardedResult(hiveToolName(tool), content),
      });
      track.ended = true;
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const [messageID, track] of this.texts) {
      if (track.started) this.send({ type: "TEXT_MESSAGE_END", messageId: messageID });
    }
    for (const [callID, track] of this.tools) {
      if (track.started && !track.ended) this.send({ type: "TOOL_CALL_END", toolCallId: callID });
    }
    this.send({ type: "RUN_FINISHED", threadId: this.input.threadId, runId: this.input.runId });
    this.done();
  }

  fail(message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.send({ type: "RUN_ERROR", message, code: "OPENCODE_RUN_FAILED" });
    this.done();
  }
}

interface RunContext {
  chat?: ChatOrigin;
  deps: OpencodeShimDeps;
  owner: string;
  input: RunInput;
  send: (event: AguiEvent) => void;
  signal: AbortSignal;
  inflight: Map<string, string>;
  onAbort: () => void;
  session?: { sessionId: string; directory: string };
  unsubscribe?: () => void;
  translator?: RunTranslator;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** Idempotent run teardown: unsubscribe, clear the in-flight guard, stop timers. */
function settleRun(ctx: RunContext): void {
  if (ctx.settled) return;
  ctx.settled = true;
  ctx.unsubscribe?.();
  if (ctx.timer) clearTimeout(ctx.timer);
  ctx.signal.removeEventListener("abort", ctx.onAbort);
  if (ctx.inflight.get(ctx.input.threadId) === ctx.input.runId) {
    ctx.inflight.delete(ctx.input.threadId);
  }
}

async function abortRunSession(ctx: RunContext): Promise<void> {
  const session = ctx.session;
  if (!session) return;
  try {
    await ctx.deps.pool
      .forDirectory(session.directory)
      .session.abort({ sessionID: session.sessionId, directory: session.directory });
  } catch {
    // Best effort: the session may already be gone.
  }
}

const GUEST_CHANNELS_ONLY = "Guests can open only the channels they were added to";

/**
 * Why the agent will not take a guest's message, if it will not. They have no say in what the agent
 * is allowed to do, so in a channel where it runs without asking first, whatever a guest wrote would
 * be done unchecked.
 */
async function guestRefusal(
  deps: OpencodeShimDeps,
  owner: string,
  binding: ChannelThread | null,
): Promise<string | undefined> {
  if (!binding) return GUEST_CHANNELS_ONLY;
  try {
    await deps.service.access.assertChannel(owner, binding.channelId);
  } catch {
    return GUEST_CHANNELS_ONLY;
  }
  const rules = buildSessionRuleset(
    await deps.rules.effectiveRules(owner, binding),
    await deps.rules.effectiveMode(owner, binding),
  );
  if (rules.some((rule) => rule.action === "allow"))
    return "In this thread the agent is allowed to act without asking first, so guests can't use it. An admin can change that in the thread's permissions.";
  return undefined;
}

/** A private channel is its members': a run in it is refused to anyone else, whatever got it this far. */
async function closedChannel(
  deps: OpencodeShimDeps,
  owner: string,
  binding: ChannelThread | null,
): Promise<string | undefined> {
  if (!binding) return undefined;
  try {
    await deps.service.access.assertChannel(owner, binding.channelId);
  } catch {
    return "Channel not found";
  }
  return undefined;
}

async function runOpencodeTurn(ctx: RunContext): Promise<void> {
  const { deps, owner, input, send, signal, chat } = ctx;
  const mention = normalizeMention(deps.config.agentMention);

  // Channel chats are chat-only surfaces: a channel opens directly and its
  // messages persist client-side. Threads auto-create client-side from
  // replies and @hive mentions, so a run scoped to a channel id never binds
  // a thread and never summons the worker.
  if (!chat && input.threadId.startsWith("channel:")) {
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
    return;
  }

  // The main chat thread id originates on the client and is bound lazily:
  // the first run binds it to the orchestrator channel instead of failing. This
  // runs before the mention gate so plain chat also leaves a bound thread.
  // A guest has no main chat: their runs are in threads of the channels they were added to.
  // A run the chat service started has been checked there, and has its binding made already.
  const guest = chat ? chat.guest : await deps.service.access.isGuest(owner);
  if (!chat && !guest) await deps.service.ensureOrchestratorChannel(owner);
  const binding = chat
    ? chat.binding
    : guest
      ? await deps.service.channelOfThread(owner, input.threadId)
      : await deps.service.ensureThreadBinding(
          owner,
          input.threadId,
          ORCHESTRATOR_CHANNEL_ID,
          "Main chat",
        );
  const refusal = chat
    ? undefined
    : guest
      ? await guestRefusal(deps, owner, binding)
      : await closedChannel(deps, owner, binding);
  // With refusing on, nothing runs while the machine's watch is not working (a run of a channel is refused by the runner).
  const paused = chat ? null : (deps.watch?.refusal() ?? null);
  if (paused) {
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    send({ type: "RUN_ERROR", message: paused, code: "OPENCODE_RUN_FAILED" });
    return;
  }
  if (!binding || refusal) {
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    send({
      type: "RUN_ERROR",
      message: refusal ?? GUEST_CHANNELS_ONLY,
      code: "OPENCODE_RUN_FAILED",
    });
    return;
  }

  if (!chat) {
    // Someone writing in a channel is what marks it unread for the others in it.
    await deps.service.noteMessage(owner, binding.channelId).catch(() => undefined);
  }

  // Mention-only triggering: without the mention token in the last user
  // message this is plain chat. Complete the run as a no-op — the message is
  // already persisted by CopilotKit; the agent stays silent and OpenCode is
  // never touched (no session, no prompt). The in-flight slot is released by
  // settleRun in the route's finally block.
  let messages = input.messages as Array<Record<string, unknown>>;
  let userText = chat ? chat.text : lastUserText(messages);
  // Choice panels belong to their conversation, as the transcript does: one set for everyone in a
  // channel's threads, and private to the person in the orchestrator chat.
  const jevHome = diskOwnerForChannel(binding.channelId, owner);

  // Picking a card is answering a question the agent asked, so it needs no mention. The pick is
  // checked against its panel, and the agent is told what it says in words rather than as the
  // protocol message the client sent.
  let picked = false;
  if (!chat && userText?.startsWith(jevActionPrefix)) {
    try {
      const continuation = await readChoice(deps.service.jev, jevHome, input.threadId, userText);
      const index = lastUserIndex(messages);
      messages = messages.map((message, i) =>
        i === index ? { ...message, content: continuation } : message,
      );
      userText = continuation;
      picked = true;
    } catch (error) {
      send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      send({
        type: "RUN_ERROR",
        message: error instanceof Error ? error.message : "Could not select this choice",
      });
      return;
    }
  }

  // Whatever else a person says retires the choices before it. The transcript already shows them
  // stale, so the stored panel has to agree even when this turn fails, is cancelled, or the agent
  // stays silent for want of a mention. The turn that retires a panel may still refine it.
  const jev = chat ? null : deps.service.jev;
  if (jev && !picked && messages.at(-1)?.role === "user") {
    try {
      const head = await jev.headSnapshot(jevHome, input.threadId);
      // False means another run already replaced the panel; that newer state wins.
      if (head) await jev.expireIfUnchanged(jevHome, input.threadId, head, input.runId);
    } catch {
      send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      send({ type: "RUN_ERROR", message: "Could not update earlier choices. Please retry." });
      return;
    }
  }

  // Your own chat is a conversation with the agent: everything said there is for it. Only a shared
  // channel, where people talk to each other too, needs the agent to be called by name.
  const alone = binding.channelId === ORCHESTRATOR_CHANNEL_ID;
  if (!userText || (!chat && !picked && !alone && !mentionsAgent(userText, mention))) {
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
    return;
  }

  const toolAbort = new AbortController();
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  // What the run says goes through here to the screen, which can hold a result or withhold it.
  let egress: Egress | undefined;
  const finish = () => {
    egress?.flushNow();
    toolAbort.abort();
    settleRun(ctx);
    resolveDone();
  };

  const onTimeout = () => {
    void abortRunSession(ctx).finally(() => {
      // A permission left hanging stalls the session forever; reject the lot.
      void deps.tracker.rejectAllForScope(deps, input.threadId);
      if (ctx.translator) ctx.translator.fail("The run timed out");
      else {
        send({ type: "RUN_ERROR", message: "The run timed out", code: "OPENCODE_RUN_FAILED" });
        finish();
      }
    });
  };
  const armTimer = () => {
    ctx.timer = setTimeout(onTimeout, RUN_TIMEOUT_MS);
    // Don't hold the process open for a run whose client already went away.
    (ctx.timer as unknown as { unref?: () => void }).unref?.();
  };
  armTimer();
  // The bound is for a run that went quiet, not for one waiting on a person: while a question or
  // permission is open the clock stops, and it starts again once the last one is answered.
  const waitingOn = new Set<string>();
  const waiting = (id: string, on: boolean) => {
    if (ctx.settled) return;
    const had = waitingOn.size;
    if (on) waitingOn.add(id);
    else waitingOn.delete(id);
    if (had === 0 && waitingOn.size > 0) clearTimeout(ctx.timer);
    else if (had > 0 && waitingOn.size === 0) armTimer();
  };
  const onAbort = () => {
    void abortRunSession(ctx).finally(() => {
      // The user walked away mid-run: reject pending permissions so the
      // session doesn't hang on them forever.
      void deps.tracker.rejectAllForScope(deps, input.threadId);
      if (ctx.translator) ctx.translator.fail("The run was cancelled");
      else {
        send({ type: "RUN_ERROR", message: "The run was cancelled", code: "OPENCODE_RUN_FAILED" });
        finish();
      }
    });
  };
  ctx.onAbort = onAbort;
  signal.addEventListener("abort", onAbort, { once: true });

  let toolLease: Awaited<ReturnType<HiveToolBridge["connect"]>> | undefined;
  const cancelTools = () => toolAbort.abort();
  signal.addEventListener("abort", cancelTools, { once: true });
  try {
    const { sessionId, directory } = await ensureThreadSession(
      {
        threads: deps.service.threads,
        clients: deps.pool,
        config: deps.config,
        // In a shared channel the agent always asks first, whatever a channel's folder says.
        userRules: (binding) => (chat ? [] : deps.rules.effectiveRules(owner, binding)),
        permissionMode: (binding) => (chat ? "ask" : deps.rules.effectiveMode(owner, binding)),
        protect: () => deps.watch?.denyRules() ?? [],
      },
      owner,
      input.threadId,
    );
    ctx.session = { sessionId, directory };
    deps.bus.track(input.threadId, sessionId);

    // The person's own words, which the choice cards are judged against.
    const stripped = chat ? userText : stripMention(userText, mention);
    if (deps.hiveTools) {
      const toolInput = {
        ...input,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      } as import("@ag-ui/core").RunAgentInput;
      toolLease = await deps.hiveTools.connect(
        deps.pool,
        directory,
        input.threadId,
        conversationTools(deps.service, owner, toolInput, {
          signal: toolAbort.signal,
          requestKey: `${input.threadId}:${input.runId}`,
          channelId: binding.channelId,
          jev,
          jevMode: deps.config.jevMode,
          jevOwner: jevHome,
          latestText: stripped,
          guest,
          ...(chat
            ? {
                toolset: chat.personal ? "personal" : chat.privateChannel ? "chat-private" : "chat",
                shareFile: chat.shareFile,
                work: chat.work,
              }
            : {}),
        }),
        toolAbort.signal,
        chat ? { chat: true } : undefined,
      );
    }
    const transcript = chat ? "" : buildTranscript(messages);
    // A bare mention ("@hive" and nothing else) still summons the agent;
    // point it at the conversation it just received.
    const promptText =
      stripped || "(summoned by mention with no additional text — see the conversation above)";
    const fileParts = chat ? chat.files : promptFileParts(messages);

    // The run is stopped for reaching the machine's own data: nothing more of it is shown, its Hive tools are taken
    // away, the session is refused the data and stopped, and forgotten, so what it read is not in its memory.
    let stoppedForData = false;
    const lockdown = (finding?: WatchFinding): boolean => {
      if (stoppedForData) return true;
      if (ctx.settled) return false;
      stoppedForData = true;
      egress?.shutDown();
      toolLease?.release();
      ctx.translator?.fail(finding?.rule === "watch" ? WATCH_DOWN_TEXT : WATCH_STOP_TEXT);
      const session = ctx.session;
      if (session)
        void (async () => {
          const client = deps.pool.forDirectory(session.directory);
          const where = { sessionID: session.sessionId, directory: session.directory };
          await client.session
            .update({ ...where, permission: deps.watch?.denyRules() ?? [] })
            .catch(() => undefined);
          await abortRunSession(ctx);
          await deps.tracker.rejectAllForScope(deps, input.threadId).catch(() => 0);
          await client.session.delete(where).catch(() => undefined);
        })();
      return true;
    };
    const watching = deps.watch?.forRun({
      scope: chat ? "channel" : "own-chat",
      ...(chat ? { runId: input.runId } : {}),
      directory,
      onSerious: ({ callId, finding }) => {
        if (callId) egress?.withhold(callId);
        return lockdown(finding);
      },
    });
    egress = new Egress(send, { holdMs: () => deps.watch?.holdMs() ?? 0 });
    const translator = new RunTranslator(input, (event) => egress?.push(event), finish, {
      onAsked: (asked) => {
        const scope = {
          scope: input.threadId,
          threadId: input.threadId,
          channelId: binding.channelId,
          directory,
        };
        // What the agent asks leave for is looked at before anyone is asked; in the stricter mode what reaches
        // the machine's own data is turned down here.
        if (watching?.asked(asked)) {
          deps.tracker.record(scope, asked);
          void deps.tracker
            .reply(
              deps,
              asked.id,
              "reject",
              "That is the workspace's own data, which this agent is not to open. Do not look for another way to it; say so and carry on with what else was asked.",
            )
            .catch(() => undefined);
          return true;
        }
        waiting(asked.id, true);
        deps.tracker.record(scope, asked);
        return undefined;
      },
      onReplied: (requestId) => {
        waiting(requestId, false);
        deps.tracker.remove(requestId);
        if (chat) send({ type: "CUSTOM", name: "prompt-done", value: { requestId } });
      },
      onQuestion: (asked) => {
        waiting(asked.id, true);
        deps.tracker.recordQuestion(
          {
            scope: input.threadId,
            threadId: input.threadId,
            channelId: binding.channelId,
            directory,
          },
          asked,
        );
      },
      onQuestionDone: (requestId) => {
        waiting(requestId, false);
        deps.tracker.removeQuestion(requestId);
        if (chat) send({ type: "CUSTOM", name: "prompt-done", value: { requestId } });
      },
    });
    ctx.translator = translator;
    const unsubscribe = deps.bus.onEvent(input.threadId, (event) => {
      // Looked at first: a call's result can be on its way in the same event that first shows what it asked for.
      watching?.(event);
      translator.handle(event);
    });
    ctx.unsubscribe = () => {
      unsubscribe();
      watching?.end();
    };

    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });

    await deps.bus.waitForConnection();
    const client = deps.pool.forDirectory(directory);
    const model = parseModelRef(deps.config.model);
    await deps.bus.enqueue(input.threadId, () =>
      client.session.promptAsync({
        sessionID: sessionId,
        directory,
        ...(model ? { model } : {}),
        ...(toolLease ? { tools: toolLease.flags } : {}),
        parts: [
          {
            type: "text",
            synthetic: true,
            text: chat
              ? chat.context(toolLease?.instructions ?? "")
              : `[hive context] channel=${binding.channelId} thread=${input.threadId} name=${binding.name}\n` +
                `${toolLease?.instructions ?? ""}\n` +
                `You were summoned by mention and have not participated until now. ` +
                `The full visible conversation (everyone talking) follows so you can catch up:\n${transcript}`,
          },
          ...fileParts,
          { type: "text", text: promptText },
        ],
      }),
    );
    // Completion (or failure) arrives via the event subscription above.
    await donePromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OpenCode error";
    if (ctx.translator) ctx.translator.fail(message);
    else {
      send({ type: "RUN_ERROR", message, code: "OPENCODE_RUN_FAILED" });
      finish();
    }
  } finally {
    toolAbort.abort();
    toolLease?.release();
    signal.removeEventListener("abort", cancelTools);
  }
}

export function opencodeShimRoutes(deps: OpencodeShimDeps) {
  const app = new Hono<{ Variables: { owner: string } }>();
  // One in-flight run per thread: threadId -> runId. The check-and-set below is
  // synchronous, so concurrent requests for the same thread cannot both pass.
  const inflight = new Map<string, string>();

  /** Runs go on when the page that started them is closed; only Stop (below) ends one early. */
  const stoppers = new Map<string, AbortController>();
  // A run is still going until what it said has been written down, not just until it ends.
  const settling = new Set<string>();
  /** Threads with a message that came in while a run was going, and whose it was: they run next. */
  const pending = new Map<string, string>();
  app.get("/live", (c) => c.json({ running: settling.has(c.req.query("threadId") ?? "") }));
  app.post("/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown };
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    pending.delete(threadId);
    stoppers.get(threadId)?.abort();
    return c.json({ ok: true });
  });
  /**
   * Begin a run. It is written down as it goes and does not depend on anyone reading `onEvent`.
   * Returns undefined when the thread already has a run going.
   */
  const launch = (
    owner: string,
    input: RunInput,
    onEvent?: (event: AguiEvent) => void,
    chat?: ChatOrigin,
  ): Promise<void> | undefined => {
    const { threadId, runId } = input;
    if (inflight.has(threadId)) return undefined;
    inflight.set(threadId, runId);
    const stopper = new AbortController();
    stoppers.set(threadId, stopper);
    settling.add(threadId);
    // A run for the chat service is not carried on after a restart: the chat service is told it was lost.
    if (!chat) void deps.runMarks?.set(threadId, owner).catch(() => undefined);
    const record = new RunRecord();
    // Writes go one after another, so the last one is the newest state.
    let saving: Promise<void> = Promise.resolve();
    const save = (withInput = false) => {
      if (chat || !deps.saveMessages || threadId.startsWith("channel:")) return;
      const messages = [
        ...(withInput ? mergeableMessages(input.messages) : []),
        ...record.messages(),
      ];
      saving = saving
        .then(() => deps.saveMessages?.(owner, threadId, messages))
        .catch(() => undefined);
    };
    save(true);
    const send = (event: AguiEvent) => {
      record.handle(event);
      if (
        event.type === "TOOL_CALL_RESULT" ||
        event.type === "TEXT_MESSAGE_END" ||
        event.type === "RUN_FINISHED" ||
        event.type === "RUN_ERROR"
      )
        save();
      onEvent?.(event);
    };
    const ctx: RunContext = {
      chat,
      deps,
      owner,
      input,
      send,
      signal: stopper.signal,
      inflight,
      settled: false,
      onAbort: () => undefined,
    };
    return (async () => {
      try {
        await runOpencodeTurn(ctx);
      } finally {
        settleRun(ctx);
        if (stoppers.get(threadId) === stopper) stoppers.delete(threadId);
        save();
        await saving;
        settling.delete(threadId);
        if (!chat) {
          await deps.runMarks?.clear(threadId).catch(() => undefined);
          // What was said while it worked is answered next, without anyone having to be there.
          const next = pending.get(threadId);
          pending.delete(threadId);
          if (next && deps.loadMessages) {
            const messages = await deps.loadMessages(next, threadId);
            const run = launch(next, { threadId, runId: `run-${Date.now()}`, messages });
            void run?.catch(() => undefined);
          }
        }
      }
    })();
  };
  /**
   * Start the agent on a thread from what is already written in it, with no page attached. A thread
   * made from a channel message is started this way, so closing the page right after posting does
   * not leave the message unanswered.
   */
  /** A message sent while the agent is working: written into the thread, and answered when it is free. */
  /** A message for a thread: written into it, and answered at once if the agent is free, or when it is. */
  const queueMessage = async (
    owner: string,
    threadId: string,
    message: { id: string; content: string },
  ): Promise<{ queued: boolean }> => {
    if (!deps.saveMessages || !deps.loadMessages) throw new Error("Messages cannot be kept here");
    await deps.saveMessages(owner, threadId, [
      { id: message.id, role: "user", content: message.content },
    ]);
    if (settling.has(threadId)) {
      pending.set(threadId, owner);
      return { queued: true };
    }
    const messages = await deps.loadMessages(owner, threadId);
    const run = launch(owner, { threadId, runId: `run-${Date.now()}`, messages });
    void run?.catch(() => undefined);
    return { queued: false };
  };
  app.post("/queue", async (c) => {
    const owner = c.get("owner");
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: unknown;
      message?: { id?: unknown; content?: unknown };
    };
    const { threadId, message } = body;
    if (
      typeof threadId !== "string" ||
      !threadId ||
      typeof message?.id !== "string" ||
      typeof message.content !== "string" ||
      !deps.saveMessages ||
      !deps.loadMessages
    )
      return c.json({ error: "Invalid message" }, 400);
    return c.json(
      await queueMessage(owner, threadId, { id: message.id, content: message.content }),
    );
  });
  app.post("/start", async (c) => {
    const owner = c.get("owner");
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown };
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threadId || !deps.loadMessages) return c.json({ error: "Invalid start" }, 400);
    const messages = await deps.loadMessages(owner, threadId);
    const run = launch(owner, { threadId, runId: `run-${Date.now()}`, messages });
    if (!run) return c.json({ started: false });
    void run.catch(() => undefined);
    return c.json({ started: true });
  });
  app.post("/run", async (c) => {
    const owner = c.get("owner");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = runInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid run input" }, 400);
    const busy = () => c.json({ error: "A run is already in progress on this thread" }, 409);
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const run = launch(owner, parsed.data, (event) => {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        // Nobody is reading any more; the run carries on and is written down as it goes.
      }
    });
    if (!run) return busy();
    void run.finally(() => {
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
  /**
   * After a restart (an update, a reboot), carry on the replies that were being written. Each goes
   * back in from the conversation as it was saved, so the agent sees what it had already done.
   */
  const resume = async () => {
    const marks = (await deps.runMarks?.all().catch(() => [])) ?? [];
    for (const mark of marks) {
      await deps.runMarks?.clear(mark.threadId).catch(() => undefined);
      if (Date.now() - mark.startedAt > 30 * 60_000 || !deps.loadMessages) continue;
      const messages = await deps.loadMessages(mark.owner, mark.threadId).catch(() => []);
      const run = launch(mark.owner, {
        threadId: mark.threadId,
        runId: `run-${Date.now()}`,
        messages,
      });
      void run?.catch(() => undefined);
    }
  };
  /** Stop the run on a thread, if there is one. */
  const stop = (threadId: string) => {
    pending.delete(threadId);
    stoppers.get(threadId)?.abort();
  };
  return Object.assign(app, { resume, launch, stop, queueMessage });
}
