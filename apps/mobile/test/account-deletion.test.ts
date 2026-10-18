import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmationWord,
  matchesConfirmation,
  planAccountDeletion,
} from "../src/hosted/account-deletion.ts";
import type { Role, WorkspaceSummary } from "../src/hosted/control-api.ts";

const workspace = (role: Role, name = "foster"): WorkspaceSummary => ({
  id: `w-${name}`,
  name,
  role,
  status: "ready",
  createdAt: "2026-10-17T00:00:00Z",
});

test("with no workspace, or only a place in someone else's, the account is deleted plainly", () => {
  assert.deepEqual(planAccountDeletion([], undefined), { kind: "plain" });
  assert.deepEqual(planAccountDeletion([workspace("member"), workspace("admin", "b")], undefined), {
    kind: "plain",
  });
});

test("before the list of workspaces has come, nothing is known and nothing can be confirmed", () => {
  assert.deepEqual(planAccountDeletion(null, undefined), { kind: "loading" });
  assert.deepEqual(planAccountDeletion(null, 3), { kind: "loading" });
  assert.equal(confirmationWord({ kind: "loading" }, "a@b.co"), null);
});

test("an owner is asked about the workspace only once it is known who else is in it", () => {
  const owned = workspace("owner");
  assert.deepEqual(planAccountDeletion([owned], undefined), { kind: "checking", workspace: owned });
});

test("an owner alone takes the workspace with them; one with company has to delete it first", () => {
  const owned = workspace("owner");
  assert.deepEqual(planAccountDeletion([owned], 1), { kind: "owner-alone", workspace: owned });
  assert.deepEqual(planAccountDeletion([owned], 4), {
    kind: "owner-with-others",
    workspace: owned,
    others: 3,
  });
});

test("the owner's own workspace is the one that counts, among several", () => {
  const plan = planAccountDeletion([workspace("member", "theirs"), workspace("owner", "mine")], 1);
  assert.equal(plan.kind === "owner-alone" && plan.workspace.name, "mine");
});

test("what has to be typed: the email for a plain deletion, the workspace's name with it, nothing when blocked", () => {
  const owned = workspace("owner");
  assert.equal(confirmationWord({ kind: "plain" }, "ada@example.com"), "ada@example.com");
  assert.equal(confirmationWord({ kind: "owner-alone", workspace: owned }, "a@b.co"), "foster");
  assert.equal(
    confirmationWord({ kind: "owner-with-others", workspace: owned, others: 2 }, "a@b.co"),
    null,
  );
  assert.equal(confirmationWord({ kind: "checking", workspace: owned }, "a@b.co"), null);
});

test("typing it by hand: case and spaces around it do not matter, a different word does, and nothing never matches", () => {
  assert.ok(matchesConfirmation("  Ada@Example.com ", "ada@example.com"));
  assert.ok(matchesConfirmation("FOSTER", "foster"));
  assert.ok(!matchesConfirmation("foste", "foster"));
  assert.ok(!matchesConfirmation("", ""));
  assert.ok(!matchesConfirmation("  ", "  "));
});
