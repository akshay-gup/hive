import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import { AppError } from "../packages/chat-core/src/errors.ts";

const config = { mode: "sample", publicUrl: "http://localhost:8787" } as Config;
const auth = new Auth({} as Store, config, "test-signing-key");
const other = new Auth({} as Store, config, "another-signing-key");

const refused = (token: string, status: number, by = auth) =>
  assert.throws(
    () => by.verifyToken(token),
    (error) => error instanceof AppError && error.status === status,
  );

test("a token names who it is for and what it is good for", () => {
  const token = auth.signToken("google:1042", "general\nreports/2026 plan");
  assert.match(token, /^\d+\.[\w-]+\.[\w-]+\.[\w-]{43}$/);
  assert.deepEqual(auth.verifyToken(token), {
    owner: "google:1042",
    subject: "general\nreports/2026 plan",
  });
  // An empty subject is allowed: it just names nothing in particular.
  assert.equal(auth.verifyToken(auth.signToken("local-user", "")).subject, "");
});

test("a token cannot be changed, moved to another owner or scope, or made by someone else", () => {
  const [expires, owner, subject, signature] = auth
    .signToken("local-user", "general\na.txt")
    .split(".");
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  refused([expires, encode("someone-else"), subject, signature].join("."), 403);
  refused([expires, owner, encode("general\nb.txt"), signature].join("."), 403);
  refused([String(Number(expires) + 60000), owner, subject, signature].join("."), 403);
  refused(
    [
      expires,
      owner,
      subject,
      `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
    ].join("."),
    403,
  );
  refused(auth.signToken("local-user", "general\na.txt"), 403, other);
});

test("a token that is old or malformed is refused with a message that says to refresh", () => {
  const token = auth.signToken("local-user", "x");
  const real = Date.now;
  Date.now = () => real() + 16 * 60 * 1000;
  try {
    refused(token, 401);
  } finally {
    Date.now = real;
  }
  for (const bad of [
    "",
    "abc",
    "1.2.3",
    "1.2.3.4.5",
    "x.y.z.w",
    "12.a b.c.d",
    `${"9".repeat(13)}..x.${"A".repeat(43)}`,
  ])
    refused(bad, 401);
  // A link signed for a path is not a token, and a token is not a path signature.
  refused(auth.sign("local-user", "/api/files/1/content"), 401);
});
