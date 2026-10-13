import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";

/** Just the records a sign-in touches, so these tests need no database. */
function memoryStore() {
  const records = new Map<string, { id: string }>();
  const store = {
    async put(owner: string, kind: string, value: { id: string }) {
      records.set(`${owner}/${kind}/${value.id}`, value);
    },
    async get(owner: string, kind: string, id: string) {
      return records.get(`${owner}/${kind}/${id}`) ?? null;
    },
    async take(owner: string, kind: string, id: string) {
      const key = `${owner}/${kind}/${id}`;
      const value = records.get(key) ?? null;
      records.delete(key);
      return value;
    },
  };
  return { store: store as unknown as Store, records };
}

function config(): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://team.example.com",
    dataDir: "unused",
    allowedOrigins: [],
    googleRedirectUri: "https://team.example.com/api/google/callback",
    googleClientId: "synthetic-client",
    googleClientSecret: "synthetic-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  } as Config;
}

function proofAndChallenge() {
  const proof = randomBytes(32).toString("base64url");
  return { proof, challenge: createHash("sha256").update(proof).digest("base64url") };
}

function loginState(records: Map<string, { id: string }>) {
  const [state] = [...records.entries()].filter(([key]) => key.startsWith("system/oauth/"));
  assert.ok(state, "a pending sign-in was saved");
  return state[1] as { origin?: string; challenge?: string };
}

test("a sign-in needs a web origin or an app challenge", async () => {
  const { store } = memoryStore();
  const google = new GoogleAuth(store, config());
  await assert.rejects(() => google.loginUrl(), { status: 400 });
  await assert.rejects(() => google.loginUrl(undefined, undefined), { status: 400 });
});

test("a malformed challenge is refused", async () => {
  const { store } = memoryStore();
  const google = new GoogleAuth(store, config());
  for (const challenge of ["short", "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}!`])
    await assert.rejects(() => google.loginUrl(undefined, challenge), { status: 400 });
});

test("the challenge is kept with the pending sign-in", async () => {
  const { store, records } = memoryStore();
  const google = new GoogleAuth(store, config());
  const { challenge } = proofAndChallenge();
  const { url } = await google.loginUrl(undefined, challenge);
  assert.ok(url.startsWith("https://accounts.google.com/"));
  assert.equal(loginState(records).challenge, challenge);
  assert.equal(loginState(records).origin, undefined);
});

test("only the holder of the proof can exchange the code", async () => {
  const { store } = memoryStore();
  const google = new GoogleAuth(store, config());
  const { proof, challenge } = proofAndChallenge();
  const code = await google.mintLoginCode("session-token", "live", challenge);
  assert.deepEqual(await google.exchangeLoginCode(code, proof), {
    token: "session-token",
    mode: "live",
  });
  await assert.rejects(() => google.exchangeLoginCode(code, proof), { status: 400 });
});

test("a wrong or missing proof is refused and spends the code", async () => {
  const { store } = memoryStore();
  const google = new GoogleAuth(store, config());
  const { proof, challenge } = proofAndChallenge();
  for (const attempt of [undefined, "", "not-the-proof", proofAndChallenge().proof]) {
    const code = await google.mintLoginCode("session-token", "live", challenge);
    await assert.rejects(() => google.exchangeLoginCode(code, attempt), { status: 400 });
    await assert.rejects(() => google.exchangeLoginCode(code, proof), { status: 400 });
  }
});

test("a code from a web popup still exchanges without a proof, once", async () => {
  const { store } = memoryStore();
  const google = new GoogleAuth(store, config());
  const code = await google.mintLoginCode("session-token", "sample");
  assert.deepEqual(await google.exchangeLoginCode(code), {
    token: "session-token",
    mode: "sample",
  });
  await assert.rejects(() => google.exchangeLoginCode(code), { status: 400 });
});

test("an unknown or expired code is refused", async () => {
  const { store, records } = memoryStore();
  const google = new GoogleAuth(store, config());
  await assert.rejects(() => google.exchangeLoginCode("nope", "whatever"), { status: 400 });
  const code = await google.mintLoginCode("session-token", "live");
  const record = records.get(`system/oauth/${code}`) as unknown as { expiresAt: number };
  record.expiresAt = Date.now() - 1;
  await assert.rejects(() => google.exchangeLoginCode(code), { status: 400 });
});
