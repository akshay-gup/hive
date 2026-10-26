import assert from "node:assert/strict";
import { test } from "node:test";
import { footprintLines } from "../src/channel-footprint.ts";

test("what deleting a channel takes is said line by line, in the plural that fits", () => {
  const lines = footprintLines({
    messages: 120,
    threads: 4,
    files: 3,
    fileBytes: 5 * 1024 * 1024,
    people: 6,
    agentRuns: 2,
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? "", /120 messages, including 4 conversations in threads/);
  assert.match(lines[1] ?? "", /3 files \(5(\.0)? ?MB\), for good/);
  assert.match(lines[2] ?? "", /2 requests/);
  assert.match(lines[3] ?? "", /6 people lose it/);
});

test("a channel with one of everything, and one with nothing, read right", () => {
  const one = footprintLines({
    messages: 1,
    threads: 1,
    files: 1,
    fileBytes: 10,
    people: 1,
    agentRuns: 1,
  });
  assert.match(one[0] ?? "", /1 message, including 1 conversation in threads/);
  assert.match(one[1] ?? "", /^1 file /);
  assert.match(one[3] ?? "", /^1 person loses it/);
  const none = footprintLines({
    messages: 0,
    threads: 0,
    files: 0,
    fileBytes: 0,
    people: 2,
    agentRuns: 0,
  });
  assert.equal(none[0], "No messages");
  assert.equal(none[1], "No files");
  assert.match(none[2] ?? "", /^Anything the agent kept/);
});
