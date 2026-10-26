import type { WatchFinding, WatchMode } from "../../../../packages/domain/src/agent-watch.ts";
import type { OpenCodeEvent } from "../opencode/events.ts";
import { classify, type WatchSetup } from "./classify.ts";

/** What one run is, as far as the watch needs to know. */
export interface WatchRun {
  scope: WatchFinding["scope"];
  /** The run the chat service started, when it was one. */
  runId?: string;
  /** Where the run works, and so what it may open without being marked. */
  directory: string;
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

  constructor(private readonly deps: WatchDeps) {}

  setMode(mode: WatchMode) {
    this.mode = mode;
  }

  get current(): WatchMode {
    return this.mode;
  }

  /** The handler for one run's events. */
  forRun(run: WatchRun): (event: OpenCodeEvent) => void {
    const setup: WatchSetup = { dataDir: this.deps.dataDir, allowedDirs: [run.directory] };
    const seen = new Set<string>();
    const looked = new Set<string>();
    return (event) => {
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
      for (const found of classify({
        tool,
        input,
        cwd: run.directory,
        env: this.deps.env,
        setup,
      })) {
        const mark = `${found.rule}:${found.target}`;
        if (seen.has(mark) || seen.size >= PER_RUN) continue;
        seen.add(mark);
        const command = (input as { command?: unknown }).command;
        this.report({
          source: found.source,
          scope: run.scope,
          ...(run.runId ? { runId: run.runId } : {}),
          tool,
          target: found.target.slice(0, 500),
          ...(typeof command === "string" ? { command: command.slice(0, 500) } : {}),
          rule: found.rule,
          severity: found.severity,
          action: "marked",
          mode: this.mode,
        });
      }
    };
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
