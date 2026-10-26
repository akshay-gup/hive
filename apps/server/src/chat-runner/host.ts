import type { WatchMode } from "../../../../packages/domain/src/agent-watch.ts";
import type {
  PromptChoice,
  RoomFrame,
  RunnerFrame,
  RunPrompt,
  RunStart,
} from "../../../../packages/domain/src/chat-agent.ts";
import type { ChannelFiles } from "../engine/channel-files.ts";
import type { AgentService } from "../engine/service.ts";
import { type ChatOrigin, stripMention } from "../opencode/agui.ts";
import type { PermissionTracker, TrackerReplyDeps } from "../opencode/approvals.ts";
import { RunRecord } from "../opencode/run-record.ts";
import { buildRunContext, fetchRunFiles } from "./context.ts";
import { prepareRun, threadIdFor } from "./stubs.ts";

/** What the host needs of the OpenCode shim: start a run on a thread, and stop it. */
export interface RunLauncher {
  launch(
    owner: string,
    input: { threadId: string; runId: string; messages: unknown[] },
    onEvent: (event: Record<string, unknown>) => void,
    chat: ChatOrigin,
  ): Promise<void> | undefined;
  stop(threadId: string): void;
}

export interface HostDeps {
  /** The connection to the chat service; the host says only what a frame says. */
  send: (frame: RunnerFrame) => boolean;
  service: AgentService;
  launcher: RunLauncher;
  tracker: PermissionTracker;
  replies: TrackerReplyDeps;
  /** The chat service's address, which the addresses of a message's files are on. */
  origin: () => string | null;
  /** What the room says is to be done when the agent is seen opening the machine's own data. */
  setWatchMode?: (mode: WatchMode) => void;
  /** The folder a channel's work is in. */
  directoryOf: (channelId: string, owner: string) => string;
  /** Reads a file of a channel's folder, to put it in the agent's reply. */
  channelFiles: Pick<ChannelFiles, "read">;
  /** How many runs may go at once. */
  maxRuns?: number;
  /** The name the agent goes by in the chat. */
  name?: string;
  /** The channels this machine keeps something for, and a way to take it all away for one that is deleted. */
  standIns?: () => Promise<string[]>;
  forgetChannel?: (channelId: string) => Promise<void>;
  /** Told when runs begin and end, for whatever waits on the machine to be idle. */
  marks?: {
    set: (runId: string) => void | Promise<void>;
    clear: (runId: string) => void | Promise<void>;
  };
  fetcher?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

interface Active {
  runId: string;
  threadId: string;
  start: RunStart;
  record: RunRecord;
  n: number;
  /** When a snapshot last went, and a trailing one is waiting to. */
  lastSay: number;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** The room no longer wants it (it ended it, or does not know it): nothing more is said of it. */
  dropped: boolean;
  failure: string | null;
  finished: boolean;
  prompts: Map<string, { kind: RunPrompt["kind"]; requestId: string }>;
}

/** The most of one file the agent may put in a reply; the plan's own limit is applied by the room. */
const SHARE_MAX_BYTES = 100 * 1024 * 1024;
const SAY_EVERY_MS = 250;
const BEAT_EVERY_MS = 15_000;
const BODY_MAX = 40_000;
const STEPS_MAX = 600;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The words of a failure, short enough to say in the channel. */
const failureText = (message: string) => `I hit a problem and stopped: ${clip(message, 300)}`;

/**
 * Runs the room's runs on this machine. The room decides what is to be run and for whom; this makes it
 * happen (a session, tools, the model) and reports what the agent said and did as it goes, holds the
 * agent's questions for the people to answer, and says how each run ended until the room confirms it.
 * It keeps nothing of a run when the machine restarts: the room is told by the next hello.
 */
export class ChatRunnerHost {
  private readonly runs = new Map<string, Active>();
  /** How runs ended, kept until the room confirms them. */
  private readonly finals = new Map<string, Extract<RunnerFrame, { t: "run.end" }>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Files being sent: what the room answered to each request, awaited by the one who asked. */
  private readonly asking = new Map<string, (frame: RoomFrame) => void>();

