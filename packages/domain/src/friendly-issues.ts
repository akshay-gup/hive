import type { z } from "zod";

/** What zod says when nobody wrote a message of their own: it reads like a type checker, not like a person. */
const stock = /^(Too (big|small): |Invalid (input|option|string|number|email|url|uuid)|Invalid )/i;

const plain = (issue: z.core.$ZodIssue): string => {
  const limit = (issue as { maximum?: unknown; minimum?: unknown }).maximum;
  const floor = (issue as { maximum?: unknown; minimum?: unknown }).minimum;
  const origin = (issue as { origin?: string }).origin;
  switch (issue.code) {
    case "too_big":
      return origin === "string"
        ? `That is too long: ${limit} characters at most.`
        : origin === "array" || origin === "set"
          ? `That has too many items: ${limit} at most.`
          : `That number is too big: ${limit} at most.`;
    case "too_small":
      return origin === "string"
        ? Number(floor) <= 1
          ? "That cannot be empty."
          : `That is too short: ${floor} characters at least.`
        : origin === "array" || origin === "set"
          ? `That needs at least ${floor} item${Number(floor) === 1 ? "" : "s"}.`
          : `That number is too small: ${floor} at least.`;
    case "invalid_type":
      return (issue as { input?: unknown }).input === undefined
        ? "Something that is needed is missing."
        : "That is not the kind of thing that was expected.";
    case "invalid_value":
      return "Choose one of the options that are offered.";
    case "invalid_format":
      return "That does not look right.";
    default:
      return "That is not valid.";
  }
};

/** The problems with a request, in plain words, one after another. Messages written for people are kept as they are. */
export function plainIssues(issues: readonly z.core.$ZodIssue[]): string {
  const said = issues.map((issue) => (stock.test(issue.message) ? plain(issue) : issue.message));
  return [...new Set(said)].join(" ");
}
