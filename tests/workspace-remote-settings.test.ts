import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  keyOf,
  noteStayedUp,
  overlay,
  readDoc,
  runsGoing,
  startWith,
  waitIdle,
  watchSettings,
  whereFrom,
} from "../apps/workspace/src/remote-settings.ts";

const KEY = "hwk_w1.secretpart";
const REV1 = "a".repeat(24);
const REV2 = "b".repeat(24);
const MADE = {
  WORKSPACE_ID: "w1",
  PORT: "8787",
  MODEL: "p/hive-default",
  TASK_WORKER_ENABLED: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { p: { options: { apiKey: KEY } } } }),
};

let root: string;
let paths: { etc: string; state: string; volume: string };
/** What the control plane says next: a document, a status, or nothing at all (unreachable). */
let says: { status?: number; body?: unknown } | "down";
let asked: Array<{ url: string; auth: string | null }>;

const fetcher = (async (url: string, init?: RequestInit) => {
  asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
  if (says === "down") throw new Error("offline");
  return new Response(JSON.stringify(says.body ?? {}), { status: says.status ?? 200 });
}) as unknown as typeof fetch;

const doc = (rev: string, env: Record<string, string | null>) => ({ body: { v: 1, rev, env } });
const start = () => startWith(MADE, paths, { fetcher, timeoutMs: 500 });
const lastConfig = () => JSON.parse(readFileSync(join(paths.state, "last-config.json"), "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remote-settings-"));
  paths = { etc: join(root, "etc"), state: join(root, "state"), volume: join(root, "data") };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(paths.etc, "updater.json"),
    JSON.stringify({ wantedUrl: "https://control.test/v1/release/w1/" }),
  );
  says = doc(REV1, {});
  asked = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a document is accepted only in the form this build knows", () => {
  assert.ok("doc" in readDoc(JSON.stringify({ v: 1, rev: REV1, env: { A_B: "1", C: null } })));
  const problem = (value: unknown) => {
    const result = readDoc(JSON.stringify(value));
    return "problem" in result ? result.problem : "";
  };
  assert.match(problem({ v: 2, rev: REV1, env: {}, files: [] }), /version 2.*newer build/);
  assert.match(problem({ v: 1, rev: "x", env: {} }), /revision/);
  assert.match(problem({ v: 1, rev: REV1, env: { "bad name": "1" } }), /name and a string/);
  assert.match(problem({ v: 1, rev: REV1, env: { A: 1 } }), /name and a string/);
  assert.match(problem({ v: 1, rev: REV1 }), /no settings/);
  assert.equal("problem" in readDoc("{nope"), true);
});

test("the control plane's settings go over the machine's own; null takes one away; identity stays", () => {
  const out = overlay(MADE, {
    v: 1,
    rev: REV1,
    env: {
      MODEL: "p/other",
      TASK_WORKER_ENABLED: null,
      NEW_ONE: "1",
      WORKSPACE_ID: "someone-else",
    },
  });
  assert.equal(out.MODEL, "p/other");
  assert.equal("TASK_WORKER_ENABLED" in out, false);
  assert.equal(out.NEW_ONE, "1");
  assert.equal(out.WORKSPACE_ID, "w1");
  assert.equal(MADE.MODEL, "p/hive-default", "what it was made with is not changed");
});

test("it asks with the key it reaches the model with, or one it was given in a file", () => {
  assert.equal(keyOf(MADE), KEY);
  assert.equal(keyOf({}), undefined);
  assert.deepEqual(whereFrom(paths.etc, MADE), {
    url: "https://control.test/v1/release/w1/config",
    key: KEY,
  });
  writeFileSync(join(root, "token"), "from-file\n");
  writeFileSync(
    join(paths.etc, "updater.json"),
    JSON.stringify({ wantedUrl: "https://c.test/x", tokenFile: join(root, "token") }),
  );
  assert.equal(whereFrom(paths.etc, MADE)?.key, "from-file");
  assert.equal(whereFrom(paths.etc, {})?.key, "from-file");
  rmSync(join(paths.etc, "updater.json"));
  assert.equal(whereFrom(paths.etc, MADE), undefined, "a machine not told where to ask");
});