  constructor(private readonly deps: HostDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private log(line: string) {
    this.deps.log?.(`[chat-runner] ${line}`);
  }

  get active(): number {
    return this.runs.size;
  }

  /** The connection is open: say who this is and what it is working on, and say again how runs ended that the room has not confirmed. */
  onOpen() {
    this.deps.send({
      t: "hello",
      v: 1,
      identity: { name: this.deps.name ?? "Hive" },
      capacity: { maxRuns: this.deps.maxRuns ?? 2 },
      active: [...this.runs.values()].map((r) => ({ runId: r.runId, n: r.n })),
    });
    for (const frame of this.finals.values()) this.deps.send(frame);
    // The room says which of the channels kept here are gone, whenever they were deleted.
    void this.reportStandIns();
  }

  private async reportStandIns() {
    try {
      const ids = (await this.deps.standIns?.()) ?? [];
      if (ids.length) this.deps.send({ t: "channels.have", ids });
    } catch (error) {
      this.log(`could not list the channels kept: ${String(error)}`);
    }
  }

  /** What was kept for channels that are gone goes, unless the agent is working in one, which waits. */
  private async forget(ids: string[], tries = 0) {
    const busy: string[] = [];
    for (const id of ids) {
      if ([...this.runs.values()].some((run) => run.start.channel.id === id)) {
        busy.push(id);
        continue;
      }
      try {
        await this.deps.forgetChannel?.(id);
      } catch (error) {
        this.log(`could not clear what was kept for ${id}: ${String(error)}`);
      }
    }
    if (busy.length && tries < 12) {
      const timer = setTimeout(() => void this.forget(busy, tries + 1), 5_000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  onClose() {
    // Runs go on without the connection; what they say is said again, in full, at the next snapshot.
  }

  onFrame(frame: RoomFrame) {
    switch (frame.t) {
      case "watch":
        this.deps.setWatchMode?.(frame.mode);
        return;
      case "welcome": {
        this.deps.setWatchMode?.(frame.watch ?? "audit");
        // What the room does not want kept is stopped, and nothing more is said of it.
        const keep = new Set(frame.resume);
        for (const run of this.runs.values())
          if (!keep.has(run.runId)) {
            run.dropped = true;
            this.deps.launcher.stop(run.threadId);
          }
        return;
      }
      case "run.start":
        void this.start(frame.run).catch((error) => {
          this.log(`could not start ${frame.run.id}: ${String(error)}`);
        });
        return;
      case "run.answer":
        void this.answer(frame).catch((error) => {
          this.log(`could not pass on an answer: ${String(error)}`);
        });
        return;
      case "run.stop": {
        const run = this.runs.get(frame.runId);
        if (!run) return;
        // The room has ended it already, whatever it was stopped for: nothing more is said.
        run.dropped = true;
        run.stopped = true;
        this.deps.launcher.stop(run.threadId);
        return;
      }
      case "ack":
        this.finals.delete(frame.runId);
        return;
      case "channels.gone":
        void this.forget(frame.ids);
        return;
      case "file.upload":
      case "file.attached":
      case "file.refused":
        this.asking.get(frame.reqId)?.(frame);
        return;
      case "closing":
        return;
    }
  }

  // Beating while anything is going

  private beating() {
    if (this.beat || this.runs.size === 0) return;
    this.beat = setInterval(() => {
      if (this.runs.size === 0) {
        if (this.beat) clearInterval(this.beat);
        this.beat = null;
        return;
      }
      this.deps.send({ t: "beat", runIds: [...this.runs.keys()] });
    }, BEAT_EVERY_MS);
    (this.beat as unknown as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    for (const run of this.runs.values()) {
      run.dropped = true;
      if (run.timer) clearTimeout(run.timer);
      this.deps.launcher.stop(run.threadId);
    }
  }

  // A run

  private async start(start: RunStart) {
    const known = this.runs.get(start.id);
    if (known) {
      // Sent again (the room asked twice): it is being worked on.
      this.deps.send({ t: "run.ack", runId: start.id });
      return;
    }
    const finished = this.finals.get(start.id);
    if (finished) {
      this.deps.send(finished);
      return;
    }
    const threadId = threadIdFor(start.thread.rootId);
    if (this.runs.size >= (this.deps.maxRuns ?? 2)) {
      this.fail(start, "I am busy with other requests. Try again in a moment.");
      return;
    }
    const record = new RunRecord();
    // Carrying on after a restart: the reply goes on from what it held.
    if (start.resume) record.seed(start.resume.steps);
    const run: Active = {
      runId: start.id,
      threadId,
      start,
      record,
      n: 0,
      lastSay: 0,
      timer: null,
      stopped: false,
      dropped: false,
      failure: null,
      finished: false,
      prompts: new Map(),
    };
    this.runs.set(start.id, run);
    void Promise.resolve(this.deps.marks?.set(start.id)).catch(() => undefined);
    this.beating();
    this.deps.send({ t: "run.ack", runId: start.id });

    let done: Promise<void> | undefined;
    try {
      const { binding } = await prepareRun(this.deps.service, start);
      const origin = this.deps.origin();
      const directory = this.deps.directoryOf(start.channel.id, start.asker.id);
      const files =
        origin && start.files.length
          ? await fetchRunFiles(start, origin, directory, this.deps.fetcher)
          : { parts: [], saved: [], missing: start.files.map((f) => f.name) };
      const missing = files.missing.length
        ? ` (Could not fetch: ${files.missing.join(", ")}.)`
        : "";
      const chat: ChatOrigin = {
        binding,
        guest: start.asker.role === "guest",
        privateChannel: start.channel.visibility === "private",
        context: (toolNotes) => buildRunContext(start, toolNotes, files.saved) + missing,
        // The request is said again: the session it was in may be gone, and then it is all the agent has.
        text: start.resume
          ? `${stripMention(start.text, "@hive") || start.text}\n\n(The machine you were running on restarted while you were answering this. Carry on from where you left off and finish your answer. Do not repeat what you have already done or said.)`
          : stripMention(start.text, "@hive") || start.text,
        files: files.parts,
        shareFile: (path) => this.shareFile(run, path),
      };
      done = this.deps.launcher.launch(
        start.asker.id,
        { threadId, runId: start.id, messages: [] },
        (event) => this.onEvent(run, event),
        chat,
      );
      if (!done) run.failure = "This conversation already has a run going. Try again in a moment.";
    } catch (error) {
      run.failure = error instanceof Error ? error.message : String(error);
    }
    try {
      await done;
    } catch (error) {
      run.failure ??= error instanceof Error ? error.message : String(error);
    }
    this.finish(run);
  }

  /** A run that could not be taken up at all. */
  private fail(start: RunStart, message: string) {
    const frame: Extract<RunnerFrame, { t: "run.end" }> = {
      t: "run.end",
      runId: start.id,
      n: 1,
      status: "failed",
      body: message,
      steps: [],
      error: clip(message, 500),
    };
    this.finals.set(start.id, frame);
    this.deps.send(frame);
  }

  /** One request to the room and its answer, or a failure in time. */
  private request(
    frame: Extract<RunnerFrame, { t: "file.begin" | "file.done" }>,
    ms = 30_000,
  ): Promise<RoomFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asking.delete(frame.reqId);
        reject(new Error("The chat service did not answer"));
      }, ms);
      this.asking.set(frame.reqId, (answer) => {
        clearTimeout(timer);
        this.asking.delete(frame.reqId);
        resolve(answer);
      });
      if (!this.deps.send(frame)) {
        clearTimeout(timer);
        this.asking.delete(frame.reqId);
        reject(new Error("Not connected to the chat service"));
      }
    });
  }

