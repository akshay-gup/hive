import { isAbsolute, join, normalize } from "node:path";

/**
 * Reads the kernel's audit log for the reads of the folders the kernel watch was asked to look at (see
 * kernel-watch.ts). The log has one line per record, and the records of one event share a serial: the
 * system call that opened the file (who: process, parent, program), the folder it ran in, and the path.
 */

/** One read of a watched file. */
export interface AuditRead {
  /** When, in milliseconds. */
  at: number;
  serial: number;
  pid: number;
  ppid: number;
  comm: string;
  exe: string;
  cwd: string;
  /** The file, as a full path. */
  path: string;
}

/** The key the watch's rules are given, which marks their events in the log. */
export const AUDIT_KEY = "hivedata";

const HEAD = /^type=(\w+) msg=audit\((\d+)\.(\d+):(\d+)\): ?(.*)$/;

/** A value the kernel wrote: in quotes, or as hex when it holds a space or another odd character. */
function value(record: string, name: string): string | undefined {
  const quoted = new RegExp(`(?:^| )${name}="([^"]*)"`).exec(record);
  if (quoted) return quoted[1];
  const hex = new RegExp(`(?:^| )${name}=([0-9A-Fa-f]+)(?: |$)`).exec(record);
  if (hex?.[1] && hex[1].length % 2 === 0 && /[^0-9]/.test(hex[1]) === true)
    return Buffer.from(hex[1], "hex").toString("utf8");
  return undefined;
}
const number = (record: string, name: string) => {
  const found = new RegExp(`(?:^| )${name}=(\\d+)(?: |$)`).exec(record);
  return found ? Number(found[1]) : 0;
};

interface Group {
  id: string;
  at: number;
  serial: number;
  records: { type: string; body: string }[];
}

function finish(group: Group): AuditRead[] {
  const call = group.records.find((r) => r.type === "SYSCALL");
  if (!call || !call.body.includes(`key="${AUDIT_KEY}"`)) return [];
  // A read that failed showed nothing.
  if (/(?:^| )success=no(?: |$)/.test(call.body)) return [];
  const cwd = value(group.records.find((r) => r.type === "CWD")?.body ?? "", "cwd") ?? "/";
  const reads: AuditRead[] = [];
  for (const record of group.records) {
    if (record.type !== "PATH") continue;
    // The folder a file was looked up in is not a read of it.
    const kind = /(?:^| )nametype=(\w+)/.exec(record.body)?.[1];
    if (kind && kind !== "NORMAL") continue;
    const name = value(record.body, "name");
    if (!name) continue;
    reads.push({
      at: group.at,
      serial: group.serial,
      pid: number(call.body, "pid"),
      ppid: number(call.body, "ppid"),
      comm: value(call.body, "comm") ?? "",
      exe: value(call.body, "exe") ?? "",
      cwd,
      path: normalize(isAbsolute(name) ? name : join(cwd, name)),
    });
  }
  return reads;
}

/** Takes the log as it arrives, in pieces, and gives back the reads it has seen the whole of. */
export class AuditParser {
  private rest = "";
  private group: Group | null = null;

  push(chunk: string): AuditRead[] {
    const out: AuditRead[] = [];
    const text = this.rest + chunk;
    const lines = text.split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) {
      const head = HEAD.exec(line);
      if (!head) continue;
      const [, type, seconds, millis, serial, body] = head as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const id = `${seconds}.${millis}:${serial}`;
      if (this.group && this.group.id !== id) {
        out.push(...finish(this.group));
        this.group = null;
      }
      this.group ??= {
        id,
        at: Number(seconds) * 1000 + Number(millis),
        serial: Number(serial),
        records: [],
      };
      this.group.records.push({ type, body });
      // The last record of an event: it is whole, and nothing need wait for the next one to say so.
      if (type === "PROCTITLE") {
        out.push(...finish(this.group));
        this.group = null;
      }
    }
    return out;
  }

  /** What is pending, because nothing more is coming just now. */
  flush(): AuditRead[] {
    if (this.rest) {
      const out = this.push("\n");
      this.rest = "";
      const last = this.group ? finish(this.group) : [];
      this.group = null;
      return [...out, ...last];
    }
    const last = this.group ? finish(this.group) : [];
    this.group = null;
    return last;
  }
}
