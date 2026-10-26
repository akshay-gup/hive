/**
 * The way out of a run to the screen. Everything the agent does reaches a person through the worker as
 * these events, so the worker can hold some back for a moment, or say of a result that it is withheld,
 * before anyone sees it. That is what lets a read that is noticed a moment late still be kept off the
 * screen: the result waits here a few hundred milliseconds, and a flag that arrives in that time hides it.
 */

type AguiEvent = Record<string, unknown>;

/** What a result is replaced with. */
export const WITHHELD = "Withheld: this is the workspace's own data.";

/** The tools whose results are held a moment: what the agent reads from the machine itself. */
const HELD_TOOLS = new Set([
  "bash",
  "shell",
  "read",
  "grep",
  "glob",
  "list",
  "edit",
  "write",
  "patch",
  "apply_patch",
]);

/** What ends a run, which gets through even once the run is shut. */
const ENDS = new Set(["RUN_ERROR", "RUN_FINISHED"]);

interface Held {
  event: AguiEvent;
  due: number;
}

export interface EgressOptions {
  /** How long a result of one of the tools above is held; 0 holds nothing. Asked for each result. */
  holdMs: () => number;
  now?: () => number;
  /** Starts a timer; tests stand in for it. */
  later?: (ms: number, work: () => void) => { cancel: () => void };
}

export class Egress {
  private readonly names = new Map<string, string>();
  private readonly withheld = new Set<string>();
  private queue: Held[] = [];
  private timer: { cancel: () => void } | null = null;
  private shut = false;

  constructor(
    private readonly out: (event: AguiEvent) => void,
    private readonly options: EgressOptions,
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** Let an event through, in order: at once if nothing is held ahead of it. */
  push(event: AguiEvent): void {
    if (event.type === "TOOL_CALL_START")
      this.names.set(String(event.toolCallId), String(event.toolCallName ?? ""));
    if (this.shut && !ENDS.has(String(event.type)) && event.type !== "TOOL_CALL_RESULT") return;
    const hold = this.holdFor(event);
    if (hold === 0 && this.queue.length === 0) {
      this.release(event);
      return;
    }
    const behind = this.queue.at(-1)?.due ?? 0;
    this.queue.push({ event, due: Math.max(behind, hold ? this.now() + hold : 0) });
    this.arm();
  }

  /** Say of one call that its result is not to be shown, whether it has come yet or not. */
  withhold(callId: string): void {
    this.withheld.add(callId);
  }

  /**
   * The run is shut: nothing more is shown but its end, and every result still waiting is withheld.
   * What was held goes out now, rewritten, so nothing waits on a timer.
   */
  shutDown(): void {
    this.shut = true;
    this.drain(true);
  }

  /** The run is over: everything held goes out as it is, in order. */
  flushNow(): void {
    this.drain(true);
  }

  private holdFor(event: AguiEvent): number {
    if (this.shut || event.type !== "TOOL_CALL_RESULT") return 0;
    const name = this.names.get(String(event.toolCallId));
    if (!name || !HELD_TOOLS.has(name)) return 0;
    return Math.max(0, this.options.holdMs());
  }

  private release(event: AguiEvent): void {
    if (event.type === "TOOL_CALL_RESULT") {
      const id = String(event.toolCallId);
      if (this.shut || this.withheld.has(id)) {
        this.out({ ...event, content: WITHHELD });
        return;
      }
    }
    if (this.shut && !ENDS.has(String(event.type))) return;
    this.out(event);
  }

  private drain(all: boolean): void {
    this.timer?.cancel();
    this.timer = null;
    const now = this.now();
    while (this.queue.length && (all || (this.queue[0] as Held).due <= now)) {
      const next = this.queue.shift() as Held;
      this.release(next.event);
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer || this.queue.length === 0) return;
    const wait = Math.max(0, (this.queue[0] as Held).due - this.now());
    const later =
      this.options.later ??
      ((ms, work) => {
        const handle = setTimeout(work, ms);
        (handle as unknown as { unref?: () => void }).unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = later(wait, () => {
      this.timer = null;
      this.drain(false);
    });
  }
}
