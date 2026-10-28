import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ChatCore } from "../apps/chat/src/core.ts";
import { ROUTINE_LIMITS } from "../apps/chat/src/routines.ts";
import {
  checkSchedule,
  describeSchedule,
  nextCron,
  nextFire,
  parseCron,
} from "../packages/chat-core/src/schedule.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import { chatWorld } from "./helpers/chat-world.ts";

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
} as const;
type Who = keyof typeof people;

let call: (who: Who, method: string, path: string, body?: unknown) => Promise<Response>;
let core: ChatCore;
let clock: number;

beforeEach(async () => {
  clock = Date.parse("2026-10-28T09:00:00.000Z");
  const world = await chatWorld(people, { clock: () => clock });
  call = world.call;
  core = world.core;
});

const id = (who: Who) => people[who].id;
const json = <T>(response: Response) => response.json() as Promise<T>;
const room = async (who: Who, name = "ops") =>
  (await json<{ id: string }>(await call(who, "POST", "/v1/channels", { name }))).id;
const every = (minutes: number) => ({ kind: "every", minutes }) as const;
const make = (who: Who, channelId: string, extra: object = {}) =>
  core.routines.create(
    id(who),
    {
      title: "Check the page",
      note: "Open the page and say if it changed",
      schedule: every(60),
      ...extra,
    },
    { channelId },
  );

test("a cron line is read, and the next time it names is found in its time zone", () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(nextCron("*/15 * * * *", at("2026-10-28T09:01:00Z")), at("2026-10-28T09:15:00Z"));
  assert.equal(nextCron("0 9 * * *", at("2026-10-28T09:00:00Z")), at("2026-10-29T09:00:00Z"));
  // 09:00 in New York is 13:00 UTC while the clocks are on summer time, 14:00 after they go back.
  assert.equal(
    nextCron("0 9 * * *", at("2026-10-28T00:00:00Z"), "America/New_York"),
    at("2026-10-28T13:00:00Z"),
  );
  assert.equal(
    nextCron("0 9 * * *", at("2026-11-02T00:00:00Z"), "America/New_York"),
    at("2026-11-02T14:00:00Z"),
  );
  // Weekdays: Monday to Friday; 2026-10-31 is a Saturday.
  assert.equal(nextCron("30 8 * * 1-5", at("2026-10-30T09:00:00Z")), at("2026-11-02T08:30:00Z"));
  // Day of month and day of week together: either.
  assert.equal(nextCron("0 0 1 * 1", at("2026-10-28T00:00:00Z")), at("2026-11-01T00:00:00Z"));
  for (const bad of ["", "* * * *", "61 * * * *", "* 24 * * *", "a b c d e", "*/0 * * * *"])
    assert.throws(() => parseCron(bad), /cron|value|step/i, bad);
});

test("a schedule is checked and put in words, and a time that has passed is not one", () => {
  const now = clock;
  assert.deepEqual(checkSchedule({ kind: "every", minutes: 5.4 }, now), {
    kind: "every",
    minutes: 5,
  });
  assert.throws(() => checkSchedule({ kind: "every", minutes: 0 }, now), /minute/);
  assert.throws(() => checkSchedule({ kind: "once", at: "2020-01-01T00:00:00Z" }, now), /passed/);
  assert.throws(() => checkSchedule({ kind: "once", at: "later" }, now), /not a time/);
  assert.throws(
    () => checkSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Not/AZone" }, now),
    /time zone/,
  );
  assert.equal(describeSchedule({ kind: "every", minutes: 90 }), "Every 90 minutes");
  assert.equal(describeSchedule({ kind: "every", minutes: 120 }), "Every 2 hours");
  assert.equal(describeSchedule({ kind: "every", minutes: 1440 }), "Every day");
  assert.equal(nextFire({ kind: "every", minutes: 10 }, now), now + 600_000);
  assert.equal(nextFire({ kind: "once", at: "2020-01-01T00:00:00Z" }, now), null);
});

test("a routine is the channel's: its members see it, others do not, and a routine of one's own chat waits for that to be built", async () => {
  const ops = await room("max", "ops");
  const mine = await make("max", ops);
  assert.equal(mine.status, "active");
  assert.equal(mine.scheduleText, "Every hour");
  assert.equal(mine.nextRunAt, new Date(clock + 3_600_000).toISOString());
  assert.deepEqual(
    (await core.routines.list(id("mia"))).map((r) => r.title),
    ["Check the page"],
  );
  const quiet = await json<{ id: string }>(
    await call("max", "POST", "/v1/channels", { name: "hush", visibility: "private" }),
  );
  await make("max", quiet.id, { title: "Secret watch" });
  assert.deepEqual(
    (await core.routines.list(id("mia"))).map((r) => r.title),
    ["Check the page"],
  );
  assert.equal((await core.routines.list(id("max"))).length, 2);
  await assert.rejects(
    core.routines.create(id("max"), { title: "x", note: "y", schedule: every(5) }),
    /own chat/,
  );
  const secret = (await core.routines.list(id("max"))).find((r) => r.title === "Secret watch");
  assert.ok(secret);
  await assert.rejects(core.routines.update(id("mia"), secret.id, { paused: true }), /not there/);
});

