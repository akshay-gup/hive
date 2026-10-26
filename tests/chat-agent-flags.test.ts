import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { RunnerLink } from "../apps/chat/src/agent-link.ts";
import { ChatCore } from "../apps/chat/src/core.ts";
import { type Peer, Realtime } from "../apps/chat/src/realtime.ts";
import { FLAG_LIMITS } from "../packages/chat-core/src/agent-flags.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import type { WatchFinding, WatchRecord } from "../packages/domain/src/agent-watch.ts";
import type { RoomFrame, RunnerFrame } from "../packages/domain/src/chat-agent.ts";
import { memorySql } from "./helpers/do-shim.ts";

/**
 * What the machine says the agent opened of its own data (see packages/domain/src/agent-watch.ts) is kept
 * by the room for the owner and the admins. The machine says what it saw; who asked and where come from the
 * run the room holds, and nobody but those who run the workspace can read the list.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;
interface Machine extends RunnerLink {
  frames: RoomFrame[];
}
let core: ChatCore;
let realtime: Realtime;
let clock: number;
let machine: Machine | null;
const watchers: Peer[] = [];

const call = (who: Who, method: string, path: string, body?: unknown) =>
  core.handle(
    new Request(`http://chat${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      sub: people[who].id,
      email: people[who].email,
      name: people[who].name,
      role: people[who].role,
      issuedAt: Date.now(),
    },
  );
const fromMachine = (frame: RunnerFrame) => core.agent.onFrame(JSON.stringify(frame));
const finding = (patch: Partial<WatchFinding> = {}): WatchFinding => ({
  source: "command",
  scope: "own-chat",
  tool: "bash",
  target: "/data/hive/postgres/PG_VERSION",
  command: "cat /data/hive/postgres/PG_VERSION",
  rule: "database",
  severity: "high",
  action: "marked",
  mode: "audit",
  ...patch,
});
const flag = (patch: Partial<WatchFinding> = {}) =>
  fromMachine({ t: "agent.flag", finding: finding(patch) });
const listed = async (who: Who) => {
  const response = await call(who, "GET", "/v1/agent-flags");
  return {
    status: response.status,
    body: (await response.json()) as {
      unreviewed: number;
      flags: (WatchRecord & { askerName?: string; channelName?: string })[];
    },
  };
};
/** A run of a private channel that the machine has taken up. */
async function runningIn(name: string, asker: Who) {
  const channel = (await (
    await call(asker, "POST", "/v1/channels", { name, visibility: "private" })
  ).json()) as Channel;
  machine = { frames: [], send: (text) => machine?.frames.push(JSON.parse(text)), close: () => {} };
  await core.agent.onFrame(
    JSON.stringify({ t: "hello", v: 1, identity: { name: "Hive" }, active: [] }),
  );
  await call(asker, "PATCH", `/v1/channels/${channel.id}`, { agent: true });
  const response = await call(asker, "POST", `/v1/channels/${channel.id}/messages`, {
    body: "@hive look",
  });
  assert.equal(response.status, 201, await response.clone().text());
  const run = core.runs.active()[0];
  assert.ok(run, "a run is going");
  return { channel, run };
}

beforeEach(async () => {
  clock = Date.now();
  machine = null;
  watchers.length = 0;
  core = new ChatCore(memorySql(), {
    clock: () => clock,
    publish: (event) => void realtime.publish(event),
    runner: () => machine,
    stream: (channelId, message) => void realtime.stream(channelId, message),
    workspaceId: () => "ws_1",
    linkKey: () => "link-key",
    wake: () => undefined,
  });
  realtime = new Realtime(
    core,
    () => watchers,
    () => clock,
  );
  await core.syncPeople(
    Object.values(people).map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );
});

