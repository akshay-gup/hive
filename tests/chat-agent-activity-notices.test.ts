import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_ACTIVITY_NOTICE,
  AgentActivityNotices,
} from "../apps/chat/src/agent-activity-notices.ts";
import { FLAG_LIMITS } from "../packages/chat-core/src/agent-flags.ts";
import type { WatchFinding } from "../packages/domain/src/agent-watch.ts";
import type { ChatNotice } from "../packages/domain/src/chat.ts";
import { chatWorld } from "./helpers/chat-world.ts";

const people = {
  owner: { id: "owner", name: "Owner", email: "owner@example.com", role: "owner" },
  admin: { id: "admin", name: "Admin", email: "admin@example.com", role: "admin" },
  member: { id: "member", name: "Member", email: "member@example.com", role: "member" },
  guest: { id: "guest", name: "Guest", email: "guest@example.com", role: "guest" },
} as const;
type Who = keyof typeof people;
const finding = (patch: Partial<WatchFinding> = {}): WatchFinding => ({
  source: "command",
  scope: "own-chat",
  tool: "bash",
  target: "/private/database",
  command: "cat /private/database",
  rule: "database",
  severity: "high",
  action: "marked",
  mode: "audit",
  ...patch,
});
async function world() {
  let clock = Date.now();
  const w = await chatWorld(people, { clock: () => clock });
  const list = async (who: Who = "owner", unread = false) =>
    w.ok<ChatNotice[]>(await w.call(who, "GET", `/v1/notifications${unread ? "?unread=1" : ""}`));
  const flag = (patch: Partial<WatchFinding> = {}) =>
    w.core.agent.onFrame(JSON.stringify({ t: "agent.flag", finding: finding(patch) }));
  const act = async (who: Who, action: "read" | "unread" | "dismiss") =>
    w.ok<{ changed: number }>(
      await w.call(who, "POST", `/v1/notifications/${AGENT_ACTIVITY_NOTICE}/${action}`),
    );
  return {
    ...w,
    flag,
    list,
    act,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("all significant flags share one generic bell item per owner/admin, with private live events", async () => {
  const w = await world();
  assert.deepEqual(await w.list(), []);
  for (let i = 0; i < 8; i++) await w.flag({ target: `/private/data-${i}` });
  for (const who of ["owner", "admin"] as const) {
    const notes = await w.list(who);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.id, AGENT_ACTIVITY_NOTICE);
    assert.equal(notes[0]?.target, "agent-activity");
    assert.equal(notes[0]?.body, "8 warnings need review.");
    assert.equal(notes[0]?.read, false);
    assert.doesNotMatch(JSON.stringify(notes), /\/private|bash|database/);
  }
  assert.deepEqual(await w.list("member"), []);
  assert.deepEqual(await w.list("guest"), []);
  const events = w.published.filter(
    (event) => event.type === "notification.changed" || event.type === "agent-flags.changed",
  );
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.userId === "owner" || event.userId === "admin"));
  assert.doesNotMatch(JSON.stringify(events), /\/private|bash|database/);
  assert.equal(
    w.core.entries.list("notice").length,
    0,
    "no stored notification history is generated per flag",
  );
});

test("reading or dismissing the bell item is personal and does not review flags", async () => {
  const w = await world();
  await w.flag();
  assert.equal((await w.act("owner", "read")).changed, 1);
  assert.equal((await w.act("owner", "read")).changed, 0);
  assert.deepEqual(await w.list("owner", true), []);
  assert.equal((await w.list("admin"))[0]?.read, false);
  assert.equal(w.core.flags.unreviewed(), 1);
  assert.equal((await w.act("owner", "unread")).changed, 1);
  assert.equal((await w.list("owner", true)).length, 1);
  await w.act("owner", "dismiss");
  assert.deepEqual(await w.list(), []);
  assert.equal((await w.list("admin")).length, 1);
  assert.equal((await w.act("owner", "unread")).changed, 0);
  assert.equal(w.core.flags.unreviewed(), 1);
  assert.equal((await w.act("member", "read")).changed, 0);
  assert.equal((await w.act("guest", "dismiss")).changed, 0);
});

