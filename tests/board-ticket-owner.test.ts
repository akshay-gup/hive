import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTicket } from "../apps/chat/src/board-ticket.ts";
import { ticketIsFor } from "../apps/server/src/chat-runner/work-link.ts";

const key = "k".repeat(32);
const ticketOf = (userId: string) =>
  makeTicket(key, { workspaceId: "w1", userId, exp: Date.now() + 60_000 });

test("a ticket is good only for the person it names", () => {
  assert.equal(ticketIsFor(ticketOf("acct_ada"), "acct:acct_ada"), true);
  assert.equal(ticketIsFor(ticketOf("acct_ada"), "acct:acct_bob"), false);
  assert.equal(ticketIsFor(ticketOf("acct_ada"), "local-user"), false);
});

test("a ticket that is not a ticket names nobody", () => {
  for (const junk of ["", "garbage", "a.b", "e30.x", "bnVsbA.x"])
    assert.equal(ticketIsFor(junk, "acct:acct_ada"), false);
});
