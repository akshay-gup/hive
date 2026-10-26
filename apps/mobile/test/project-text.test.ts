import assert from "node:assert/strict";
import { test } from "node:test";
import { accessChoices, accessLine, canWorkIn, roleChoices } from "../src/project-text.ts";

test("a project is open when it does not say, and each way of being open has its own words", () => {
  assert.equal(accessLine(undefined), accessChoices[0]?.detail);
  assert.deepEqual(
    accessChoices.map((choice) => choice.id),
    ["open", "limited", "private"],
  );
  assert.deepEqual(
    roleChoices.map((role) => role.id),
    ["admin", "member", "viewer"],
  );
});

test("work may be put in a project unless the server says the person cannot", () => {
  assert.equal(canWorkIn({}), true);
  assert.equal(canWorkIn({ you: { canWork: true } }), true);
  assert.equal(canWorkIn({ you: { canWork: false } }), false);
});
