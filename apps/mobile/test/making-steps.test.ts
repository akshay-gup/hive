import assert from "node:assert/strict";
import { test } from "node:test";
import { barFill, FLAVOR_SECONDS, flavorAt, stepList } from "../src/hosted/making-steps.ts";

test("the checklist ticks off the steps before the current one, and shows the rest as waiting", () => {
  const list = stepList("starting");
  assert.deepEqual(
    list?.map((item) => [item.key, item.state]),
    [
      ["address", "done"],
      ["machine", "done"],
      ["starting", "now"],
      ["checking", "next"],
    ],
  );
  assert.equal(stepList("address")?.[0]?.state, "now");
  assert.ok(
    stepList("checking")?.every((item, index) =>
      index < 3 ? item.state === "done" : item.state === "now",
    ),
  );
});

test("there is no checklist when the control plane did not say which step, or said one this app does not know", () => {
  assert.equal(stepList(undefined), null);
  assert.equal(stepList(""), null);
  assert.equal(stepList("teleporting"), null);
});

test("the bar jumps ahead with each real step and only creeps inside one", () => {
  const steps = ["address", "machine", "starting", "checking"];
  const starts = steps.map((step) => barFill(step, 0));
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], steps[i]);
  for (let i = 0; i < steps.length - 1; i++) {
    // However long a step takes, the bar stays short of where the next one starts.
    assert.ok(barFill(steps[i], 10_000) < starts[i + 1], steps[i]);
    assert.ok(barFill(steps[i], 5) > starts[i], steps[i]);
  }
  assert.ok(barFill("checking", 10_000) < 1);
});

test("the bar never runs backwards in a step, and a negative wait counts as none", () => {
  let last = 0;
  for (let seconds = 0; seconds <= 60; seconds++) {
    const fill = barFill("starting", seconds);
    assert.ok(fill >= last);
    last = fill;
  }
  assert.equal(barFill("machine", -5), barFill("machine", 0));
  assert.ok(barFill(undefined, 30) < barFill("address", 0) + 0.01);
});

test("the company line changes every few seconds, in order, and comes round again", () => {
  const first = flavorAt(0);
  assert.equal(flavorAt(FLAVOR_SECONDS - 0.1), first);
  assert.notEqual(flavorAt(FLAVOR_SECONDS), first);
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) seen.add(flavorAt(i * FLAVOR_SECONDS));
  assert.ok(seen.size >= 5);
  // Round again after all of them.
  assert.equal(flavorAt(seen.size * FLAVOR_SECONDS), first);
  assert.equal(flavorAt(-3), first);
});
