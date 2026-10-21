import assert from "node:assert/strict";
import { test } from "node:test";
import { describeInvite, expiresIn, invitedAs, roleLabel } from "../src/hosted/people-text.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 10, 12);
const invite = {
  id: "i1",
  role: "member" as const,
  createdBy: "a",
  createdAt: "2026-10-10T12:00:00.000Z",
  expiresAt: now + 7 * DAY,
  maxUses: 50,
  uses: 3,
};

test("how long an invitation has left is said in days, then as today or expired", () => {
  assert.equal(expiresIn(now + 7 * DAY, now), "expires in 7 days");
  assert.equal(expiresIn(now + 2.5 * DAY, now), "expires in 3 days");
  assert.equal(expiresIn(now + 2 * DAY, now), "expires tomorrow");
  assert.equal(expiresIn(now + 5 * 60 * 60 * 1000, now), "expires today");
  assert.equal(expiresIn(now - 1, now), "expired");
});

test("a link invitation says how much of it is used, and one for an address says whose it is", () => {
  assert.deepEqual(describeInvite(invite, now), {
    title: "Invite link",
    detail: "3 of 50 used · expires in 7 days",
  });
  assert.deepEqual(
    describeInvite(
      { ...invite, email: "friend@example.com", role: "admin", maxUses: 1, uses: 0 },
      now,
    ),
    { title: "friend@example.com", detail: "Admin · expires in 7 days" },
  );
});

test("roles have names people would use", () => {
  assert.deepEqual(roleLabel, {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
    guest: "Guest",
  });
});

test("an invitation for a guest says so, in the list and in the words of the invitation", () => {
  assert.deepEqual(
    describeInvite(
      { ...invite, email: "client@example.com", role: "guest", maxUses: 1, uses: 0 },
      now,
    ),
    { title: "client@example.com", detail: "Guest · expires in 7 days" },
  );
  assert.equal(invitedAs("guest"), " as a guest");
  assert.equal(invitedAs("admin"), " as an admin");
  assert.equal(invitedAs("member"), "");
});
