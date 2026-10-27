import type { MakingStepName } from "./control-api";

export type StepState = "done" | "now" | "next";
export interface MakingStep {
  key: MakingStepName;
  label: string;
  state: StepState;
}

/** What making a workspace goes through, in the order the control plane reports it. */
const steps: { key: MakingStepName; label: string; from: number }[] = [
  { key: "address", label: "Getting an address for it", from: 0.04 },
  { key: "machine", label: "Setting up its computer", from: 0.14 },
  { key: "starting", label: "Starting it up", from: 0.34 },
  { key: "checking", label: "Checking that it works", from: 0.72 },
];

/** Where the bar stands when a step has just begun, and where it is heading. A step never fills past the next one's start. */
const END = 0.96;

/**
 * The checklist for a workspace on `step`. The steps are always these four, so they are there from
 * the first moment; what the control plane has not said yet is only which one it is on. Before it
 * says (or if it names one this app does not know) every step is waiting, since ticking one off
 * or calling it current would be a guess. Steps before the current one count as done, including
 * ones the host skipped.
 */
export function stepList(step: string | undefined): MakingStep[] {
  const at = steps.findIndex((candidate) => candidate.key === step);
  return steps.map(({ key, label }, index) => ({
    key,
    label,
    state: at < 0 ? "next" : index < at ? "done" : index === at ? "now" : "next",
  }));
}

/**
 * The step to show: the furthest one seen. The control plane checks that a new workspace answers in
 * rounds, and each round says the early steps again, so what it reports can go back a step; what
 * the person sees only moves forward.
 */
export function furthestStep(
  before: string | undefined,
  step: string | undefined,
): string | undefined {
  const index = (name: string | undefined) =>
    steps.findIndex((candidate) => candidate.key === name);
  return index(step) >= index(before) ? step : before;
}

/**
 * How full the bar is, from 0 to 1. It moves in jumps with the real steps and creeps inside one,
 * slowing as it nears the next, so it keeps moving without claiming a step it has not reached.
 */
export function barFill(step: string | undefined, secondsInStep: number): number {
  const at = steps.findIndex((candidate) => candidate.key === step);
  if (at < 0) return 0.04;
  const start = steps[at].from;
  const end = steps[at + 1]?.from ?? END;
  const creep = 1 - Math.exp(-Math.max(0, secondsInStep) / 12);
  return start + (end - start) * 0.9 * creep;
}

/**
 * The bar's memory: the step it is on, when that began, and the furthest it has been. Its fill is
 * kept here, not worked out afresh each time, so it can only go forward.
 */
export interface BarState {
  step: string | undefined;
  /** When `step` was first seen, in milliseconds. */
  since: number;
  fill: number;
}

/**
 * The bar after `now`. A step is timed from when it was first seen, not from the one before it: a
 * new step measured with the old one's clock would leap to the end of its stretch and fall back to
 * the start on the next tick. And whatever the clock says, the bar does not move backwards.
 */
export function advanceBar(state: BarState, step: string | undefined, now: number): BarState {
  const since = state.step === step ? state.since : now;
  return { step, since, fill: Math.max(state.fill, barFill(step, (now - since) / 1000)) };
}

/** Said while waiting, a few seconds each, in plain words. Nothing here is a claim about what the machine is doing right now. */
const lines = [
  "This only happens once for each workspace.",
  "Your workspace gets a computer of its own.",
  "You can leave this page. The setup carries on.",
  "Everything your team writes is kept in the workspace.",
  "When it is ready you will be taken in.",
  "The last step checks that it all works.",
];
export const FLAVOR_SECONDS = 4;

/** The line to show `seconds` after the screen came up: one at a time, in order, round again. */
export function flavorAt(seconds: number): string {
  return lines[Math.floor(Math.max(0, seconds) / FLAVOR_SECONDS) % lines.length];
}
