import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedResult } from "../apps/server/src/opencode/agui.ts";

test("a long page read still reaches the chat as JSON the card can show", () => {
  const page = JSON.stringify({
    sessionId: "s1",
    title: "A long page",
    url: "https://example.com/a",
    text: "word ".repeat(6000),
    truncated: false,
  });
  const sent = JSON.parse(forwardedResult("browse_web", page));
  assert.equal(sent.sessionId, "s1");
  assert.equal(sent.title, "A long page");
  assert.equal(sent.url, "https://example.com/a");
  assert.ok(forwardedResult("browse_web", page).length <= 2000);
});

test("other tool results are cut at the limit, and choices are kept whole", () => {
  assert.equal(forwardedResult("bash", "x".repeat(5000)).length, 2000);
  assert.equal(forwardedResult("present_choices", "y".repeat(5000)).length, 5000);
});