test("a machine that is not told where to ask starts as it was made, and asks nothing", async () => {
  rmSync(join(paths.etc, "updater.json"));
  const started = await start();
  assert.deepEqual(started.env, MADE);
  assert.equal(asked.length, 0);
});

test("it starts on the control plane's settings, asking with its own key", async () => {
  says = doc(REV1, { MODEL: "p/new" });
  const started = await start();
  assert.equal(started.env.MODEL, "p/new");
  assert.equal(started.rev, REV1);
  assert.deepEqual(asked, [
    { url: "https://control.test/v1/release/w1/config", auth: `Bearer ${KEY}` },
  ]);
  assert.equal(lastConfig().state, "updated");
  assert.equal(lastConfig().rev, REV1);
  assert.equal(JSON.stringify(lastConfig()).includes(KEY), false);
});

test("settings that stayed up are kept for when the control plane cannot be reached", async () => {
  says = doc(REV1, { MODEL: "p/new" });
  await start();
  noteStayedUp(paths.volume, REV1);
  says = "down";
  const started = await start();
  assert.equal(started.env.MODEL, "p/new", "the last that kept it up");
  assert.equal(started.rev, REV1);
  assert.equal(lastConfig().state, "unchanged");
});

test("with nothing kept and nothing reachable, it starts as it was made", async () => {
  says = "down";
  assert.deepEqual((await start()).env, MADE);
  says = { status: 401 };
  const refused = await start();
  assert.deepEqual(refused.env, MADE);
  assert.match(lastConfig().message, /401/);
});

test("settings it did not stay up on are not tried again, but a newer revision is", async () => {
  says = doc(REV1, { MODEL: "p/good" });
  await start();
  noteStayedUp(paths.volume, REV1);

  says = doc(REV2, { MODEL: "p/crashes" });
  const bad = await start();
  assert.equal(bad.env.MODEL, "p/crashes");
  // It went down and was started again without ever noting that it stayed up on REV2.
  const again = await start();
  assert.equal(again.env.MODEL, "p/good", "back to what last kept it up");
  assert.equal(again.rev, REV1);
  assert.equal(again.seen, REV2, "and it is not to be restarted for that revision again");
  assert.equal(lastConfig().state, "failed");
  assert.equal((await start()).env.MODEL, "p/good");

  says = doc("c".repeat(24), { MODEL: "p/fixed" });
  assert.equal((await start()).env.MODEL, "p/fixed");
});

test("settings in a form this build does not know leave the machine as it is", async () => {
  says = { body: { v: 2, rev: REV1, env: { MODEL: "p/x" }, units: [] } };
  const started = await start();
  assert.equal(started.env.MODEL, "p/hive-default");
  assert.match(lastConfig().message, /version 2/);
});

test("the settings file it keeps for itself is for root alone", async () => {
  await start();
  const { statSync } = await import("node:fs");
  assert.equal(statSync(join(paths.etc, "settings.pending.json")).mode & 0o777, 0o600);
  noteStayedUp(paths.volume, REV1);
  await start();
  assert.equal(statSync(join(paths.etc, "settings.good.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(paths.state, "settings.failed")), false);
});

test("it asks to be restarted once, when the control plane has other settings than it runs on", async () => {
  const where = { url: "https://control.test/config", key: KEY };
  const changes: string[] = [];
  says = doc(REV1, {});
  const stop = watchSettings(
    where,
    REV1,
    (rev) => {
      changes.push(rev);
    },
    {
      everyMs: 10,
      fetcher,
      timeoutMs: 200,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(changes, [], "the same revision is left alone");
  says = "down";
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(changes, [], "and so is a control plane that cannot be reached");
  says = doc(REV2, {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(changes, [REV2]);
  stop();
});

test("it waits for no run to be going, and gives up waiting after a while", async () => {
  const file = join(root, "runs-live");
  assert.equal(runsGoing(file), 0, "no file: nothing to wait for");
  writeFileSync(file, "garbage\n");
  assert.equal(runsGoing(file), 0);
  writeFileSync(file, "2\n");
  assert.equal(runsGoing(file), 2);

  assert.equal(await waitIdle(file, { pollMs: 5, maxMs: 40 }), false, "still busy when it gave up");
  setTimeout(() => writeFileSync(file, "0\n"), 30);
  assert.equal(await waitIdle(file, { pollMs: 5, maxMs: 2_000 }), true);
});
