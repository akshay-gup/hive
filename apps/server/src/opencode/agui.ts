/**
 * Runs of the agent over OpenCode sessions, for the conversations the chat service keeps.
 *
 * The chat service starts a run for a message to the agent (a mention in a channel, or any message in a
 * person's own chat). This translates it into `session.promptAsync` with a synthetic context part ahead of
 * the person's words (the part the model sees but that never surfaces as a turn), and OpenCode's global events
 * into AG-UI events (`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `RUN_STARTED/FINISHED/ERROR`), with synthetic parts
 * filtered on egress and busy/idle derived from `session.status` / `session.idle` only.
 *
 * One run per thread at a time: a second is refused, since two runs on one session would interleave on a
 * single event stream. Prompt dispatch is serialized through the bus's per-thread action queue.
 */
import type { ChannelThread } from "../../../../packages/domain/src/agent.ts";
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
import { ensureThreadSession } from "./sessions.ts";

export interface OpencodeRunDeps {
  service: AgentService;
  bus: OpencodeEventBus;
  pool: OpencodeClientPool;
  config: Config;
  tracker: PermissionTracker;
  hiveTools?: HiveToolBridge;
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

export interface RunInput {
  threadId: string;
  runId: string;
}

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

/** The pattern a mention of the agent matches. */
function mentionPattern(mention: string): RegExp {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Standalone token: not glued to a letter, digit, or underscore on either side,
  // so `@hiveX` and `mail@hive` do not count as mentions.
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, "iu");
}

/** Remove the mention token from prompt text, collapsing leftover whitespace. */
export function stripMention(text: string, mention: string): string {
  return text
    .replace(new RegExp(mentionPattern(mention).source, "giu"), "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PromptFilePart {
  type: "file";
  mime: string;
  url: string;
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
  chat: ChatOrigin;
  deps: OpencodeRunDeps;
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

async function runOpencodeTurn(ctx: RunContext): Promise<void> {
  const { deps, owner, input, send, signal, chat } = ctx;
  const { binding, guest } = chat;
  // A run the chat service started has been checked there, and has its binding made already.
  // Choice panels belong to their conversation, as the transcript does: one set for everyone in a
  // channel's threads, and private to the person in their own chat.
  const jevHome = diskOwnerForChannel(binding.channelId, owner);

  // Picking a card is answering a question the agent asked, so it needs no mention. The pick is
  // checked against its panel, and the agent is told what it says in words rather than as the
  // protocol message the client sent. It may carry a note after it (a run that was picked up again
  // after a restart); the pick itself is the first line.
  let userText = chat.text;
  let picked = false;
  if (userText.startsWith(jevActionPrefix)) {
    try {
      userText = await readChoice(
        deps.service.jev,
        jevHome,
        input.threadId,
        userText.split("\n")[0] ?? userText,
      );
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
  // stale, so the stored panel has to agree even when this turn fails or is cancelled. The turn that
  // retires a panel may still refine it.
  const jev = deps.service.jev;
  if (jev && !picked) {
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

  if (!userText) {
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
        // In a chat the agent always asks first.
        protect: () => deps.watch?.denyRules() ?? [],
      },
      owner,
      input.threadId,
    );
    ctx.session = { sessionId, directory };
    deps.bus.track(input.threadId, sessionId);

    if (deps.hiveTools) {
      const toolInput = {
        ...input,
        messages: [],
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
          latestText: userText, // the person's own words, which the choice cards are judged against
          guest,
          toolset: chat.personal ? "personal" : chat.privateChannel ? "chat-private" : "chat",
          shareFile: chat.shareFile,
          work: chat.work,
        }),
        toolAbort.signal,
        { chat: true },
      );
    }

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
      scope: "channel",
      runId: input.runId,
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
        send({ type: "CUSTOM", name: "prompt-done", value: { requestId } });
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
        send({ type: "CUSTOM", name: "prompt-done", value: { requestId } });
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
            text: chat.context(toolLease?.instructions ?? ""),
          },
          ...chat.files,
          { type: "text", text: userText },
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

export function opencodeRunLauncher(deps: OpencodeRunDeps) {
  // One in-flight run per thread: threadId -> runId. The check-and-set below is
  // synchronous, so concurrent callers for the same thread cannot both pass.
  const inflight = new Map<string, string>();
  /** Runs go on when the page that started them is closed; only a stop ends one early. */
  const stoppers = new Map<string, AbortController>();
  /**
   * Begin a run for a message the chat service sent. What it says is passed to `onEvent` as it goes; the chat
   * service keeps it. Returns undefined when the thread already has a run going.
   */
  const launch = (
    owner: string,
    input: RunInput,
    onEvent: (event: AguiEvent) => void,
    chat: ChatOrigin,
  ): Promise<void> | undefined => {
    const { threadId, runId } = input;
    if (inflight.has(threadId)) return undefined;
    inflight.set(threadId, runId);
    const stopper = new AbortController();
    stoppers.set(threadId, stopper);
    const ctx: RunContext = {
      chat,
      deps,
      owner,
      input,
      send: onEvent,
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
      }
    })();
  };
  /** Stop the run on a thread, if there is one. */
  const stop = (threadId: string) => {
    stoppers.get(threadId)?.abort();
  };
  return { launch, stop };
}
