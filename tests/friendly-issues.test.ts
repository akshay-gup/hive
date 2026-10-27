import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { plainIssues } from "../packages/domain/src/friendly-issues.ts";

const say = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  assert.equal(result.success, false);
  return plainIssues(result.error?.issues ?? []);
};

test("zod's stock messages are put in plain words", () => {
  assert.equal(say(z.string().max(64), "x".repeat(80)), "That is too long: 64 characters at most.");
  assert.equal(say(z.string().min(1), ""), "That cannot be empty.");
  assert.equal(say(z.string().min(5), "ab"), "That is too short: 5 characters at least.");
  assert.equal(say(z.object({ name: z.string() }), {}), "Something that is needed is missing.");
  assert.equal(say(z.enum(["a", "b"]), "c"), "Choose one of the options that are offered.");
  assert.equal(
    say(z.array(z.string()).max(2), ["a", "b", "c"]),
    "That has too many items: 2 at most.",
  );
});

test("a message someone wrote for people is kept, and the same thing is not said twice", () => {
  assert.equal(say(z.string().min(1, "Enter a name"), ""), "Enter a name");
  assert.equal(
    say(z.object({ a: z.string(), b: z.string() }), {}),
    "Something that is needed is missing.",
  );
});
