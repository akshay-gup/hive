import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { KernelWatch } from "../apps/server/src/agent-watch/kernel.ts";
import { AgentWatch } from "../apps/server/src/agent-watch/watch.ts";
import type { WatchFinding } from "../packages/domain/src/agent-watch.ts";

/**
 * What the kernel watch leaves for the server: reads of the machine's own data, matched to the run that made
 * them by the folder it was working in, and a heartbeat whose silence, with refusing on, stops what is running.
 */
const dataDir = "/data/hive";
const own = `${dataDir}/owners/shared/channels/c1`;
const other = `${dataDir}/owners/shared/channels/c2`;

function rig(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "hive-kernel-reader-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const sent: WatchFinding[] = [];
  const watch = new AgentWatch({
    dataDir,
    env: {},
    send: (frame) => {
      sent.push(frame.finding);
      return true;
    },
  });
  let clock = 1_000_000;
  const kernel = new KernelWatch({
    dir,
    watch,
    now: () => clock,
    staleMs: 30_000,
    graceMs: 60_000,
    selfPid: 7,
  });
  const read = (patch: Record<string, unknown> = {}) =>
    appendFileSync(
      join(dir, "events.jsonl"),
      `${JSON.stringify({ at: clock, pid: 100, ppid: 50, comm: "cat", exe: "/usr/bin/cat", cwd: own, path: "/data/hive/postgres/PG_VERSION", ...patch })}\n`,
    );
  const beat = (patch: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, "alive"), JSON.stringify({ at: clock, ok: true, lost: 0, ...patch }));
  return {
    dir,
    watch,
    kernel,
    sent,
    read,
    beat,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a read the kernel saw is marked against the run that was working in that folder", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  const a = r.watch.forRun({ scope: "channel", runId: "run-a", directory: own });
  r.watch.forRun({ scope: "channel", runId: "run-b", directory: other });
  r.read();
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]?.runId, "run-a");
  assert.equal(r.sent[0]?.source, "kernel");
  assert.equal(r.sent[0]?.scope, "channel");
  assert.equal(r.sent[0]?.rule, "database");
  assert.equal(r.sent[0]?.tool, "cat");
  assert.equal(r.sent[0]?.command, "/usr/bin/cat");
  a.end();
  r.read({ path: "/data/hive/session-signing-key" });
  r.kernel.poll();
  r.watch.releaseAll();
  // Run a is over, so the read of the key is no run's: it is only the one run left (b) that could have made it? No: b was
  // in another folder, and is the only one going, so it is the one told.
  assert.equal(r.sent.at(-1)?.runId, "run-b");
});

test("with several runs and none in that folder, or none at all, it is the machine's and no run's", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  r.watch.forRun({ scope: "channel", runId: "a", directory: other });
  r.watch.forRun({ scope: "task", directory: `${dataDir}/owners/shared/channels/c3` });
  r.read({ cwd: "/tmp" });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent[0]?.scope, "machine");
  assert.equal(r.sent[0]?.runId, undefined);
});

test("what is not the machine's data, and what the server itself read, is not passed on", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  r.read({ path: "/data/hive/owners/shared/channels/c1/note" });
  r.read({ pid: 7 });
  r.read({ path: "/etc/passwd" });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.deepEqual(r.sent, []);
});

test("what was logged before this server began is not its business, and a file started over is read from the top", (t) => {
  const r = rig(t);
  r.read();
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.length, 0);
  r.read({ path: "/data/hive/files/doc.pdf" });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.length, 1);
  writeFileSync(
    join(r.dir, "events.jsonl"),
    `${JSON.stringify({ at: 1, pid: 9, comm: "x", exe: "", cwd: "/tmp", path: "/data/hive/task-files/a" })}\n`,
  );
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.length, 2);
});

test("in the stricter mode the run in that folder is told to stop", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  const told: (string | undefined)[] = [];
  r.watch.forRun({
    scope: "channel",
    runId: "a",
    directory: own,
    onSerious: ({ finding }) => {
      told.push(finding.target);
      return true;
    },
  });
  r.read();
  r.kernel.poll();
  r.watch.releaseAll();
  assert.deepEqual(told, [], "not while it only marks");
  r.watch.setMode("enforce");
  r.read({ path: "/data/hive/session-signing-key" });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.deepEqual(told, ["/data/hive/session-signing-key"]);
  assert.equal(r.sent.at(-1)?.action, "blocked");
});

