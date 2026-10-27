import assert from "node:assert/strict";
import { test } from "node:test";
import { DeletedMarker, KEEP_DELETED_MS } from "../apps/chat/src/deleted-marker.ts";

const storage = () => {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    kv,
    alarm: () => alarm,
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void kv.set(key, value),
    deleteAll: async () => void kv.clear(),
    setAlarm: async (at: number | Date) => {
      alarm = Number(at);
    },
  };
};

test("a deleted room is wiped, keeps one marker, and asks to be woken when the marker is done", async () => {
  const s = storage();
  s.kv.set("messages", "secret");
  let now = 1_000;
  const marker = new DeletedMarker(s, () => now);
  assert.equal(await marker.deleted(), false);
  assert.equal(await marker.upkeep(), false);
  await marker.wipe();
  assert.equal(await marker.deleted(), true);
  assert.deepEqual([...s.kv.keys()], ["deleted-at"]);
  assert.equal(s.alarm(), 1_000 + KEEP_DELETED_MS);
  // A second delete does not start the clock again.
  now = 50_000;
  await marker.wipe();
  assert.equal(s.alarm(), 1_000 + KEEP_DELETED_MS);
});

test("the marker stays until its time is up, then goes and leaves nothing", async () => {
  const s = storage();
  let now = 0;
  const marker = new DeletedMarker(s, () => now);
  await marker.wipe();
  now = KEEP_DELETED_MS - 1;
  assert.equal(await marker.upkeep(), true);
  assert.equal(await marker.deleted(), true);
  assert.equal(s.alarm(), KEEP_DELETED_MS);
  now = KEEP_DELETED_MS;
  assert.equal(await marker.upkeep(), true);
  assert.equal(await marker.deleted(), false);
  assert.equal(s.kv.size, 0);
});
