import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AuditParser } from "../apps/workspace/src/kernel-audit.ts";

/**
 * The kernel's audit log, as it was written when a stand-in for the server and a stand-in for the agent
 * read the watched files (tests/fixtures/audit-sample.log, with the paths changed).
 */
const sample = readFileSync(new URL("./fixtures/audit-sample.log", import.meta.url), "utf8");
const reads = (text: string) => {
  const parser = new AuditParser();
  return [...parser.push(text), ...parser.flush()];
};

test("every read in the real log is seen: who, with what, from where, and of which file", () => {
  const all = reads(sample);
  assert.equal(all.length, 9);
  const first = all[0];
  assert.equal(first?.comm, "node");
  assert.equal(first?.exe, "/usr/local/bin/node");
  assert.equal(first?.path, "/data/hive/postgres/PG_VERSION");
  assert.equal(first?.cwd, "/tmp");
  // A shell command in a channel's folder.
  const cat = all[1];
  assert.equal(cat?.comm, "cat");
  assert.equal(cat?.cwd, "/data/hive/owners/shared/channels/c1");
  assert.equal(cat?.path, "/data/hive/postgres/PG_VERSION");
  // One that was left running on its own: no parent to speak of.
  const left = all.find((read) => read.path === "/data/hive/session-signing-key");
  assert.equal(left?.ppid, 1);
  // A file named without its folder is made full by the folder the reader was in.
  assert.ok(all.some((read) => read.path === "/data/hive/owners/shared/channels/c1/note"));
});

test("the log can arrive in pieces, cut anywhere, and the same reads come out", () => {
  const whole = reads(sample);
  for (const size of [1, 7, 64, 500]) {
    const parser = new AuditParser();
    const got = [];
    for (let i = 0; i < sample.length; i += size)
      got.push(...parser.push(sample.slice(i, i + size)));
    got.push(...parser.flush());
    assert.deepEqual(got, whole, `in pieces of ${size}`);
  }
});

test("only the watch's own events count, and a failed or a folder lookup is not a read", () => {
  const line = (type: string, body: string) =>
    `type=${type} msg=audit(1793051185.100:9): ${body}\n`;
  const text =
    line("SYSCALL", 'success=no ppid=1 pid=2 comm="cat" exe="/usr/bin/cat" key="hivedata"') +
    line("CWD", 'cwd="/tmp"') +
    line("PATH", 'item=0 name="/data/hive/postgres/x" nametype=NORMAL') +
    `type=SYSCALL msg=audit(1793051185.200:10): success=yes ppid=1 pid=3 comm="cat" exe="/usr/bin/cat" key="other"\n` +
    `type=PATH msg=audit(1793051185.200:10): item=0 name="/data/hive/postgres/y" nametype=NORMAL\n` +
    `type=SYSCALL msg=audit(1793051185.300:11): success=yes ppid=1 pid=4 comm="cat" exe="/usr/bin/cat" key="hivedata"\n` +
    `type=CWD msg=audit(1793051185.300:11): cwd="/tmp"\n` +
    `type=PATH msg=audit(1793051185.300:11): item=0 name="/data/hive/postgres" nametype=PARENT\n` +
    `type=PATH msg=audit(1793051185.300:11): item=1 name="/data/hive/postgres/z" nametype=NORMAL\n`;
  assert.deepEqual(
    reads(text).map((read) => read.path),
    ["/data/hive/postgres/z"],
  );
});

test("a name the kernel wrote as hex, with a space in it, is read as it was", () => {
  const hex = Buffer.from("/data/hive/files/my doc.pdf").toString("hex").toUpperCase();
  const text =
    `type=SYSCALL msg=audit(1793051185.400:12): success=yes ppid=5 pid=6 comm=${Buffer.from("my tool").toString("hex").toUpperCase()} exe="/usr/bin/x" key="hivedata"\n` +
    `type=CWD msg=audit(1793051185.400:12): cwd="/tmp"\n` +
    `type=PATH msg=audit(1793051185.400:12): item=0 name=${hex} nametype=NORMAL\n`;
  const [read] = reads(text);
  assert.equal(read?.path, "/data/hive/files/my doc.pdf");
  assert.equal(read?.comm, "my tool");
  assert.equal(read?.at, 1793051185400);
});