  /**
   * Put a file from the channel's folder in the run's reply: the room says where to send the bytes, the
   * bytes go there, and the room attaches the file. It is the asker's file as far as quota and size go.
   */
  private async shareFile(
    run: Active,
    path: string,
  ): Promise<{ sent: true } | { sent: false; error: string }> {
    const origin = this.deps.origin();
    if (!origin) return { sent: false, error: "Not connected to the chat service" };
    try {
      const { file, bytes } = await this.deps.channelFiles.read(
        run.start.asker.id,
        run.start.channel.id,
        path,
        SHARE_MAX_BYTES,
      );
      if (!bytes.length) return { sent: false, error: "That file is empty" };
      const reqId = crypto.randomUUID();
      const began = await this.request({
        t: "file.begin",
        runId: run.runId,
        reqId,
        name: file.name,
        mime: file.mimeType || "application/octet-stream",
        bytes: bytes.length,
      });
      if (began.t === "file.refused") return { sent: false, error: began.error };
      if (began.t !== "file.upload")
        return { sent: false, error: "The chat service did not answer" };
      const put = await (this.deps.fetcher ?? fetch)(`${origin}${began.path}`, {
        method: "PUT",
        headers: { "content-length": String(bytes.length) },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(120_000),
      });
      if (!put.ok) {
        const reason = ((await put.json().catch(() => ({}))) as { error?: string }).error;
        return { sent: false, error: reason ?? "The file could not be sent" };
      }
      const done = await this.request({
        t: "file.done",
        runId: run.runId,
        reqId,
        fileId: began.fileId,
      });
      return done.t === "file.attached"
        ? { sent: true }
        : { sent: false, error: done.t === "file.refused" ? done.error : "The file was not added" };
    } catch (error) {
      return { sent: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private snapshot(run: Active): { body: string; steps: unknown[] } {
    const messages = run.record.messages();
    const body = messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content)
      .map((m) => String(m.content))
      .join("\n\n");
    return { body: clip(body, BODY_MAX), steps: messages.slice(-STEPS_MAX) };
  }

  private say(run: Active) {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (run.dropped || run.finished) return;
    run.lastSay = this.now();
    const { body, steps } = this.snapshot(run);
    run.n++;
    this.deps.send({ t: "run.say", runId: run.runId, n: run.n, body, steps });
  }

  /** At most about four snapshots a second; one more follows what is left over. */
  private saySoon(run: Active) {
    if (run.timer || run.dropped || run.finished) return;
    const wait = Math.max(0, SAY_EVERY_MS - (this.now() - run.lastSay));
    if (wait === 0) return this.say(run);
    run.timer = setTimeout(() => this.say(run), wait);
    (run.timer as unknown as { unref?: () => void }).unref?.();
  }

  private onEvent(run: Active, event: Record<string, unknown>) {
    if (run.dropped) return;
    run.record.handle(event);
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
      case "TOOL_CALL_START":
      case "TOOL_CALL_ARGS":
      case "TOOL_CALL_RESULT":
        this.saySoon(run);
        return;
      case "RUN_ERROR":
        run.failure = String(event.message ?? "The run failed");
        return;
      case "CUSTOM":
        this.onCustom(run, String(event.name), event.value as Record<string, unknown>);
        return;
      default:
        return;
    }
  }

  private onCustom(run: Active, name: string, value: Record<string, unknown> | undefined) {
    const requestId = typeof value?.requestId === "string" ? value.requestId : "";
    if (!requestId) return;
    if (name === "permission-requested") {
      const patterns = Array.isArray(value?.patterns) ? (value.patterns as string[]) : [];
      const permission = String(value?.permission ?? "something");
      const metadata = value?.metadata;
      const detail =
        metadata && typeof metadata === "object" && Object.keys(metadata).length
          ? clip(JSON.stringify(metadata, null, 2), 4000)
          : undefined;
      this.ask(run, requestId, {
        kind: "approval",
        id: clip(requestId, 100),
        title: clip(`${permission}${patterns.length ? `: ${patterns.join(", ")}` : ""}`, 300),
        ...(detail ? { detail } : {}),
        tool: clip(permission, 100),
      });
    } else if (name === "question-requested") {
      const asked = Array.isArray(value?.questions)
        ? (value.questions as Array<Record<string, unknown>>)
        : [];
      this.ask(run, requestId, {
        kind: "question",
        id: clip(requestId, 100),
        questions: asked.slice(0, 8).map((q) => ({
          header: clip(String(q.header ?? ""), 200),
          question: clip(String(q.question ?? ""), 2000),
          options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [])
            .slice(0, 12)
            .map((o) => ({
              label: clip(String(o.label ?? ""), 200),
              description: clip(String(o.description ?? ""), 500),
            })),
          ...(typeof q.multiple === "boolean" ? { multiple: q.multiple } : {}),
          ...(typeof q.custom === "boolean" ? { custom: q.custom } : {}),
        })),
      });
    } else if (name === "prompt-done") {
      for (const [promptId, p] of run.prompts)
        if (p.requestId === requestId) {
          run.prompts.delete(promptId);
          this.deps.send({ t: "run.asked.done", runId: run.runId, promptId });
        }
    }
  }

