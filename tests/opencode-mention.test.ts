/**
 * The agent's mention is taken out of the words it is given.
 * Run with: npx tsx --test tests/opencode-mention.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripMention } from "../apps/server/src/opencode/agui.ts";

const MENTION = "@hive";

describe("stripMention", () => {
  it("removes the token and tidies whitespace", () => {
    assert.equal(stripMention("@hive do the thing", MENTION), "do the thing");
    assert.equal(stripMention("hey @Hive, do it", MENTION), "hey , do it");
    assert.equal(stripMention("@hive", MENTION), "");
  });
  it("removes every occurrence", () => {
    assert.equal(stripMention("@hive one @hive two", MENTION), "one two");
  });
  it("leaves non-mentions alone", () => {
    assert.equal(stripMention("@hiveX do it", MENTION), "@hiveX do it");
  });
});
