import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskStatus } from "../../../packages/domain/src/agent.ts";
import {
  elapsedLabel,
  needsYou,
  orderColumn,
  runStartedAt,
  watchRuns,
} from "../src/board-order.ts";

const card = (id: string, status: TaskStatus, updatedAt = "2026-10-16T10:00:00.000Z") => ({
  id,
  status,
  updatedAt,
});

test("a task needs a person when the agent has stopped for an approval, an answer or a review", () => {
  for (const status of ["waiting_approval", "waiting_input", "in_review"] as const)
    assert.equal(needsYou(status), true, status);
  for (const status of ["queued", "running", "paused", "failed", "succeeded"] as const)
    assert.equal(needsYou(status), false, status);
});

test("cards that need a person come first, the longest waiting on top, and the rest keep their order", () => {
  const column = [
    card("run-a", "running"),
    card("review", "in_review", "2026-10-16T10:30:00.000Z"),
    card("run-b", "running"),
    card("answer", "waiting_input", "2026-10-16T09:00:00.000Z"),
    card("approve", "waiting_approval", "2026-10-16T10:10:00.000Z"),
  ];
  assert.deepEqual(
    orderColumn(column).map((task) => task.id),
    ["answer", "approve", "review", "run-a", "run-b"],
  );
  assert.deepEqual(
    column.map((task) => task.id),
    ["run-a", "review", "run-b", "answer", "approve"],
    "the list it was given is left as it was",
  );
});

test("a column with nothing waiting is not reordered", () => {
  const column = [card("b", "running"), card("a", "running")];
  assert.deepEqual(
    orderColumn(column).map((task) => task.id),
    ["b", "a"],
  );
});

test("elapsed time reads as minutes and seconds, then hours, then days", () => {
  assert.equal(elapsedLabel(0), "0:00");
  assert.equal(elapsedLabel(-5000), "0:00");
  assert.equal(elapsedLabel(9_000), "0:09");
  assert.equal(elapsedLabel(134_000), "2:14");
  assert.equal(elapsedLabel(59 * 60_000 + 59_000), "59:59");
  assert.equal(elapsedLabel(3_900_000), "1h 05m");
  assert.equal(elapsedLabel(27 * 3_600_000), "1d 3h");
});

test("the start the workspace recorded wins; otherwise the start this screen saw", () => {
  const recorded = "2026-10-16T10:00:00.000Z";
  assert.equal(runStartedAt({ runStartedAt: recorded }, 5), Date.parse(recorded));
  assert.equal(runStartedAt({}, 5), 5);
  assert.equal(runStartedAt({ runStartedAt: "not a date" }, 5), 5);
  assert.equal(runStartedAt({}), undefined);
});

test("the board times a task it saw start, and not one that was already running", () => {
  const watch = watchRuns();
  assert.equal(
    watch([{ id: "t", status: "running" }], 100).has("t"),
    false,
    "running when it opened",
  );
  assert.equal(watch([{ id: "t", status: "running" }], 200).has("t"), false);

  assert.equal(watch([{ id: "u", status: "queued" }], 300).has("u"), false);
  assert.equal(watch([{ id: "u", status: "running" }], 400).get("u"), 400, "saw it start");
  assert.equal(watch([{ id: "u", status: "running" }], 500).get("u"), 400, "the time holds");
  assert.equal(watch([{ id: "u", status: "waiting_input" }], 600).has("u"), false, "it stopped");
  assert.equal(watch([{ id: "u", status: "running" }], 700).get("u"), 700, "a new run, a new time");
});
