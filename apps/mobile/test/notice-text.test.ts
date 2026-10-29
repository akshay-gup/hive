import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentNotification } from "../../../packages/domain/src/agent.ts";
import {
  dayLabel,
  groupByDay,
  noticeAction,
  noticeFrom,
  noticeKind,
  noticesFor,
  unreadCounts,
} from "../src/notice-text.ts";

const now = new Date("2026-10-22T15:00:00");
const note = (id: string, over: Partial<AgentNotification>): AgentNotification => ({
  id,
  title: id,
  body: "",
  createdAt: "2026-10-22T10:00:00",
  read: false,
  ...over,
});
const notes = [
  note("a", { channelId: "launch", byName: "Mia", createdAt: "2026-10-22T09:00:00" }),
  note("b", { taskId: "t1", createdAt: "2026-10-22T11:00:00", read: true }),
  note("c", { createdAt: "2026-10-21T20:00:00" }),
  note("d", {
    channelId: "design",
    by: "mia@example.com",
    createdAt: "2026-10-18T08:00:00",
    read: true,
  }),
];

test("a notice is a mention, an agent's result or an update by what it points at", () => {
  assert.deepEqual(notes.map(noticeKind), ["mention", "agent", "update", "mention"]);
  assert.equal(noticeAction(notes[0]), "Open channel");
  assert.equal(noticeAction(notes[1]), "View task");
  assert.equal(noticeAction(notes[2]), "");
  // The agent's answer in a channel names no person, so it is the agent's.
  assert.equal(noticeKind({ channelId: "general" }), "agent");
});

test("a tab and the unread switch pick the notices to show, newest first", () => {
  assert.deepEqual(
    noticesFor(notes, "all", false).map((n) => n.id),
    ["b", "a", "c", "d"],
  );
  assert.deepEqual(
    noticesFor(notes, "mention", false).map((n) => n.id),
    ["a", "d"],
  );
  assert.deepEqual(
    noticesFor(notes, "all", true).map((n) => n.id),
    ["a", "c"],
  );
  assert.deepEqual(
    noticesFor(notes, "agent", true).map((n) => n.id),
    [],
  );
});

test("each tab counts what is unread in it", () => {
  assert.deepEqual(unreadCounts(notes), { all: 2, mention: 1, agent: 0, update: 1 });
});

test("the activity summary counts as one workspace update and links to agent activity", () => {
  const summary = note("agent-activity", {
    target: "agent-activity",
    body: "57 warnings need review.",
  });
  assert.equal(noticeKind(summary), "update");
  assert.equal(noticeAction(summary), "View agent activity");
  assert.deepEqual(unreadCounts([summary]), { all: 1, mention: 0, agent: 0, update: 1 });
});

test("days are named Today and Yesterday, then by date", () => {
  assert.equal(dayLabel("2026-10-22T01:00:00", now), "Today");
  assert.equal(dayLabel("2026-10-21T23:00:00", now), "Yesterday");
  assert.equal(dayLabel("2026-10-18T08:00:00", now), "Sunday, Oct 18");
  assert.equal(dayLabel("2025-12-31T08:00:00", now), "Wednesday, Dec 31, 2025");
  assert.equal(dayLabel("nonsense", now), "Earlier");
});

test("notices are grouped by day in the order given", () => {
  assert.deepEqual(
    groupByDay(noticesFor(notes, "all", false), now).map((g) => [
      g.label,
      g.notes.map((n) => n.id),
    ]),
    [
      ["Today", ["b", "a"]],
      ["Yesterday", ["c"]],
      ["Sunday, Oct 18", ["d"]],
    ],
  );
});

test("who a notice is from is the name, else the address, else no one", () => {
  assert.equal(noticeFrom({ byName: "Max Member", by: "max@example.com" }), "Max Member");
  assert.equal(noticeFrom({ by: "max@example.com" }), "max@example.com");
  assert.equal(noticeFrom({}), "");
});