test("new warnings update the same item, while low flags and reviewing older warnings do not reset it", async () => {
  const w = await world();
  await w.flag();
  w.advance(1);
  await w.flag({ rule: "keys", target: "/private/key" });
  const latest = w.core.flags.list().find((flag) => flag.rule === "keys");
  assert.ok(latest);
  await w.act("owner", "read");
  await w.act("admin", "dismiss");
  await w.flag({ severity: "low", target: "/private/low" });
  await w.ok(await w.call("owner", "POST", `/v1/agent-flags/${latest.id}/review`));
  assert.equal((await w.list())[0]?.read, true);
  assert.equal((await w.list())[0]?.body, "1 warning needs review.");
  assert.deepEqual(await w.list("admin"), []);
  w.advance(1000);
  await w.flag({ target: "/private/new" });
  for (const who of ["owner", "admin"] as const) {
    const notes = await w.list(who);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.id, AGENT_ACTIVITY_NOTICE);
    assert.equal(notes[0]?.read, false);
    assert.equal(notes[0]?.body, "2 warnings need review.");
  }
  assert.equal(w.core.entries.list("agent_activity_notice").length, 2);
});

test("reviewing all warnings clears the summary for everyone; a later warning reuses its id", async () => {
  const w = await world();
  await w.flag();
  await w.flag();
  const before = (await w.list())[0];
  await w.ok(await w.call("admin", "POST", "/v1/agent-flags/review"));
  assert.deepEqual(await w.list(), []);
  assert.deepEqual(await w.list("admin"), []);
  assert.ok(
    w.published.some((event) => event.type === "agent-flags.changed" && event.userId === "owner"),
  );
  await w.flag();
  assert.equal((await w.list())[0]?.id, before?.id);
  assert.equal((await w.list())[0]?.body, "1 warning needs review.");
});

test("bulk read/clear includes the singleton; work preferences do not hide the workspace warning", async () => {
  const w = await world();
  await w.flag();
  await w.ok(
    await w.call("owner", "PUT", "/v1/notification-prefs", {
      mentions: true,
      work: false,
      muted: [],
    }),
  );
  assert.equal((await w.list()).length, 1);
  assert.equal(
    (await w.ok<{ changed: number }>(await w.call("owner", "POST", "/v1/notifications/read-all")))
      .changed,
    1,
  );
  assert.deepEqual(await w.list("owner", true), []);
  await w.ok(await w.call("owner", "POST", "/v1/notifications/dismiss-all"));
  assert.deepEqual(await w.list(), []);
  assert.equal(w.core.flags.unreviewed(), 1);
});

test("old stored flags are summarized without a new machine report, and notice state survives a new service instance", async () => {
  const w = await world();
  w.core.flags.add("old-flag", finding(), null);
  assert.equal((await w.list()).length, 1);
  await w.act("owner", "dismiss");
  const rebuilt = new AgentActivityNotices({
    access: w.core.access,
    entries: w.core.entries,
    flags: w.core.flags,
    emit() {},
  });
  assert.deepEqual(await rebuilt.list("owner"), []);
  assert.equal((await rebuilt.list("admin")).length, 1);
  w.advance(FLAG_LIMITS.keepMs + 1000);
  w.core.flags.prune();
  assert.deepEqual(await rebuilt.list("admin"), []);
});

test("role changes remove the summary immediately and a new admin can see current warnings", async () => {
  const w = await world();
  await w.flag();
  await w.core.syncPeople(
    Object.values(people).map((p) => ({
      sub: p.id,
      email: p.email,
      name: p.name,
      role: p.id === "admin" ? "member" : p.id === "member" ? "admin" : p.role,
    })),
  );
  assert.deepEqual(await w.core.agentActivity.list("admin"), []);
  assert.equal(await w.core.agentActivity.state("admin", "read"), 0);
  assert.equal((await w.core.agentActivity.list("member")).length, 1);
});

test("low-only and unknown-run reports do not produce a bell warning", async () => {
  const w = await world();
  await w.flag({ severity: "low" });
  await w.flag({ runId: "not-a-real-run", scope: "channel" });
  assert.deepEqual(await w.list(), []);
  assert.deepEqual(await w.list("admin"), []);
});