  private ask(run: Active, requestId: string, prompt: RunPrompt) {
    run.prompts.set(prompt.id, { kind: prompt.kind, requestId });
    // What is waiting is shown with the latest of what was said, and is said to come after it.
    const { body, steps } = this.snapshot(run);
    this.say(run);
    this.deps.send({
      t: "run.ask",
      runId: run.runId,
      prompt,
      requestId,
      after: { steps: steps.length, chars: body.length },
    });
  }

  private async answer(frame: Extract<RoomFrame, { t: "run.answer" }>) {
    const run = this.runs.get(frame.runId);
    const asked = run?.prompts.get(frame.promptId);
    if (!run || !asked) return;
    const choice: PromptChoice = frame.choice;
    if (asked.kind === "approval") {
      const reply = "reply" in choice ? choice.reply : "reject";
      await this.deps.tracker.reply(this.deps.replies, asked.requestId, reply);
    } else {
      await this.deps.tracker.answerQuestion(
        this.deps.replies,
        asked.requestId,
        "answers" in choice ? choice.answers : null,
      );
    }
  }

  private finish(run: Active) {
    run.finished = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.runs.delete(run.runId);
    void Promise.resolve(this.deps.marks?.clear(run.runId)).catch(() => undefined);
    if (run.dropped) return;
    const { body, steps } = this.snapshot(run);
    const stopped = run.stopped;
    const failed = !stopped && run.failure !== null;
    run.n++;
    const frame: Extract<RunnerFrame, { t: "run.end" }> = {
      t: "run.end",
      runId: run.runId,
      n: run.n,
      status: stopped ? "stopped" : failed ? "failed" : "done",
      body: failed && !body ? failureText(run.failure ?? "") : body,
      steps,
      ...(failed ? { error: clip(run.failure ?? "", 500) } : {}),
    };
    this.finals.set(run.runId, frame);
    this.deps.send(frame);
  }
}
