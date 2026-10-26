import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeActivity } from "../src/activity-scope.ts";

const action = (id: string, taskId?: string) =>
  ({ id, taskId, title: id, status: "awaiting_review" }) as never;
const entry = (id: string, actionId?: string) => ({ id, actionId }) as never;
const all = {
  actions: [action("a1", "t1"), action("a2", "t2"), action("a3")],
  activity: [entry("e1", "a1"), entry("e2", "a2"), entry("e3", "a3"), entry("e4")],
};
const tasks = [
  { id: "t1", projectId: "web" },
  { id: "t2", projectId: "hire" },
];

test("with no project, the activity is all of it, the workspace's own entries too", () => {
  assert.equal(scopeActivity(all, tasks, null), all);
});

test("in a project, only the reviews and entries about its tasks are shown", () => {
  const web = scopeActivity(all, tasks, "web");
  assert.deepEqual(
    web.actions.map((a) => a.id),
    ["a1"],
  );
  assert.deepEqual(
    web.activity.map((e) => e.id),
    ["e1"],
  );
  const none = scopeActivity(all, tasks, "empty");
  assert.deepEqual([none.actions.length, none.activity.length], [0, 0]);
});