test("when its time comes the agent is woken as the person who set it, in the thread it was set in, and it waits for the next time", async () => {
  const ops = await room("max");
  const root = await json<ChatMessage>(
    await call("max", "POST", `/v1/channels/${ops}/messages`, {
      body: "watching the build",
      clientId: "c1",
    }),
  );
  const made = await make("max", ops, undefined);
  void root;
  const routine = await core.routines.create(
    id("max"),
    { title: "Build", note: "Check the build and say if it is red", schedule: every(30) },
    { channelId: ops, rootId: root.id },
  );
  assert.equal(await core.routines.fireDue(), 0, "not yet");
  clock += 31 * 60_000;
  assert.equal(await core.routines.fireDue(), 1, "only the routine that is half-hourly was due");
  const replies = (
    await json<{ replies: ChatMessage[] }>(
      await call("max", "GET", `/v1/messages/${root.id}/replies`),
    )
  ).replies;
  const woke = replies.find((m) => m.body.includes("Routine “Build”"));
  assert.ok(woke, "a message was written in the thread");
  assert.equal(woke.author.id, id("max"));
  assert.match(woke.body, /@hive Check the build and say if it is red/);
  const run = core.runs.byTrigger(woke.id);
  assert.ok(run && run.askedBy === id("max") && run.rootId === root.id);
  const after = (await core.routines.list(id("max"))).find((r) => r.id === routine.id);
  assert.equal(after?.fires, 1);
  assert.equal(after?.lastResult, "running");
  assert.equal(after?.nextRunAt, new Date(clock + 30 * 60_000).toISOString());
  // Still working when the next time comes: it waits.
  clock += 31 * 60_000;
  await core.routines.fireDue();
  assert.equal((await core.routines.list(id("max"))).find((r) => r.id === routine.id)?.fires, 1);
  // The run is told it was a routine, and what it kept.
  await core.routines.setMemo(run.id, run.triggerId, "build 41 was red");
  assert.equal(core.routines.byTrigger(woke.id)?.id, routine.id);
  void made;
});

test("a routine that cannot wake the agent three times in a row is paused and its person told", async () => {
  const quiet = await json<{ id: string }>(
    await call("max", "POST", "/v1/channels", { name: "hush", visibility: "private" }),
  );
  await call("max", "POST", `/v1/channels/${quiet.id}/members`, { add: [people.mia.email] });
  const routine = await make("mia", quiet.id);
  await call("max", "POST", `/v1/channels/${quiet.id}/members`, { remove: [people.mia.email] });
  for (let i = 0; i < ROUTINE_LIMITS.failuresToPause; i++) {
    clock += 61 * 60_000;
    await core.routines.fireDue();
  }
  const shown = (await core.routines.list(id("mia"))).find((r) => r.id === routine.id);
  assert.equal(shown, undefined, "she can no longer see a routine of a channel she is not in");
  const stored = core.entries.get(routine.id);
  assert.equal(stored?.status, "paused");
  const told = await json<{ title: string }[]>(await call("mia", "GET", "/v1/notifications"));
  assert.ok(told.some((n) => n.title === "A routine was paused"));
});

test("a person may have only so many routines, and one is changed, paused, run at once and removed by those who may work in its scope", async () => {
  const ops = await room("max");
  for (let i = 0; i < ROUTINE_LIMITS.perPerson; i++) await make("max", ops, { title: `r${i}` });
  await assert.rejects(make("max", ops), /20 routines/);
  const [first] = await core.routines.list(id("max"));
  assert.ok(first);
  const paused = await core.routines.update(id("mia"), first.id, { paused: true });
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextRunAt, undefined);
  const resumed = await core.routines.update(id("mia"), first.id, {
    paused: false,
    title: "Renamed",
  });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.title, "Renamed");
  const ran = await core.routines.runNow(id("mia"), first.id);
  assert.equal(ran.fires, 1);
  await core.routines.remove(id("max"), first.id);
  await assert.rejects(core.routines.remove(id("max"), first.id), /not there/);
  // The app reads them with the board.
  const work = await json<{ routines: unknown[] }>(await call("mia", "GET", "/v1/work"));
  assert.equal(work.routines.length, ROUTINE_LIMITS.perPerson - 1);
});

test("deleting a channel deletes its routines", async () => {
  const ops = await room("max");
  const mine = await make("max", ops);
  assert.equal((await call("max", "DELETE", `/v1/channels/${ops}`)).status, 200);
  assert.equal(core.entries.get(mine.id), null);
});
