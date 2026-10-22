import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  dependencyLinks,
  groupTasks,
  monthSpans,
  placeTask,
  taskGroup,
  timelineWindow,
} from "../src/task-view.ts";

const task = (id: string, over: Partial<AgentTask>): AgentTask =>
  ({
    id,
    title: id,
    prompt: "",
    kind: "agent",
    status: "queued",
    priority: "medium",
    blockedBy: [],
    labels: [],
    plan: [],
    evidence: [],
    input: {},
    state: {},
    attempts: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
    ...over,
  }) as AgentTask;

const utc = (value: string) => Date.parse(`${value}T00:00:00Z`);

test("a task is in the group that says what to do about it", () => {
  assert.equal(taskGroup(task("a", { status: "waiting_input" })), "needs");
  assert.equal(taskGroup(task("a", { status: "in_review" })), "needs");
  // A manual task never waits on the person in that sense: it is theirs already.
  assert.equal(taskGroup(task("a", { status: "in_review", kind: "manual" })), "todo");
  assert.equal(taskGroup(task("a", { status: "running" })), "running");
  assert.equal(taskGroup(task("a", { status: "scheduled" })), "todo");
  assert.equal(taskGroup(task("a", { status: "paused" })), "todo");
  assert.equal(taskGroup(task("a", { status: "failed" })), "failed");
  assert.equal(taskGroup(task("a", { status: "succeeded" })), "done");
  assert.equal(taskGroup(task("a", { status: "cancelled" })), "done");
});

test("groups come in order, empty ones are left out, and each is in a useful order", () => {
  const groups = groupTasks([
    task("late", { status: "queued", dueAt: "2026-11-02" }),
    task("soon", { status: "queued", dueAt: "2026-10-25" }),
    task("none", { status: "queued", updatedAt: "2026-10-20T00:00:00Z" }),
    task("waited-longer", { status: "waiting_input", updatedAt: "2026-10-01T00:00:00Z" }),
    task("waited-less", { status: "in_review", updatedAt: "2026-10-05T00:00:00Z" }),
    task("done", { status: "succeeded" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.tasks.map((t) => t.id)]),
    [
      ["needs", ["waited-longer", "waited-less"]],
      ["todo", ["soon", "late", "none"]],
      ["done", ["done"]],
    ],
  );
});

test("a task falls on the calendar by its start and due days", () => {
  const start = utc("2026-10-19");
  assert.deepEqual(placeTask({ startAt: "2026-10-21", dueAt: "2026-10-24" }, start), {
    startOffset: 2,
    endOffset: 5,
    milestone: false,
  });
  // Only a due date: a mark on that day.
  assert.deepEqual(placeTask({ startAt: null, dueAt: "2026-10-25" }, start), {
    startOffset: 6,
    endOffset: 6,
    milestone: true,
  });
  // Only a start: one day.
  assert.deepEqual(placeTask({ startAt: "2026-10-20", dueAt: null }, start), {
    startOffset: 1,
    endOffset: 1,
    milestone: false,
  });
  // Due before start does not run backwards.
  assert.deepEqual(placeTask({ startAt: "2026-10-22", dueAt: "2026-10-20" }, start), {
    startOffset: 3,
    endOffset: 3,
    milestone: false,
  });
  assert.equal(placeTask({ startAt: null, dueAt: null }, start), null);
});

test("the chart starts on a Monday before the first date and runs past the last", () => {
  const today = utc("2026-10-22"); // a Thursday
  const empty = timelineWindow([], today, "weeks");
  assert.equal(new Date(empty.start).getUTCDay(), 1);
  assert.equal(empty.start, utc("2026-10-19"));
  assert.equal(empty.today, 3);
  assert.ok(empty.days >= 28);
  const far = timelineWindow([{ startAt: "2026-09-01", dueAt: "2026-12-30" }], today, "weeks");
  assert.equal(new Date(far.start).getUTCDay(), 1);
  assert.ok(far.start <= utc("2026-08-31"));
  assert.ok(far.days <= 182);
  // A whole month scale looks further ahead.
  assert.ok(timelineWindow([], today, "months").days > empty.days);
});

test("a dependency is drawn only between two tasks that are both on the chart", () => {
  const tasks = [
    { id: "a", blockedBy: [] },
    { id: "b", blockedBy: ["a", "gone"] },
    { id: "c", blockedBy: ["b"] },
  ];
  assert.deepEqual(dependencyLinks(tasks, new Set(["a", "b"])), [{ from: "a", to: "b" }]);
  assert.deepEqual(dependencyLinks(tasks, new Set(["a", "b", "c"])), [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
});

test("months along the top split where the month changes", () => {
  const spans = monthSpans({ start: utc("2026-10-26"), days: 14, today: 0 });
  assert.deepEqual(
    spans.map((s) => [s.label, s.offset, s.days]),
    [
      ["October 2026", 0, 6],
      ["November 2026", 6, 8],
    ],
  );
});
