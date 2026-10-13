import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store;
let directory: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-login-origin-"));
  db = await createStore();
  ({ app } = await createApp(db, {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://hive.example.test",
    dataDir: directory,
    encryptionKey: randomBytes(32).toString("base64"),
    googleClientId: "client-id.apps.test",
    googleClientSecret: "client-secret",
    googleRedirectUri: "https://hive.example.test/api/google/callback",
    allowedOrigins: ["https://app.example.test"],
  }));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const url = (origin?: string, challenge?: string) => {
  const query = new URLSearchParams();
  if (origin) query.set("origin", origin);
  if (challenge) query.set("challenge", challenge);
  return app.request(`/api/auth/google/url${query.size ? `?${query}` : ""}`);
};
// What an app sends: the base64url SHA-256 of a proof it keeps.
const challenge = "A".repeat(43);

test("only a page of this server's own can be handed a Google sign-in", async () => {
  // The page that opened the sign-in is told its result, so any other would collect people's login codes.
  for (const origin of ["https://evil.test", "http://hive.example.test", "null"])
    assert.equal((await url(origin)).status, 403, origin);

  for (const origin of ["https://hive.example.test", "https://app.example.test"]) {
    const response = await url(origin);
    assert.equal(response.status, 200, String(origin));
    assert.match((await response.json()).url, /^https:\/\/accounts\.google\.com\//);
  }
});

test("an app starts a sign-in with the challenge for a proof it keeps, and a start with neither is refused", async () => {
  // Without a challenge the code would come back through a link any app on the phone could take.
  const response = await url(undefined, challenge);
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /^https:\/\/accounts\.google\.com\//);
  assert.equal((await url()).status, 400);
  assert.equal((await url(undefined, "too-short")).status, 400);
  assert.equal(
    (await url("https://evil.test", challenge)).status,
    403,
    "the origin is still checked",
  );
});
