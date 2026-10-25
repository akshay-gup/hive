import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Files, HARD_MAX_FILE_BYTES, UPLOAD_MINUTES } from "../packages/chat-core/src/files.ts";
import { memorySql } from "./helpers/do-shim.ts";

const MB = 1024 ** 2;
let files: Files;
let clock: number;
let sql: ReturnType<typeof memorySql>;

beforeEach(() => {
  clock = Date.UTC(2026, 9, 25, 12);
  sql = memorySql();
  files = new Files(
    sql,
    () => new Date(clock).toISOString(),
    () => clock,
  );
  files.setLimits({ maxFileBytes: 25 * MB, storageBytes: 100 * MB }, 1);
});

const reserve = (
  bytes: number,
  extra: { thumbBytes?: number; uploaderId?: string; channelId?: string } = {},
) =>
  files.reserve({
    channelId: extra.channelId ?? "c1",
    uploaderId: extra.uploaderId ?? "u1",
    name: "report.pdf",
    mime: "application/pdf",
    bytes,
    thumbBytes: extra.thumbBytes,
  });
/** The account of bytes always comes to what the files add up to. */
const consistent = () => assert.deepEqual(files.reconcile().drifted, false);

test("a file is set aside, then ready once its bytes are there, and counted as used", () => {
  const file = reserve(10 * MB);
  assert.equal(file.state, "pending");
  assert.deepEqual([files.usage().bytesReserved, files.usage().bytesUsed], [10 * MB, 0]);
  const done = files.complete(file.id, 9 * MB);
  assert.deepEqual([done.state, done.bytes], ["ready", 9 * MB], "what arrived is what counts");
  assert.deepEqual(
    [files.usage().bytesReserved, files.usage().bytesUsed, files.usage().files],
    [0, 9 * MB, 1],
  );
  consistent();
});

test("a file over what one file may be is refused, saying what the limit is", () => {
  assert.throws(
    () => reserve(26 * MB),
    (e: Error) => /up to 25 MB.*26 MB/.test(e.message),
  );
  assert.throws(() => reserve(0), /empty/);
  // The plan never lifts it past what a single upload can carry.
  files.setLimits({ maxFileBytes: 500 * MB, storageBytes: 10_000 * MB }, 2);
  assert.throws(() => reserve(HARD_MAX_FILE_BYTES + 1), /up to 100 MB/);
  assert.doesNotThrow(() => reserve(HARD_MAX_FILE_BYTES));
});

test("the workspace's allowance holds, counting what is on its way", () => {
  for (let i = 0; i < 4; i++) files.complete(reserve(25 * MB).id, 25 * MB);
  assert.equal(files.usage().bytesUsed, 100 * MB);
  assert.throws(
    () => reserve(1 * MB),
    (e: Error) => /0 MB of file storage left/.test(e.message),
  );
  // Freeing space frees room; what is only set aside counts as taken.
  const first = files.inChannel("c1")[0];
  assert.ok(first);
  files.remove(first.id);
  const pending = reserve(20 * MB);
  assert.throws(() => reserve(10 * MB), /5 MB of file storage left/);
  assert.equal(files.usage().bytesReserved, 20 * MB);
  files.complete(pending.id, 20 * MB);
  consistent();
});

test("more bytes than were said throws the file away and gives the room back", () => {
  const file = reserve(5 * MB);
  assert.throws(() => files.complete(file.id, 6 * MB), /bigger than it was said/);
  assert.equal(files.get(file.id), null);
  assert.deepEqual([files.usage().bytesReserved, files.usage().bytesUsed], [0, 0]);
  assert.deepEqual(
    files.pendingDeletes(),
    [`f/${file.id}`],
    "and the bucket is told to let go of it",
  );
  // It cannot be finished twice, or finished once it is gone.
  assert.throws(() => files.complete(file.id, 1), /not open/);
  const ok = reserve(1 * MB);
  files.complete(ok.id, 1 * MB);
  assert.throws(() => files.complete(ok.id, 1 * MB), /not open/);
  consistent();
});

test("a smaller picture is counted when it arrives, and the file stands without one that never does", () => {
  const withPicture = reserve(4 * MB, { thumbBytes: 100_000 });
  assert.equal(files.usage().bytesReserved, 4 * MB + 100_000);
  files.complete(withPicture.id, 4 * MB);
  assert.deepEqual([files.usage().bytesReserved, files.usage().bytesUsed], [100_000, 4 * MB]);
  const done = files.completeThumb(withPicture.id, 80_000);
  assert.equal(done.thumbReady, true);
  assert.deepEqual([files.usage().bytesReserved, files.usage().bytesUsed], [0, 4 * MB + 80_000]);
  consistent();
  // One whose picture never came gives back the room set aside for it, once the time is up.
  const lonely = reserve(1 * MB, { thumbBytes: 50_000 });
  files.complete(lonely.id, 1 * MB);
  clock += (UPLOAD_MINUTES + 1) * 60_000;
  assert.equal(files.expire(), 1);
  assert.equal(files.get(lonely.id)?.thumbKey, null);
  assert.equal(files.usage().bytesReserved, 0);
  consistent();
  // And removing a file takes its picture and room with it.
  files.remove(withPicture.id);
  assert.equal(files.usage().bytesUsed, 1 * MB);
  assert.ok(files.pendingDeletes().includes(`f/${withPicture.id}.thumb`));
  consistent();
});