test("the watch is thought to be working while it says so, and held results are only worth it then", (t) => {
  const r = rig(t);
  r.watch.setMode("enforce");
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.kernel.alive(), false, "not heard from yet");
  assert.equal(r.watch.holdMs(), 0);
  r.beat();
  r.kernel.start();
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.kernel.alive(), true);
  assert.equal(r.watch.holdMs(), 500);
  r.kernel.stop();
  assert.equal(r.watch.holdMs(), 0);
});

test("a watch that has gone quiet is flagged, stops what is running, and keeps new runs out, until it is back", (t) => {
  const r = rig(t);
  r.watch.setMode("enforce");
  r.beat();
  r.kernel.poll();
  r.watch.releaseAll();
  const stopped: string[] = [];
  r.watch.forRun({
    scope: "channel",
    runId: "a",
    directory: own,
    onSerious: ({ finding }) => {
      stopped.push(finding.rule);
      return true;
    },
  });
  assert.equal(r.watch.refusal(), null);
  r.advance(31_000);
  r.kernel.poll();
  r.watch.releaseAll();
  assert.deepEqual(stopped, ["watch"]);
  assert.equal(r.sent.at(-1)?.rule, "watch");
  assert.equal(r.sent.at(-1)?.action, "blocked");
  assert.match(r.watch.refusal() ?? "", /not working/);
  // Said once, however many looks.
  r.advance(5_000);
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.filter((f) => f.rule === "watch").length, 1);
  // Back.
  r.beat();
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.watch.refusal(), null);
});

test("while it only marks, a silent watch is a flag and nothing is stopped", (t) => {
  const r = rig(t);
  r.beat();
  r.kernel.poll();
  r.watch.releaseAll();
  let stopped = 0;
  r.watch.forRun({
    scope: "channel",
    directory: own,
    onSerious: () => {
      stopped++;
      return true;
    },
  });
  r.advance(31_000);
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(stopped, 0);
  assert.equal(r.sent.at(-1)?.rule, "watch");
  assert.equal(r.sent.at(-1)?.action, "marked");
  assert.equal(r.watch.refusal(), null);
});

test("a watch that never shows itself is given a minute, and then it is down; an audit system that is off is down at once", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  r.advance(30_000);
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.length, 0, "still being waited for");
  r.advance(31_000);
  r.kernel.poll();
  r.watch.releaseAll();
  assert.match(r.sent.at(-1)?.target ?? "", /not reported/);

  const off = rig(t);
  off.beat({ ok: false });
  off.advance(61_000);
  off.beat({ ok: false });
  off.kernel.poll();
  assert.match(off.sent.at(-1)?.target ?? "", /audit system is off/);
});

test("events the audit system dropped are flagged, without stopping anything", (t) => {
  const r = rig(t);
  r.watch.setMode("enforce");
  r.beat({ lost: 0 });
  r.kernel.poll();
  r.watch.releaseAll();
  r.beat({ lost: 12 });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.match(r.sent.at(-1)?.target ?? "", /lost 12 events/);
  assert.equal(r.sent.at(-1)?.severity, "medium");
  assert.equal(r.watch.refusal(), null);
});

test("a command that reads another channel's folder is marked against its run, and its own folder is not", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  r.watch.forRun({ scope: "channel", runId: "a", directory: own });
  r.read({ path: `${own}/notes.txt` });
  r.read({ path: `${other}/plan.txt` });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]?.runId, "a");
  assert.equal(r.sent[0]?.rule, "other-channel");
  assert.equal(r.sent[0]?.target, `${other}/plan.txt`);
});

test("a read in a work folder by something not working in a run's folder is no run's, and is not guessed", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  r.watch.forRun({ scope: "channel", runId: "a", directory: own });
  r.read({ cwd: "/app", path: `${other}/plan.txt` });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.deepEqual(r.sent, []);
});

test("a read of the machine's secrets in /etc/hive is marked", (t) => {
  const r = rig(t);
  r.kernel.poll();
  r.watch.releaseAll();
  r.watch.forRun({ scope: "channel", runId: "a", directory: own });
  r.read({ path: "/etc/hive/workspace.json" });
  r.kernel.poll();
  r.watch.releaseAll();
  assert.equal(r.sent[0]?.rule, "keys");
  assert.equal(r.sent[0]?.target, "/etc/hive/workspace.json");
});