test("a finding from the machine is kept, and the owner and an admin can read it", async () => {
  await flag();
  for (const who of ["olive", "ada"] as const) {
    const { status, body } = await listed(who);
    assert.equal(status, 200, who);
    assert.equal(body.flags.length, 1);
    assert.equal(body.flags[0]?.rule, "database");
    assert.equal(body.flags[0]?.scope, "own-chat");
    assert.equal(body.unreviewed, 1);
  }
});

test("a member and a guest are not told the list exists", async () => {
  await flag();
  for (const who of ["max", "gus"] as const) {
    const { status } = await listed(who);
    assert.equal(status, 404, who);
    assert.equal((await call(who, "POST", "/v1/agent-flags/review")).status, 404, who);
  }
});

test("who asked and where come from the run, and the machine cannot name them", async () => {
  const { channel, run } = await runningIn("hush", "max");
  await flag({ scope: "channel", runId: run.id });
  const { body } = await listed("olive");
  assert.equal(body.flags[0]?.scope, "channel");
  assert.equal(body.flags[0]?.askerId, people.max.id);
  assert.equal(body.flags[0]?.askerName, "Max");
  assert.equal(body.flags[0]?.channelId, channel.id);
  assert.equal(body.flags[0]?.channelName, "hush");
  // A run the room does not know of is not believed, and a channel run without one is a mere note.
  await flag({ scope: "channel", runId: "no-such-run" });
  await flag({ scope: "channel", target: "/etc/hive/workspace.json" });
  const after = (await listed("olive")).body.flags;
  assert.equal(after.length, 2);
  assert.equal(after.find((f) => f.target === "/etc/hive/workspace.json")?.scope, "own-chat");
});

test("a run is kept to a few, and a day to a few hundred", async () => {
  const { run } = await runningIn("hush", "max");
  for (let i = 0; i < FLAG_LIMITS.perRun + 10; i++)
    await flag({ scope: "channel", runId: run.id, target: `/data/hive/files/${i}.pdf` });
  assert.equal((await listed("olive")).body.flags.length, FLAG_LIMITS.perRun);
  for (let i = 0; i < FLAG_LIMITS.perDay; i++) await flag({ target: `/data/hive/task-files/${i}` });
  // The list shows the newest couple of hundred; the day's count is what was kept.
  assert.equal(core.flags.unreviewed(), FLAG_LIMITS.perDay);
  // The next day it starts again.
  clock += 25 * 3600_000;
  await flag({ target: "/data/hive/task-files/new" });
  assert.equal((await listed("olive")).body.flags[0]?.target, "/data/hive/task-files/new");
});

test("looking at one, or all, takes it off the count; low ones never counted", async () => {
  await flag();
  await flag({ target: "/data/hive/session-signing-key", rule: "keys" });
  await flag({ target: "/data", rule: "files", severity: "low" });
  let seen = (await listed("ada")).body;
  assert.equal(seen.flags.length, 3);
  assert.equal(seen.unreviewed, 2);
  const one = seen.flags.find((f) => f.rule === "keys");
  assert.ok(one);
  await call("ada", "POST", `/v1/agent-flags/${one.id}/review`);
  seen = (await listed("ada")).body;
  assert.equal(seen.unreviewed, 1);
  assert.equal(seen.flags.find((f) => f.id === one.id)?.reviewedBy, "acct_ada");
  await call("olive", "POST", "/v1/agent-flags/review");
  assert.equal((await listed("olive")).body.unreviewed, 0);
});

test("old ones are let go of, and the oldest when there are too many", async () => {
  await flag({ target: "/data/hive/files/old" });
  clock += FLAG_LIMITS.keepMs + 1000;
  await flag({ target: "/data/hive/files/new" });
  core.flags.prune();
  assert.deepEqual(
    (await listed("olive")).body.flags.map((f) => f.target),
    ["/data/hive/files/new"],
  );
});

test("a flag is not a people event: the machine's socket is never sent one", async () => {
  const { run } = await runningIn("hush", "max");
  const before = machine?.frames.length ?? 0;
  await flag({ scope: "channel", runId: run.id });
  assert.equal(machine?.frames.length, before);
});
