import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AUDIT_KEY, AuditParser, type AuditRead } from "./kernel-audit.ts";

/**
 * The kernel watch, run as root. It asks the kernel's audit system to note every read of the workspace's own
 * data (its database, key, files kept for everyone), leaving out the workspace server's own process, reads the
 * log the audit daemon writes, and puts what it finds where the server can read it: a line a read in
 * `events.jsonl`, and a heartbeat in `alive` that says whether the watch is working. It only marks; what to
 * do about a read is the server's say (see apps/server/src/agent-watch/kernel.ts).
 */

export interface WatcherDeps {
  /** Runs `auditctl` with these arguments and gives what it printed; throws if it failed. */
  ctl: (args: string[]) => string;
  /** The folder the server reads from: `events.jsonl` and `alive` are in it. */
  dir: string;
  /** What to watch. */
  roots: string[];
  /** Where the supervisor writes the server's process id. */
  serverPidFile: string;
  /** Process ids (the supervisor's) whose reads are the machine's own: expected, never passed on. */
  trustedPidFiles?: string[];
  /** The agent's process id: its own file tools are read by the server's check of each call, so only what its commands read is passed on. */
  agentPidFile?: string;
  /** The folder of the agents' work areas (`owners/`), if watched: what a process reads in the folder it works in is not passed on. */
  ownersRoot?: string;
  /** The audit daemon's log. */
  auditLog: string;
  now?: () => number;
  /** Whether a process is there (tests stand in for it). */
  alive?: (pid: number) => boolean;
  /** The most the events file grows to before it is started over. */
  maxEventsBytes?: number;
  /** How many rounds between heartbeats. */
  beatEvery?: number;
  log?: (line: string) => void;
}

const SERVICE_MANAGER = new Set(["/usr/lib/systemd/systemd", "/lib/systemd/systemd"]);
const READ_AT_MOST = 4 * 1024 * 1024;

export class KernelWatcher {
  private offset: number | null = null;
  private inode = 0;
  private readonly parser = new AuditParser();
  private appliedPid: number | null | undefined;
  private appliedRoots = "";
  private rulesOk = false;
  private quiet = 0;

  constructor(private readonly deps: WatcherDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private serverPid(): number | null {
    try {
      const pid = Number(readFileSync(this.deps.serverPidFile, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return (this.deps.alive ?? ((p) => existsSync(`/proc/${p}`)))(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private pidOf(file: string | undefined): number | null {
    if (!file) return null;
    try {
      const pid = Number(readFileSync(file, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Whether a read is one nobody needs told of: the machine's own processes, and a process in its own work folder. */
  private expected(read: AuditRead): boolean {
    // The service manager hands a unit its credentials (the tunnel's token) from a process of its own.
    if (read.pid === 1 || read.pid === process.pid || SERVICE_MANAGER.has(read.exe)) return true;
    if (this.deps.trustedPidFiles?.some((file) => this.pidOf(file) === read.pid)) return true;
    const owners = this.deps.ownersRoot;
    if (!owners || !read.path.startsWith(`${owners}/`)) return false;
    if (read.pid === this.pidOf(this.deps.agentPidFile)) return true;
    const unit = (path: string) => {
      const parts = path.slice(owners.length + 1).split("/");
      return parts[1] === "channels" && parts[2] ? parts.slice(0, 3).join("/") : (parts[0] ?? "");
    };
    return read.cwd.startsWith(`${owners}/`) && unit(read.cwd) === unit(read.path);
  }

  /** Make the audit rules what they should be: the server left out, each watched path that exists watched. */
  private rules(pid: number | null): void {
    const roots = this.deps.roots.filter((root) => existsSync(root));
    const key = roots.join("\n");
    if (this.rulesOk && this.appliedPid === pid && this.appliedRoots === key) return;
    try {
      this.deps.ctl(["-D"]);
      this.deps.ctl(["-b", "8192"]);
      this.deps.ctl(["-f", "1"]);
      if (pid)
        this.deps.ctl([
          "-a",
          "never,exit",
          "-F",
          "arch=b64",
          "-S",
          "open,openat,openat2",
          "-F",
          `pid=${pid}`,
        ]);
      for (const root of roots) this.deps.ctl(["-w", root, "-p", "r", "-k", AUDIT_KEY]);
      this.deps.ctl(["-e", "1"]);
      this.rulesOk = true;
      this.appliedPid = pid;
      this.appliedRoots = key;
    } catch (error) {
      this.rulesOk = false;
      this.deps.log?.(`[kernel-watch] could not set the rules: ${String(error)}`);
    }
  }

  /** New text of the audit log since last time. */
  private newLog(): string {
    let size: number;
    let inode: number;
    try {
      const stat = statSync(this.deps.auditLog);
      size = stat.size;
      inode = stat.ino;
    } catch {
      return "";
    }
    // The first look starts from the end: what was read before the watch was here is not its business.
    if (this.offset === null) {
      this.offset = size;
      this.inode = inode;
      return "";
    }
    if (inode !== this.inode || size < this.offset) {
      this.offset = 0;
      this.inode = inode;
    }
    const length = Math.min(size - this.offset, READ_AT_MOST);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.deps.auditLog, "r");
    try {
      readSync(fd, buffer, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset += length;
    return buffer.toString("utf8");
  }

  private write(all: AuditRead[]): void {
    const reads = all.filter((read) => !this.expected(read));
    if (!reads.length) return;
    const file = join(this.deps.dir, "events.jsonl");
    try {
      if (statSync(file).size > (this.deps.maxEventsBytes ?? 1024 * 1024))
        renameSync(file, `${file}.1`);
    } catch {
      // Not there yet.
    }
    appendFileSync(
      file,
      reads
        .map((read) =>
          JSON.stringify({
            at: read.at,
            pid: read.pid,
            ppid: read.ppid,
            comm: read.comm,
            exe: read.exe,
            cwd: read.cwd,
            path: read.path,
          }),
        )
        .join("\n") + "\n",
    );
  }

  /** What the audit system says of itself: whether it is on, and how many events it dropped. */
  private status(): { enabled: boolean; lost: number } {
    try {
      const text = this.deps.ctl(["-s"]);
      return {
        enabled: /^enabled 1/m.test(text),
        lost: Number(/^lost (\d+)/m.exec(text)?.[1] ?? 0),
      };
    } catch {
      return { enabled: false, lost: 0 };
    }
  }

  private beats = 0;
  private lastStatus = { enabled: false, lost: 0 };

  /**
   * One round, many times a second: the rules, the log. About once a second it also says how the watch is
   * (the audit system's own report) in the heartbeat file.
   */
  tick(): void {
    const pid = this.serverPid();
    this.rules(pid);
    const text = this.newLog();
    const reads = this.parser.push(text);
    // A group that nothing followed is let go of after a quiet round.
    if (text) this.quiet = 0;
    else if (++this.quiet >= 2) reads.push(...this.parser.flush());
    this.write(reads);
    if (this.beats++ % (this.deps.beatEvery ?? 10) !== 0) return;
    this.lastStatus = this.status();
    const alive = join(this.deps.dir, "alive");
    writeFileSync(
      `${alive}.tmp`,
      JSON.stringify({
        at: this.now(),
        ok: this.rulesOk && this.lastStatus.enabled,
        lost: this.lastStatus.lost,
        serverPid: pid,
      }),
    );
    renameSync(`${alive}.tmp`, alive);
  }
}
