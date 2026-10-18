import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  forgetLastCounts,
  MAX_PLACEHOLDERS,
  readLastCount,
  writeLastCount,
} from "../src/last-count.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}
beforeEach(() => forgetLastCounts());

test("a list nobody has seen holds no room", () => {
  assert.equal(readLastCount("channels:w1", memoryStore()), 0);
});

test("what a list had last time is what it holds room for, from storage after a reload", () => {
  const store = memoryStore();
  writeLastCount("channels:w1", 3, store);
  forgetLastCounts(); // the app was reloaded: only the storage is left
  assert.equal(readLastCount("channels:w1", store), 3);
  assert.equal(readLastCount("channels:w2", store), 0, "another list has its own");
});

test("room is held for no more than a few rows, and never for a bad number", () => {
  const store = memoryStore();
  writeLastCount("a", 40, store);
  forgetLastCounts();
  assert.equal(readLastCount("a", store), MAX_PLACEHOLDERS);
  for (const bad of ["", "abc", "-3", "NaN"])
    assert.equal(readLastCount("b", memoryStore({ "hive.lastCount.b": bad })), 0, bad);
});

test("with no storage, or storage that refuses, the count lasts while the app is open", () => {
  writeLastCount("c", 2, undefined);
  assert.equal(readLastCount("c", undefined), 2);
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  writeLastCount("d", 4, refusing);
  assert.equal(readLastCount("d", refusing), 4);
  forgetLastCounts();
  assert.equal(readLastCount("d", refusing), 0);
});
