import assert from "node:assert/strict";
import { test } from "node:test";
import { D1Store } from "../apps/control/src/d1-store.ts";
import { memoryD1 } from "./helpers/d1-shim.ts";

/** A store whose clock moves on by a millisecond each time it is asked, so order is the order of writes. */
function store() {
  let clock = 1_000;
  return new D1Store(memoryD1(), () => clock++);
}
interface Thing {
  id: string;
  name?: string;
  owner?: string;
  status?: string;
  uses?: number;
  open?: boolean;
  error?: string | null;
}

test("a record is kept, replaced, read back and removed", async () => {
  const db = store();
  assert.equal(await db.get("o", "things", "a"), null);
  await db.put<Thing>("o", "things", { id: "a", name: "first" });
  assert.deepEqual(await db.get("o", "things", "a"), { id: "a", name: "first" });
  await db.put<Thing>("o", "things", { id: "a", name: "second" });
  assert.deepEqual(await db.get("o", "things", "a"), { id: "a", name: "second" });
  await db.remove("o", "things", "a");
  assert.equal(await db.get("o", "things", "a"), null);
  await db.remove("o", "things", "a"); // removing what is gone is not an error
});

test("records are filed by owner and by kind", async () => {
  const db = store();
  await db.put<Thing>("one", "things", { id: "a", name: "one's" });
  await db.put<Thing>("two", "things", { id: "a", name: "two's" });
  await db.put<Thing>("one", "other", { id: "a", name: "other kind" });
  assert.equal(((await db.get("one", "things", "a")) as Thing).name, "one's");
  assert.equal(((await db.get("two", "things", "a")) as Thing).name, "two's");
  assert.equal(((await db.get("one", "other", "a")) as Thing).name, "other kind");
});

test("insertIfAbsent adds a record once and leaves an existing one alone", async () => {
  const db = store();
  const first = await db.insertIfAbsent<Thing>("o", "things", { id: "a", name: "first" });
  assert.deepEqual(first, { id: "a", name: "first" });
  assert.equal(await db.insertIfAbsent<Thing>("o", "things", { id: "a", name: "second" }), null);
  assert.equal(((await db.get("o", "things", "a")) as Thing).name, "first");
});

test("take hands a record to one caller only", async () => {
  const db = store();
  await db.put<Thing>("o", "codes", { id: "c", name: "once" });
  assert.deepEqual(await db.take("o", "codes", "c"), { id: "c", name: "once" });
  assert.equal(await db.take("o", "codes", "c"), null);
  assert.equal(await db.get("o", "codes", "c"), null);
});

test("list returns a kind under an owner, newest change first", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a" });
  await db.put<Thing>("o", "things", { id: "b" });
  await db.put<Thing>("p", "things", { id: "c" });
  await db.put<Thing>("o", "other", { id: "d" });
  assert.deepEqual(
    (await db.list<Thing>("o", "things")).map((thing) => thing.id),
    ["b", "a"],
  );
  assert.deepEqual(await db.list("o", "nothing"), []);
});

test("listWhere finds records by a text field, newest change first", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a", owner: "ada" });
  await db.put<Thing>("o", "things", { id: "b", owner: "bo" });
  await db.put<Thing>("o", "things", { id: "c", owner: "ada" });
  await db.put<Thing>("p", "things", { id: "d", owner: "ada" });
  await db.put<Thing>("o", "other", { id: "e", owner: "ada" });
  const found = await db.listWhere<Thing>("o", "things", "owner", "ada");
  assert.deepEqual(
    found.map((thing) => thing.id),
    ["c", "a"],
  );
  await db.put<Thing>("o", "things", { id: "a", owner: "ada" }); // changed last, so first
  assert.deepEqual(
    (await db.listWhere<Thing>("o", "things", "owner", "ada")).map((thing) => thing.id),
    ["a", "c"],
  );
  assert.deepEqual(await db.listWhere("o", "things", "owner", "nobody"), []);
});

test("listWhere does not let a field name become SQL", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a", owner: "ada" });
  for (const field of ["x') OR 1=1 --", "a.b", "a b", "", "$.x", "x'"])
    await assert.rejects(() => db.listWhere("o", "things", field, "ada"), /Not a field name/);
});

