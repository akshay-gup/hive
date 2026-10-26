import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessChoices,
  accessLine,
  accessWord,
  canChangeTask,
  canWorkIn,
  destinations,
  initialsOf,
  markRow,
  nameMatches,
  roleChoices,
} from "../src/project-text.ts";

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

test("where a deleted project's tasks can go: any other project they may work in, General first, searchable", () => {
  const projects = [
    { id: "p1", name: "Website" },
    { id: "general", name: "General" },
    { id: "p2", name: "Hiring", you: { canWork: true } },
    { id: "p3", name: "Launch plan", you: { canWork: false } },
    { id: "gone", name: "Reorg" },
    { id: "p4", name: "Audit" },
  ];
  assert.deepEqual(
    destinations(projects, "gone").map((p) => p.name),
    ["General", "Audit", "Hiring", "Website"],
    "not itself, not where they only look",
  );
  assert.deepEqual(
    destinations(projects, "gone", "  WEB ").map((p) => p.name),
    ["Website"],
  );
  assert.deepEqual(destinations(projects, "gone", "zzz"), []);
});

test("a project is deleted by typing its name, whatever the case and the spaces around it", () => {
  assert.equal(nameMatches("Reorg", "Reorg"), true);
  assert.equal(nameMatches("  reorg ", "Reorg"), true);
  assert.equal(nameMatches("Reor", "Reorg"), false);
  assert.equal(nameMatches("", "Reorg"), false);
});

test("a task is the person's to change unless its project lets them only look", () => {
  const projects = [
    { id: "open", you: { canWork: true } },
    { id: "view", you: { canWork: false } },
  ];
  assert.equal(canChangeTask({ projectId: "open" }, projects), true);
  assert.equal(canChangeTask({ projectId: "view" }, projects), false);
  assert.equal(canChangeTask({ projectId: null }, projects), true);
  assert.equal(canChangeTask({ projectId: "unknown" }, projects), true);
});

test("a person's mark is the first letters of their name, or of their address when they have none", () => {
  assert.equal(initialsOf("Max Member", "max@example.com"), "MM");
  assert.equal(initialsOf("Ada Lovelace King", "ada@example.com"), "AK");
  assert.equal(initialsOf("Olive", "olive@example.com"), "OL");
  assert.equal(initialsOf("", "gus@example.com"), "GU");
  assert.equal(initialsOf("", ""), "?");
});

test("a row of marks shows the first few and counts the rest", () => {
  assert.deepEqual(markRow([1, 2, 3]), { shown: [1, 2, 3], more: 0 });
  assert.deepEqual(markRow([1, 2, 3, 4, 5, 6, 7]), { shown: [1, 2, 3, 4, 5], more: 2 });
  assert.equal(accessWord("limited"), "Limited");
  assert.equal(accessWord(undefined), "Open");
});
