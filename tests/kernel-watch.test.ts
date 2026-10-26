import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { KernelWatcher } from "../apps/workspace/src/kernel-watch.ts";

/**
 * The watcher that runs as root: it sets the kernel's audit rules, reads the audit daemon's log, and leaves
 * what it finds for the server. The audit tool is a stand-in that says what it was asked and how it is.
 */
const sample = readFileSync(new URL("./fixtures/audit-sample.log", import.meta.url), "utf8");

function rig(t: TestContext, options: { status?: () => string; maxEventsBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-kernel-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "watch");
  mkdirSync(dir);
  const data = join(root, "data");
  mkdirSync(join(data, "postgres"), { recursive: true });
  const auditLog = join(root, "audit.log");
  writeFileSync(auditLog, "type=SYSCALL msg=audit(1.000:1): old\n");
  const serverPidFile = join(root, "server.pid");
  const commands: string[][] = [];
  let status = options.status ?? (() => "enabled 1\nfailure 1\npid 99\nlost 0\n");
  let clock = 1_000_000;
  const watcher = new KernelWatcher({
    ctl: (args) => {
      commands.push(args);
      if (args[0] === "-s") return status();
      return "";
    },
    dir,
    roots: [join(data, "postgres"), join(data, "session-signing-key")],
    serverPidFile,
    auditLog,
    now: () => clock,
    alive: (pid) => pid === 4242 || pid === 5151,
    beatEvery: 1,
    maxEventsBytes: options.maxEventsBytes ?? 10_000_000,
  });
  return {
    watcher,
    dir,
    data,
    auditLog,
    serverPidFile,
    commands,
    setStatus: (text: () => string) => {
      status = text;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    events: () => {
      try {
        return readFileSync(join(dir, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    alive: () => JSON.parse(readFileSync(join(dir, "alive"), "utf8")) as Record<string, unknown>,
  };
}
const watched = (commands: string[][]) => commands.filter((c) => c[0] === "-w").map((c) => c[1]);

test("it watches what is there, leaves the server out, and says it is working", (t) => {
  const r = rig(t);
  writeFileSync(r.serverPidFile, "4242\n");
  r.watcher.tick();
  assert.deepEqual(
    watched(r.commands),
    [join(r.data, "postgres")],
    "the key is not there to watch yet",
  );
  const never = r.commands.find((c) => c[0] === "-a");
  assert.deepEqual(never, [
    "-a",
    "never,exit",
    "-F",
    "arch=b64",
    "-S",
    "open,openat,openat2",
    "-F",
    "pid=4242",
  ]);
  assert.equal(r.commands[0]?.[0], "-D", "it starts from no rules");
  assert.deepEqual(r.commands.at(-2), ["-e", "1"]);
  assert.equal(r.alive().ok, true);
  assert.equal(r.alive().serverPid, 4242);
  // Nothing changed, nothing is set again.
  const before = r.commands.length;
  r.watcher.tick();
  assert.equal(r.commands.slice(before).filter((c) => c[0] === "-D").length, 0);
});

test("the rules are made again when the server's process changes or the key appears", (t) => {
  const r = rig(t);
  writeFileSync(r.serverPidFile, "4242\n");
  r.watcher.tick();
  writeFileSync(r.serverPidFile, "5151\n");
  r.watcher.tick();
  const nevers = r.commands.filter((c) => c[0] === "-a").map((c) => c.at(-1));
  assert.deepEqual(nevers, ["pid=4242", "pid=5151"]);
  writeFileSync(join(r.data, "session-signing-key"), "key");
  r.watcher.tick();
  assert.deepEqual(watched(r.commands).slice(-2), [
    join(r.data, "postgres"),
    join(r.data, "session-signing-key"),
  ]);
});

test("a read that is logged after the watch began is passed on, and one from before is not", (t) => {
  const r = rig(t);
  r.watcher.tick();
  appendFileSync(r.auditLog, sample);
  r.watcher.tick();
  r.watcher.tick();
  r.watcher.tick();
  const events = r.events();
  assert.equal(events.length, 9);
  assert.deepEqual(events[1], {
    at: 1793051185737,
    pid: 279300,
    ppid: 279293,
    comm: "cat",
    exe: "/usr/bin/cat",
    cwd: "/data/hive/owners/shared/channels/c1",
    path: "/data/hive/postgres/PG_VERSION",
  });
});

test("when the log is started over, it is read from the top", (t) => {
  const r = rig(t);
  r.watcher.tick();
  appendFileSync(r.auditLog, sample);
  r.watcher.tick();
  r.watcher.tick();
  r.watcher.tick();
  const had = r.events().length;
  writeFileSync(r.auditLog, sample.split("\n").slice(0, 3).join("\n") + "\n");
  r.watcher.tick();
  r.watcher.tick();
  r.watcher.tick();
  assert.equal(r.events().length > 0, true);
  assert.ok(had >= 9);
});

test("the heartbeat says when the audit system is off, failed to take its rules, or lost events", (t) => {
  const r = rig(t);
  r.watcher.tick();
  assert.equal(r.alive().ok, true);
  r.setStatus(() => "enabled 0\nlost 0\n");
  r.advance(1000);
  r.watcher.tick();
  assert.equal(r.alive().ok, false);
  r.setStatus(() => "enabled 1\nlost 7\n");
  r.watcher.tick();
  assert.equal(r.alive().ok, true);
  assert.equal(r.alive().lost, 7);
  r.setStatus(() => {
    throw new Error("no audit");
  });
  r.watcher.tick();
  assert.equal(r.alive().ok, false);
});

test("the events file is started over when it grows too big, and the old one kept", (t) => {
  const r = rig(t, { maxEventsBytes: 400 });
  r.watcher.tick();
  for (let i = 0; i < 3; i++) {
    appendFileSync(r.auditLog, sample);
    r.watcher.tick();
    r.watcher.tick();
    r.watcher.tick();
  }
  assert.ok(r.events().length > 0);
  assert.ok(readFileSync(join(r.dir, "events.jsonl.1"), "utf8").length > 0);
});
