import type { MakingStepName } from "./control-api";

export type StepState = "done" | "now" | "next";
export interface MakingStep {
  key: MakingStepName;
  label: string;
  state: StepState;
}

/** What making a workspace goes through, in the order the control plane reports it. */
const steps: { key: MakingStepName; label: string; from: number }[] = [
  { key: "address", label: "Finding a spot on the internet", from: 0.04 },
  { key: "machine", label: "Unpacking a fresh machine", from: 0.14 },
  { key: "starting", label: "Switching the lights on", from: 0.34 },
  { key: "checking", label: "Saying hello", from: 0.72 },
];

/** Where the bar stands when a step has just begun, and where it is heading. A step never fills past the next one's start. */
const END = 0.96;

/**
 * The checklist for a workspace on `step`, or null when the control plane did not say (an older
 * one, or a host with no steps of its own) and only a spinner is honest. Steps before the current
 * one count as done, including ones the host skipped.
 */
export function stepList(step: string | undefined): MakingStep[] | null {
  const at = steps.findIndex((candidate) => candidate.key === step);
  if (at < 0) return null;
  return steps.map(({ key, label }, index) => ({
    key,
    label,
    state: index < at ? "done" : index === at ? "now" : "next",
  }));
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

/** Said while waiting, a few seconds each. Nothing here is a claim about what the machine is doing. */
const lines = [
  "Plumping the cushions.",
  "Tidying the honeycomb.",
  "Teaching the agent where the good chairs are.",
  "Hanging up the do-not-disturb sign.",
  "Sharpening a few pencils.",
  "Bees do not stop for much. This one is almost done.",
];
export const FLAVOR_SECONDS = 4;

/** The line to show `seconds` after the screen came up: one at a time, in order, round again. */
export function flavorAt(seconds: number): string {
  return lines[Math.floor(Math.max(0, seconds) / FLAVOR_SECONDS) % lines.length];
}
