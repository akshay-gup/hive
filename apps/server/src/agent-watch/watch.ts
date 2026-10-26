import type { WatchFinding, WatchMode } from "../../../../packages/domain/src/agent-watch.ts";
import type { OpenCodeEvent } from "../opencode/events.ts";
import { classify, classifyAsk, type WatchSetup } from "./classify.ts";

/** What one run is, as far as the watch needs to know. */
export interface WatchRun {
  scope: WatchFinding["scope"];
  /** The run the chat service started, when it was one. */
  runId?: string;
  /** Where the run works, and so what it may open without being marked. */
  directory: string;
  /**
   * Told when the run does something that reaches the machine's own data, in the stricter mode: with the call,
   * if it was one tool call, so its result can be kept from the screen.
   */
  onSerious?: (info: { callId?: string; finding: WatchFinding }) => void;
}

export interface WatchDeps {
  dataDir: string;
  env: Record<string, string | undefined>;
  /** Tell the chat service; false when it cannot be reached just now. */
  send: (frame: { t: "agent.flag"; finding: WatchFinding }) => boolean;
  log?: (line: string) => void;
}

/** The most a single run is marked for, and the most kept for a moment when the chat service is out of reach. */
const PER_RUN = 50;
const KEPT = 100;
/** How long a result waits for the kernel's word (it usually comes in a few milliseconds). */
const KERNEL_HOLD_MS = 300;

/** What one run's watch is: the handler of its events, and the verdict on what it asks leave for. */
export type RunWatch = ((event: OpenCodeEvent) => void) & {
  /** True if the agent is to be refused what it asked leave for (see `refuses`). */
  asked: (ask: { permission: string; patterns: string[]; metadata?: unknown }) => boolean;
};

/** The name a tool has once the Hive bridge's prefix is taken off. */
const plain = (tool: string) => tool.replace(/^hive_[a-f0-9]{16}_/, "");

/**
 * Watches what the agent opens. It reads each tool call of a run as it happens (the same events the
 * conversation is built from), marks what reaches the machine's own data, and tells the chat service,
 * which tells the owner and admins. Nothing here stops the agent: it is a mark, not a lock (see classify).
 */
export class AgentWatch {
  private mode: WatchMode = "audit";
  private kept: WatchFinding[] = [];
  /** The kernel watch, when this machine has one, which is what makes holding results back worth it. */
  private kernel: { alive: () => boolean } | null = null;

  constructor(private readonly deps: WatchDeps) {}

  setMode(mode: WatchMode) {
    this.mode = mode;
  }

  get current(): WatchMode {
    return this.mode;
  }

  setKernel(kernel: { alive: () => boolean } | null) {
    this.kernel = kernel;
  }

  /** How long a result of the agent's shell or file tools is held before it is shown: only while a kernel flag could still hide it. */
  holdMs(): number {
    return this.mode === "enforce" && this.kernel?.alive() ? KERNEL_HOLD_MS : 0;
  }

  /** The handler for one run's events. */
  forRun(run: WatchRun): RunWatch {
    const setup: WatchSetup = { dataDir: this.deps.dataDir, allowedDirs: [run.directory] };
    const seen = new Set<string>();
    const looked = new Set<string>();
    const mark = (
      found: {
        rule: string;
        severity: WatchFinding["severity"];
        target: string;
        source: WatchFinding["source"];
      },
      tool: string,
      command: string | undefined,
      action: WatchFinding["action"],
      callId?: string,
    ) => {
      const key = `${found.rule}:${found.target}`;
      const finding: WatchFinding = {
        source: found.source,
        scope: run.scope,
        ...(run.runId ? { runId: run.runId } : {}),
        tool,
        target: found.target.slice(0, 500),
        ...(command ? { command: command.slice(0, 500) } : {}),
        rule: found.rule,
        severity: found.severity,
        action,
        mode: this.mode,
      };
      // Said every time, even of what was marked before: each call's result has to be kept back.
      if (this.mode === "enforce" && found.severity !== "low") run.onSerious?.({ callId, finding });
      if (seen.has(key) || seen.size >= PER_RUN) return;
      seen.add(key);
      this.report(finding);
    };
    const handle = (event: OpenCodeEvent) => {
      if (event.type !== "message.part.updated") return;
      const part = event.properties.part as
        | {
            type?: string;
            callID?: string;
            tool?: string;
            state?: { status?: string; input?: unknown };
          }
        | undefined;
      if (part?.type !== "tool" || !part.callID || !part.tool || !part.state) return;
      const tool = plain(part.tool);
      const input = part.state.input;
      // A call is announced before its arguments are known.
      if (!input || typeof input !== "object" || Object.keys(input).length === 0) return;
      const key = `${part.callID}:${JSON.stringify(input).length}`;
      if (looked.has(key)) return;
      looked.add(key);
      const command = (input as { command?: unknown }).command;
      for (const found of classify({
        tool,
        input,
        cwd: run.directory,
        env: this.deps.env,
        setup,
      }))
        mark(found, tool, typeof command === "string" ? command : undefined, "marked", part.callID);
    };
    const asked: RunWatch["asked"] = (ask) => {
      const findings = classifyAsk({
        ...ask,
        cwd: run.directory,
        env: this.deps.env,
        setup,
      });
      const serious = findings.filter((found) => found.severity !== "low");
      const refuse = this.mode === "enforce" && serious.length > 0;
      const said = (ask.metadata as { command?: unknown } | undefined)?.command;
      const command =
        ask.permission === "bash"
          ? typeof said === "string"
            ? said
            : ask.patterns.join(" ; ")
          : undefined;
      for (const found of findings)
        mark(
          found,
          ask.permission,
          command,
          refuse && serious.includes(found) ? "blocked" : "marked",
        );
      return refuse;
    };
    return Object.assign(handle, { asked });
  }

  /** Say that something was seen; kept for a little if the chat service cannot be reached. */
  report(finding: WatchFinding) {
    this.deps.log?.(
      `[watch] ${finding.rule} ${finding.target} (${finding.scope}, ${finding.severity})`,
    );
    this.kept.push(finding);
    if (this.kept.length > KEPT) this.kept.shift();
    this.flush();
  }

  /** Send what is kept; what cannot go stays for the next try. */
  flush() {
    while (this.kept.length) {
      const next = this.kept[0] as WatchFinding;
      if (!this.deps.send({ t: "agent.flag", finding: next })) return;
      this.kept.shift();
    }
  }
}
