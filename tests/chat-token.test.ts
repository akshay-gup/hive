import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateWorkspaceKeys,
  signChatPurge,
  signChatRevocation,
  signChatToken,
  signRevocation,
  signWorkspaceToken,
  verifyChatPurge,
  verifyChatRevocation,
  verifyChatToken,
  verifyRevocation,
  verifyWorkspaceToken,
  type WorkspaceTokenError,
} from "../packages/integrations/src/workspace-token.ts";

const keys = generateWorkspaceKeys();
const who = { sub: "acct_1", email: "ada@example.com", name: "Ada", role: "admin" as const };
const reason = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as WorkspaceTokenError).reason;
  }
  return "accepted";
};

test("a chat token names the person, the role, when it was made and the plan's limits", () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const token = signChatToken(keys.privateKey, {
    ...who,
    workspaceId: "w1",
    now,
    limits: { maxFileBytes: 25 * 2 ** 20, storageBytes: 10 * 2 ** 30 },
  });
  const claims = verifyChatToken(keys.publicKey, token, { workspaceId: "w1", now: now + 1000 });
  assert.deepEqual([claims.sub, claims.email, claims.role], ["acct_1", "ada@example.com", "admin"]);
  assert.equal(claims.issuedAt, Math.floor(now / 1000) * 1000);
  assert.deepEqual(claims.limits, { maxFileBytes: 25 * 2 ** 20, storageBytes: 10 * 2 ** 30 });
  // Without limits there are none to carry.
  const plain = signChatToken(keys.privateKey, { ...who, workspaceId: "w1", now });
  assert.equal(
    verifyChatToken(keys.publicKey, plain, { workspaceId: "w1", now }).limits,
    undefined,
  );
});

test("a chat token is reusable until it expires, and no longer", () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const token = signChatToken(keys.privateKey, { ...who, workspaceId: "w1", now });
  for (const later of [1_000, 60_000, 9 * 60_000])
    assert.doesNotThrow(() =>
      verifyChatToken(keys.publicKey, token, { workspaceId: "w1", now: now + later }),
    );
  assert.equal(
    reason(() =>
      verifyChatToken(keys.publicKey, token, { workspaceId: "w1", now: now + 11 * 60_000 }),
    ),
    "expired",
  );
});

test("each kind of token is good for one thing only", () => {
  const sign = (purpose: "sign-in" | "chat") =>
    purpose === "chat"
      ? signChatToken(keys.privateKey, { ...who, workspaceId: "w1" })
      : signWorkspaceToken(keys.privateKey, { ...who, workspaceId: "w1" });
  // A sign-in token is not a chat token, and a chat token does not sign in to the workspace server.
  assert.equal(
    reason(() => verifyChatToken(keys.publicKey, sign("sign-in"), { workspaceId: "w1" })),
    "audience",
  );
  assert.equal(
    reason(() => verifyWorkspaceToken(keys.publicKey, sign("chat"), { workspaceId: "w1" })),
    "audience",
  );
  // Another workspace's chat is not this one's.
  assert.equal(
    reason(() => verifyChatToken(keys.publicKey, sign("chat"), { workspaceId: "w2" })),
    "audience",
  );
  // Another key does not sign for us.
  const other = generateWorkspaceKeys();
  assert.equal(
    reason(() => verifyChatToken(other.publicKey, sign("chat"), { workspaceId: "w1" })),
    "signature",
  );
  // The workspace server's revocation is not the chat service's, and neither is a purge.
  const serverRevoke = signRevocation(keys.privateKey, { workspaceId: "w1", sub: "acct_1" });
  const chatRevoke = signChatRevocation(keys.privateKey, { workspaceId: "w1", sub: "acct_1" });
  const purge = signChatPurge(keys.privateKey, { workspaceId: "w1" });
  assert.equal(
    reason(() => verifyChatRevocation(keys.publicKey, serverRevoke, { workspaceId: "w1" })),
    "audience",
  );
  assert.equal(
    reason(() => verifyRevocation(keys.publicKey, chatRevoke, { workspaceId: "w1" })),
    "audience",
  );
  assert.equal(
    reason(() => verifyChatToken(keys.publicKey, chatRevoke, { workspaceId: "w1" })),
    "audience",
  );
  assert.equal(
    reason(() => verifyChatToken(keys.publicKey, purge, { workspaceId: "w1" })),
    "audience",
  );
  assert.equal(
    reason(() => verifyChatPurge(keys.publicKey, chatRevoke, { workspaceId: "w1" })),
    "audience",
  );
});

test("a revocation says whose access to end and when the token was made", () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const token = signChatRevocation(keys.privateKey, { workspaceId: "w1", sub: "acct_9", now });
  assert.deepEqual(verifyChatRevocation(keys.publicKey, token, { workspaceId: "w1", now }), {
    sub: "acct_9",
    issuedAt: Math.floor(now / 1000) * 1000,
  });
  const purge = signChatPurge(keys.privateKey, { workspaceId: "w1", now });
  assert.doesNotThrow(() => verifyChatPurge(keys.publicKey, purge, { workspaceId: "w1", now }));
});
