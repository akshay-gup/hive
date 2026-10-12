import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  base64Url,
  challengeFor,
  newSignInProof,
  sha256,
  signInAttempts,
} from "../src/sign-in-proof.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("sha256 matches the published vectors", () => {
  assert.equal(
    hex(sha256(new Uint8Array())),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    hex(sha256(Buffer.from("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    hex(sha256(Buffer.from("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256 matches node for every length across the block boundaries", () => {
  for (let length = 0; length <= 200; length++) {
    const data = randomBytes(length);
    assert.equal(hex(sha256(data)), createHash("sha256").update(data).digest("hex"), `${length}`);
  }
  const large = randomBytes(100_000);
  assert.equal(hex(sha256(large)), createHash("sha256").update(large).digest("hex"));
});

test("base64Url matches node's unpadded base64url", () => {
  for (let length = 0; length <= 40; length++) {
    const data = randomBytes(length);
    assert.equal(base64Url(data), data.toString("base64url"), `${length}`);
  }
});

test("a proof's challenge is what the server computes", () => {
  for (let i = 0; i < 20; i++) {
    const { proof, challenge } = newSignInProof();
    assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash("sha256").update(proof).digest("base64url"));
    assert.equal(challengeFor(proof), challenge);
  }
});

test("proofs are not repeated", () => {
  const proofs = new Set(Array.from({ length: 50 }, () => newSignInProof().proof));
  assert.equal(proofs.size, 50);
});

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
}

test("an attempt keeps its proof for the workspace it began in, and is used once", async () => {
  const store = memoryStore();
  const attempts = signInAttempts(store, () => "https://team.example.com");
  const { challenge } = await attempts.begin();
  const [stored] = [...store.values.values()];
  assert.equal(challengeFor(JSON.parse(stored).proof), challenge);
  const taken = await attempts.take();
  assert.equal(taken?.workspace, "https://team.example.com");
  assert.equal(challengeFor(taken?.proof ?? ""), challenge);
  assert.equal(await attempts.take(), null);
});

test("a login code with no attempt behind it has nothing to be spent with", async () => {
  const attempts = signInAttempts(memoryStore(), () => "https://team.example.com");
  assert.equal(await attempts.take(), null);
});

test("starting again replaces the earlier attempt", async () => {
  const attempts = signInAttempts(memoryStore(), () => "https://team.example.com");
  const first = await attempts.begin();
  const second = await attempts.begin();
  assert.notEqual(first.challenge, second.challenge);
  const taken = await attempts.take();
  assert.equal(challengeFor(taken?.proof ?? ""), second.challenge);
});

test("an attempt runs out after the ten minutes the server allows", async () => {
  let clock = 1_000_000;
  const attempts = signInAttempts(
    memoryStore(),
    () => "https://team.example.com",
    () => clock,
  );
  await attempts.begin();
  clock += 10 * 60 * 1000;
  assert.ok(await attempts.take(), "still good at ten minutes");
  await attempts.begin();
  clock += 10 * 60 * 1000 + 1;
  assert.equal(await attempts.take(), null);
});

test("a cancelled or damaged attempt gives nothing", async () => {
  const store = memoryStore();
  const attempts = signInAttempts(store, () => "https://team.example.com");
  await attempts.begin();
  await attempts.cancel();
  assert.equal(await attempts.take(), null);
  for (const damaged of ["not json", "{}", '{"proof":1,"workspace":"x","startedAt":1}', "null"]) {
    store.values.set("hive:sign-in", damaged);
    assert.equal(await attempts.take(), null, damaged);
  }
});
