import { resolve } from "node:path";
import type { WatchFinding, WatchMode } from "../../../../packages/domain/src/agent-watch.ts";
import { WATCH_DOWN_TEXT } from "../../../../packages/domain/src/agent-watch.ts";
import type { OpenCodeEvent } from "../opencode/events.ts";
import type { PermissionRuleset } from "../opencode/permissions.ts";
import { classify, classifyAsk, realOrSelf, ruleOfPath, type WatchSetup } from "./classify.ts";

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
  onSerious?: (info: { callId?: string; finding: WatchFinding }) => boolean | undefined;
}

/** A read the kernel saw of the machine's own data (see kernel.ts). */
export interface KernelRead {
  path: string;
  cwd: string;
  comm: string;
  exe: string;
  pid: number;
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
/** How long a result waits for the kernel's word (it usually comes in a few hundred milliseconds). */
const KERNEL_HOLD_MS = 500;

/** What one run's watch is: the handler of its events, and the verdict on what it asks leave for. */
export type RunWatch = ((event: OpenCodeEvent) => void) & {
  /** The run is over: the kernel's reads are no longer matched to it. */
  end: () => void;
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
  /** The runs that are going, so a read the kernel saw can be matched to the one that made it. */
  private readonly going = new Set<{
    run: WatchRun;
    read: (read: KernelRead) => void;
    stop: (finding: WatchFinding) => void;
  }>();
  private down = false;

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

  /**
   * What OpenCode is told never to let the agent open, in the stricter mode: the machine's data folder, the machine's
   * settings and the updater's folder. A folder the run works in is not "outside" for OpenCode, so the run's own
   * folder is untouched. It is a rule OpenCode applies in every mode, ask or auto, for chats and tasks alike.
   */
  denyRules(): PermissionRuleset {
    if (this.mode !== "enforce") return [];
    const base = realOrSelf(resolve(this.deps.dataDir));
    const roots = [...new Set([resolve(this.deps.dataDir), base, "/etc/hive", "/var/lib/hive"])];
    return roots.map((root) => ({
      permission: "external_directory",
      pattern: `${root}/*`,
      action: "deny" as const,
    }));
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
      if (this.mode === "enforce" && found.severity !== "low") {
        // If the run was stopped for it, the mark says so.
        if (run.onSerious?.({ callId, finding })) finding.action = "blocked";
      }
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
    const entry = {
      run,
      read: (read: KernelRead) => {
        const found = ruleOfPath(read.path, this.deps.dataDir);
        if (found)
          mark({ ...found, target: read.path, source: "kernel" }, read.comm, read.exe, "marked");
      },
      stop: (finding: WatchFinding) => {
        if (this.mode === "enforce") run.onSerious?.({ finding });
      },
    };
    this.going.add(entry);
    return Object.assign(handle, { asked, end: () => this.going.delete(entry) });
  }

  /**
   * The kernel saw a read of the machine's own data by something that is not the server. It is the run whose
   * folder the reader was working in, or the only run going, or no run we know of.
   */
  kernelRead(read: KernelRead): void {
    const found = ruleOfPath(read.path, this.deps.dataDir);
    if (!found) return;
    const inside = (dir: string) => read.cwd === dir || read.cwd.startsWith(`${dir}/`);
    const runs = [...this.going];
    const matched = runs.filter((entry) => inside(entry.run.directory));
    const targets = matched.length ? matched : runs.length === 1 ? runs : [];
    if (targets.length) {
      for (const entry of targets) entry.read(read);
      return;
    }
    this.report({
      source: "kernel",
      scope: "machine",
      tool: read.comm.slice(0, 100),
      target: read.path.slice(0, 500),
      ...(read.exe ? { command: read.exe.slice(0, 500) } : {}),
      rule: found.rule,
      severity: found.severity,
      action: "marked",
      mode: this.mode,
    });
  }

  /** The kernel watch has stopped working, or is working again. */
  kernelDown(down: boolean, why: string): void {
    if (down === this.down) return;
    this.down = down;
    if (!down) return;
    const finding: WatchFinding = {
      source: "watch",
      scope: "machine",
      tool: "kernel watch",
      target: why.slice(0, 500),
      rule: "watch",
      severity: "high",
      action: "marked",
      mode: this.mode,
    };
    // With refusing on, nothing runs without the watch: what is running is stopped.
    if (this.mode === "enforce") {
      finding.action = "blocked";
      for (const entry of [...this.going]) entry.stop(finding);
    }
    this.report(finding);
  }

  /** Something about the kernel watch the owner should know, that does not stop anything. */
  kernelNote(why: string): void {
    this.report({
      source: "watch",
      scope: "machine",
      tool: "kernel watch",
      target: why.slice(0, 500),
      rule: "watch",
      severity: "medium",
      action: "marked",
      mode: this.mode,
    });
  }

  /** Why a new run is not to start, if it is not: refusing is on and the kernel watch is down. */
  refusal(): string | null {
    return this.mode === "enforce" && this.down ? WATCH_DOWN_TEXT : null;
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