test("compareAndSwap changes a record only while it still looks as it was read", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a", status: "failed", uses: 0, name: "kept" });
  const moved = await db.compareAndSwap<Thing>(
    "o",
    "things",
    "a",
    { status: "failed" },
    { status: "provisioning" },
  );
  assert.deepEqual(moved, { id: "a", status: "provisioning", uses: 0, name: "kept" });
  assert.equal(
    await db.compareAndSwap("o", "things", "a", { status: "failed" }, { status: "ready" }),
    null,
  );
  assert.equal(((await db.get("o", "things", "a")) as Thing).status, "provisioning");
});

test("of two callers who read the same record, only the first compareAndSwap wins", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a", uses: 4 });
  const results = await Promise.all([
    db.compareAndSwap<Thing>("o", "things", "a", { uses: 4 }, { uses: 5 }),
    db.compareAndSwap<Thing>("o", "things", "a", { uses: 4 }, { uses: 5 }),
    db.compareAndSwap<Thing>("o", "things", "a", { uses: 4 }, { uses: 5 }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(((await db.get("o", "things", "a")) as Thing).uses, 5);
});

test("compareAndSwap with nothing expected always applies, to a record that exists", async () => {
  const db = store();
  assert.equal(await db.compareAndSwap("o", "things", "gone", {}, { name: "x" }), null);
  await db.put<Thing>("o", "things", { id: "a", name: "before" });
  assert.equal(
    ((await db.compareAndSwap<Thing>("o", "things", "a", {}, { name: "after" })) as Thing).name,
    "after",
  );
});

test("compareAndSwap compares numbers, booleans and null", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a", uses: 0, open: true, error: null });
  assert.ok(await db.compareAndSwap("o", "things", "a", { uses: 0, open: true }, { uses: 1 }));
  assert.equal(await db.compareAndSwap("o", "things", "a", { open: false }, { uses: 2 }), null);
  assert.equal(await db.compareAndSwap("o", "things", "a", { uses: 0 }, { uses: 2 }), null);
  assert.ok(await db.compareAndSwap("o", "things", "a", { error: null }, { open: false }));
  assert.equal(((await db.get("o", "things", "a")) as Thing).open, false);
});

test("compareAndSwap takes only plain values to compare", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a" });
  await assert.rejects(
    () => db.compareAndSwap("o", "things", "a", { list: [1] }, { uses: 1 }),
    /plain values/,
  );
  await assert.rejects(
    () => db.compareAndSwap("o", "things", "a", { "x') OR 1=1 --": 1 }, { uses: 1 }),
    /Not a field name/,
  );
});

test("a patched field set to null goes away", async () => {
  const db = store();
  await db.put<Thing>("o", "things", { id: "a", error: "it broke", status: "failed" });
  const retried = await db.compareAndSwap<Thing>(
    "o",
    "things",
    "a",
    { status: "failed" },
    { status: "provisioning", error: null },
  );
  assert.equal(retried?.status, "provisioning");
  assert.ok(!retried?.error);
});

test("scan lists a kind with its owners, oldest change first", async () => {
  const db = store();
  await db.put<Thing>("one", "things", { id: "a" });
  await db.put<Thing>("two", "things", { id: "b" });
  await db.put<Thing>("one", "other", { id: "c" });
  await db.put<Thing>("one", "things", { id: "a", name: "changed" });
  assert.deepEqual(await db.scan<Thing>("things"), [
    { owner: "two", value: { id: "b" } },
    { owner: "one", value: { id: "a", name: "changed" } },
  ]);
  assert.deepEqual(await db.scan("nothing"), []);
});

test("text with quotes, unicode and a lone surrogate-free emoji survives", async () => {
  const db = store();
  const name = `O'Brien "the" \\ café 🐹 \n tab\t`;
  await db.put<Thing>("o", "things", { id: "a", name });
  assert.equal(((await db.get("o", "things", "a")) as Thing).name, name);
  assert.equal(((await db.listWhere<Thing>("o", "things", "name", name))[0] as Thing).id, "a");
});
