import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeMention,
  insertMention,
  matchPeople,
  mentionedPeople,
  mentionsIn,
  splitMentions,
  withHandles,
} from "../../../packages/domain/src/mentions.ts";

const people = withHandles([
  { email: "max@example.com", name: "Max Member", role: "member" },
  { email: "mia@example.com", name: "Mia Moreno", role: "member" },
  { email: "sam@a.test", name: "Sam North", role: "member" },
  { email: "sam@b.test", name: "Sam South", role: "guest" },
]);

test("a handle is the name part of the address, or all of it where two people share it", () => {
  assert.deepEqual(
    people.map((p) => p.handle),
    ["max", "mia", "sam@a.test", "sam@b.test"],
  );
});

test("mentions are found in running text and not in email addresses or the middle of words", () => {
  assert.deepEqual(mentionsIn("hi @Max, and @mia. also @sam@a.test!"), [
    "max",
    "mia",
    "sam@a.test",
  ]);
  assert.deepEqual(mentionsIn("mail max@example.com or foo@bar"), []);
  assert.deepEqual(mentionsIn("@hive plan @max's day"), ["hive", "max"]);
  assert.deepEqual(mentionsIn("@max @max"), ["max"]);
});

test("a text mentions the people whose handles it says, and no one for a handle nobody has", () => {
  assert.deepEqual(
    mentionedPeople("@max and @nobody and @sam@b.test", people).map((p) => p.email),
    ["max@example.com", "sam@b.test"],
  );
  // A shared name part is not a handle, so it names no one.
  assert.deepEqual(mentionedPeople("@sam", people), []);
});

test("the mention being typed is found from the cursor", () => {
  assert.deepEqual(activeMention("hello @ma", 9), { start: 6, query: "ma" });
  assert.deepEqual(activeMention("@", 1), { start: 0, query: "" });
  assert.equal(activeMention("hello @ma there", 15), null);
  assert.equal(activeMention("mail me@ma", 10), null);
  assert.deepEqual(activeMention("(@mi", 4), { start: 1, query: "mi" });
});

test("people are offered by what starts the handle or a word of the name", () => {
  // Names that start with it come first; ones that only hold it come after.
  assert.deepEqual(
    matchPeople(people, "m").map((p) => p.handle),
    ["max", "mia", "sam@a.test", "sam@b.test"],
  );
  assert.deepEqual(
    matchPeople(people, "mor").map((p) => p.handle),
    ["mia"],
  );
  assert.deepEqual(
    matchPeople(people, "north").map((p) => p.handle),
    ["sam@a.test"],
  );
  assert.deepEqual(matchPeople(people, "zzz"), []);
  assert.equal(matchPeople(people, "", 2).length, 2);
});

test("choosing someone puts their handle where the typing was and moves the cursor past it", () => {
  const active = activeMention("hello @ma there", 9);
  assert.ok(active);
  assert.deepEqual(insertMention("hello @ma there", active, 9, "max"), {
    text: "hello @max there",
    cursor: 11,
  });
  const end = activeMention("ping @m", 7);
  assert.ok(end);
  assert.deepEqual(insertMention("ping @m", end, 7, "mia"), { text: "ping @mia ", cursor: 10 });
});

test("only the mentions that name someone are set apart", () => {
  assert.deepEqual(splitMentions("hi @max, ask @ghost and @hive", ["max", "hive"]), [
    { text: "hi ", mention: false },
    { text: "@max", mention: true },
    { text: ", ask @ghost and ", mention: false },
    { text: "@hive", mention: true },
  ]);
  assert.deepEqual(splitMentions("plain", ["max"]), [{ text: "plain", mention: false }]);
});
