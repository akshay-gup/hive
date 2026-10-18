import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceBar,
  type BarState,
  barFill,
  FLAVOR_SECONDS,
  flavorAt,
  stepList,
} from "../src/hosted/making-steps.ts";

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

test("the four steps are listed from the start, all waiting, when the control plane has not said which one or said one this app does not know", () => {
  const known = stepList("address").map((item) => item.key);
  for (const step of [undefined, "", "teleporting"]) {
    const list = stepList(step);
    assert.deepEqual(
      list.map((item) => item.key),
      known,
    );
    assert.ok(
      list.every((item) => item.state === "next"),
      `${step}: nothing is ticked off or called current without being told`,
    );
  }
  // The words do not change when the step arrives; only the marks do.
  assert.deepEqual(
    stepList(undefined).map((item) => item.label),
    stepList("machine").map((item) => item.label),
  );
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

const begin = (step: string | undefined, now: number): BarState => ({
  step,
  since: now,
  fill: barFill(step, 0),
});

test("a new step starts the bar at that step's start, not at the end of it", () => {
  // The old step had been going for a minute; the new one has just been told.
  let bar = begin("machine", 0);
  bar = advanceBar(bar, "machine", 60_000);
  const before = bar.fill;
  bar = advanceBar(bar, "starting", 60_000);
  assert.equal(bar.fill, Math.max(before, barFill("starting", 0)));
  assert.ok(bar.fill < barFill("starting", 10), "it has not leapt ahead into the new step");
  assert.equal(bar.since, 60_000);
});

test("the bar never goes back, whatever the steps and the clock do", () => {
  const script: [number, string | undefined][] = [
    [0, undefined],
    [4, "address"],
    [20, "machine"],
    [75, "starting"],
    [76, "starting"],
    [140, "checking"],
    [200, "checking"],
    // Even a step reported late or out of order does not pull it back.
    [201, "starting"],
    [210, "checking"],
  ];
  let bar = begin(undefined, 0);
  let last = 0;
  for (let seconds = 0; seconds <= 210; seconds += 0.5) {
    const step = script.filter(([at]) => at <= seconds).pop()?.[1];
    bar = advanceBar(bar, step, seconds * 1000);
    assert.ok(bar.fill >= last, `${seconds}s: ${bar.fill} fell from ${last}`);
    last = bar.fill;
  }
  assert.ok(last < 1);
});

test("the bar's clock restarts only when the step changes", () => {
  let bar = begin("address", 1_000);
  bar = advanceBar(bar, "address", 9_000);
  assert.equal(bar.since, 1_000);
  bar = advanceBar(bar, "machine", 12_000);
  assert.equal(bar.since, 12_000);
});
