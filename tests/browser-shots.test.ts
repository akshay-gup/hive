import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserService } from "../apps/server/src/browser.ts";
import { createStore } from "../apps/server/src/db.ts";

test("a picture of a page that was read is kept, and is only its owner's", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hive-shots-"));
  const db = await createStore();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(png)) as typeof fetch;
  try {
    const service = new BrowserService(
      db,
      { dataDir, workerUrl: "http://worker.test", workerToken: "t" } as never,
      {} as never,
      {} as never,
    );
    const name = await service.saveShot("alice", "session-1");
    assert.ok(name, "a name comes back");
    assert.deepEqual(await service.shot("alice", name ?? ""), png);
    await assert.rejects(service.shot("bob", name ?? ""), /not found/);
    await assert.rejects(service.shot("alice", "../../etc/passwd"), /not found/);
  } finally {
    globalThis.fetch = realFetch;
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a picture that cannot be taken is no reason to fail the step", async () => {
  const db = await createStore();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("worker is gone");
  }) as typeof fetch;
  try {
    const service = new BrowserService(
      db,
      { dataDir: tmpdir(), workerUrl: "http://worker.test", workerToken: "t" } as never,
      {} as never,
      {} as never,
    );
    assert.equal(await service.saveShot("alice", "session-1"), undefined);
  } finally {
    globalThis.fetch = realFetch;
    await db.close();
  }
});
