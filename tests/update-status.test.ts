import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readUpdateStatus } from "../apps/server/src/update-status.ts";

test("the health answer can say how the last update went and what the updater said", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-status-"));
  try {
    await writeFile(
      join(dir, "last-update.json"),
      '{"state":"failed","version":"sha-a","message":"could not fetch the image","at":"2026-10-21T07:00:00Z"}',
    );
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(join(dir, "update.log"), `${lines}\n`);
    const status = await readUpdateStatus(dir);
    assert.equal(status?.state, "failed");
    assert.equal(status?.message, "could not fetch the image");
    assert.equal(status?.log?.length, 12);
    assert.equal(status?.log?.at(-1), "line 29");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a machine with no updater folder has nothing to say, and a broken record does not break it", async () => {
  assert.equal(await readUpdateStatus("/nonexistent-hive-dir"), undefined);
  const dir = await mkdtemp(join(tmpdir(), "hive-status-"));
  try {
    await writeFile(join(dir, "last-update.json"), "{half");
    await writeFile(join(dir, "update.log"), "one line\n");
    assert.deepEqual(await readUpdateStatus(dir), { log: ["one line"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the health answer says how the last change to the settings went", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-status-"));
  try {
    await writeFile(
      join(dir, "last-config.json"),
      '{"state":"failed","rev":"abc","message":"did not come up","at":"2026-10-24T07:00:00Z"}',
    );
    assert.deepEqual((await readUpdateStatus(dir))?.config, {
      state: "failed",
      rev: "abc",
      message: "did not come up",
      at: "2026-10-24T07:00:00Z",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
