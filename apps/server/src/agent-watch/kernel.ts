import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentWatch } from "./watch.ts";

/**
 * What the kernel watch (apps/workspace/src/kernel-watch.ts, run as root) leaves for the server: the reads it
 * saw of the machine's own data, one JSON line each, and a heartbeat that says whether it is working. The
 * server passes the reads to the watch, which matches each to the run that made it, and treats a watch that
 * has gone quiet as a reason to stop what is running when refusing is on.
 */

export interface KernelWatchDeps {
  /** The folder the kernel watch writes in. */
  dir: string;
  watch: AgentWatch;
  now?: () => number;
  /** How often the files are looked at. */
  pollMs?: number;
  /** How long the heartbeat may be silent before the watch is thought down. */
  staleMs?: number;
  /** How long after this server starts the watch is given to show itself. */
  graceMs?: number;
  /** This server's own process id: its reads are expected and not passed on. */
  selfPid?: number;
  log?: (line: string) => void;
}

interface Heartbeat {
  at: number;
  ok: boolean;
  lost: number;
}

export class KernelWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset: number | null = null;
  private inode = 0;
  private partial = "";
  private up: boolean | null = null;
  private lost: number | null = null;
  private readonly began: number;

  constructor(private readonly deps: KernelWatchDeps) {
    this.began = this.now();
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  start() {
    this.deps.watch.setKernel(this);
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 100);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.watch.setKernel(null);
  }

  /** Whether the kernel watch is working: it has said so lately. */
  alive(): boolean {
    return this.up === true;
  }

  private heartbeat(): Heartbeat | null {
    try {
      const beat = JSON.parse(
        readFileSync(join(this.deps.dir, "alive"), "utf8"),
      ) as Partial<Heartbeat>;
      if (typeof beat.at !== "number") return null;
      return { at: beat.at, ok: beat.ok === true, lost: Number(beat.lost ?? 0) };
    } catch {
      return null;
    }
  }

  /** One look at the heartbeat and at what the watch has written since the last. */
  poll(): void {
    this.reads();
    this.health();
  }

  private health(): void {
    const beat = this.heartbeat();
    const now = this.now();
    const stale = !beat || now - beat.at > (this.deps.staleMs ?? 30_000);
    const waiting = this.up === null && now - this.began < (this.deps.graceMs ?? 60_000);
    if (waiting && (stale || !beat?.ok)) return;
    const working = !stale && beat?.ok === true;
    if (working) {
      if (this.up !== true) this.deps.watch.kernelDown(false, "");
      this.up = true;
      // Events the audit system dropped are reads nobody saw.
      if (beat && this.lost !== null && beat.lost > this.lost)
        this.deps.watch.kernelNote(`the audit system lost ${beat.lost - this.lost} events`);
      if (beat) this.lost = beat.lost;
      return;
    }
    if (this.up !== false)
      this.deps.watch.kernelDown(
        true,
        !beat
          ? "the kernel watch has not reported"
          : stale
            ? "the kernel watch went quiet"
            : "the audit system is off",
      );
    this.up = false;
  }

  private reads(): void {
    const file = join(this.deps.dir, "events.jsonl");
    if (!existsSync(file)) {
      // Not there yet: whatever is written when it is made is new.
      if (this.offset === null) this.offset = 0;
      return;
    }
    let size: number;
    let inode: number;
    try {
      const stat = statSync(file);
      size = stat.size;
      inode = stat.ino;
    } catch {
      return;
    }
    // What was there before this server started was read by someone else.
    if (this.offset === null) {
      this.offset = size;
      this.inode = inode;
      return;
    }
    if (inode !== this.inode || size < this.offset) {
      this.offset = 0;
      this.inode = inode;
      this.partial = "";
    }
    const length = size - this.offset;
    if (length <= 0) return;
    const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset += buffer.length;
    const lines = (this.partial + buffer.toString("utf8")).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const read = JSON.parse(line) as {
          path?: string;
          cwd?: string;
          comm?: string;
          exe?: string;
          pid?: number;
        };
        if (typeof read.path !== "string" || read.pid === (this.deps.selfPid ?? process.pid))
          continue;
        this.deps.watch.kernelRead({
          path: read.path,
          cwd: read.cwd ?? "/",
          comm: read.comm ?? "",
          exe: read.exe ?? "",
          pid: Number(read.pid ?? 0),
        });
      } catch (error) {
        this.deps.log?.(`[kernel-watch] a line was not understood: ${String(error)}`);
      }
    }
  }
}