test("an upload that is never finished gives its room back, and what is deleted is handed on in order", () => {
  const stale = reserve(10 * MB);
  const live = reserve(5 * MB);
  clock += (UPLOAD_MINUTES - 1) * 60_000;
  assert.equal(files.expire(), 0, "still in time");
  clock += 2 * 60_000;
  files.complete(live.id, 5 * MB);
  assert.equal(files.expire(), 1);
  assert.equal(files.get(stale.id), null);
  assert.deepEqual(files.pendingDeletes(), [`f/${stale.id}`]);
  files.deleted([`f/${stale.id}`]);
  assert.deepEqual(files.pendingDeletes(), []);
  assert.equal(files.hasWork(), false);
  consistent();
});

test("files go on a message only if they are the sender's, ready, in the channel, and not already sent", () => {
  const mine = reserve(1 * MB);
  files.complete(mine.id, 1 * MB);
  const notYet = reserve(1 * MB);
  const theirs = reserve(1 * MB, { uploaderId: "u2" });
  files.complete(theirs.id, 1 * MB);
  const elsewhere = reserve(1 * MB, { channelId: "c2" });
  files.complete(elsewhere.id, 1 * MB);
  for (const id of [notYet.id, theirs.id, elsewhere.id, "nope"])
    assert.throws(() => files.attach([id], "m1", "c1", "u1"), /cannot be sent/, id);
  files.attach([mine.id], "m1", "c1", "u1");
  assert.throws(() => files.attach([mine.id], "m2", "c1", "u1"), /cannot be sent/);
  assert.deepEqual(
    files
      .ofMessages(["m1"])
      .get("m1")
      ?.map((f) => f.id),
    [mine.id],
  );
  assert.equal(files.ofMessages(["m2"]).size, 0, "a file that is not ready is not shown");
});

test("deleting a message or a channel gives back the bytes of its files", () => {
  const a = reserve(3 * MB);
  files.complete(a.id, 3 * MB);
  const b = reserve(2 * MB);
  files.complete(b.id, 2 * MB);
  const c = reserve(4 * MB, { channelId: "c2" });
  files.complete(c.id, 4 * MB);
  files.attach([a.id, b.id], "m1", "c1", "u1");
  assert.equal(files.removeOfMessage("m1"), 2);
  assert.equal(files.usage().bytesUsed, 4 * MB);
  assert.equal(files.removeOfChannel("c2"), 1);
  assert.deepEqual([files.usage().bytesUsed, files.usage().files], [0, 0]);
  assert.equal(files.pendingDeletes().length, 3);
  consistent();
});

test("a plan's numbers are taken from a newer token and not an older one", () => {
  files.setLimits({ maxFileBytes: 10 * MB, storageBytes: 50 * MB }, 5);
  assert.deepEqual([files.usage().maxFileBytes, files.usage().storageBytes], [10 * MB, 50 * MB]);
  files.setLimits({ maxFileBytes: 99 * MB, storageBytes: 99 * MB }, 3);
  assert.equal(files.usage().maxFileBytes, 10 * MB, "an older token cannot undo it");
  files.setLimits({ maxFileBytes: 20 * MB, storageBytes: 60 * MB }, 6);
  assert.equal(files.usage().storageBytes, 60 * MB);
  // A workspace over a smaller allowance keeps what it has and cannot add more.
  files.complete(reserve(10 * MB).id, 10 * MB);
  files.setLimits({ maxFileBytes: 20 * MB, storageBytes: 5 * MB }, 7);
  assert.throws(() => reserve(1 * MB), /storage left/);
  assert.equal(files.usage().bytesUsed, 10 * MB);
});

test("names are only names", () => {
  const made = (name: string) =>
    files.reserve({ channelId: "c", uploaderId: "u", name, mime: "x/y", bytes: 1 }).name;
  assert.equal(made("../../etc/passwd"), "passwd");
  assert.equal(made("C:\\Users\\me\\a.txt"), "a.txt");
  assert.equal(made("  nice\u0000name\n.txt "), "nicename.txt");
  assert.equal(made(".."), "file");
  assert.equal(made(""), "file");
  assert.equal(made("x".repeat(500)).length, 200);
});

test("the running total can be put right if it has drifted", () => {
  files.complete(reserve(2 * MB).id, 2 * MB);
  sql.run("UPDATE usage SET bytes_used = 999, files = 7 WHERE id = 1");
  const result = files.reconcile();
  assert.equal(result.drifted, true);
  assert.deepEqual([files.usage().bytesUsed, files.usage().files], [2 * MB, 1]);
  assert.equal(files.reconcile().drifted, false);
});
