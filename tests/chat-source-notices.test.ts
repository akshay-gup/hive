import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceErrors } from "../apps/server/src/chat-runner/source-errors.ts";
import { SqliteRecordStore } from "../packages/chat-core/src/sqlite-store.ts";
import type { ChatNotice } from "../packages/domain/src/chat.ts";
import type { RoomFrame, RunnerFrame } from "../packages/domain/src/chat-agent.ts";
import { chatWorld } from "./helpers/chat-world.ts";
import { memorySql } from "./helpers/do-shim.ts";

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;
const HOUR = 3_600_000;
const now = Date.UTC(2026, 9, 28, 12);

async function world() {
  const frames: RoomFrame[] = [];
  let connected = true;
  const w = await chatWorld(people, {
    clock: () => now,
    runner: () =>
      connected ? { send: (text) => frames.push(JSON.parse(text)), close() {} } : null,
  });
  const notices = async (who: Who) =>
    (await (await w.call(who, "GET", "/v1/notifications")).json()) as ChatNotice[];
  return {
    ...w,
    notices,
    frames,
    disconnect: () => {
      connected = false;
    },
  };
}

test("mail failures are kept for current team members, with recipients and words chosen by the room", async () => {
  const w = await world();
  await w.core.agent.onFrame(
    JSON.stringify({
      t: "source.error",
      at: now,
      owner: people.gus.id,
      title: "forged",
      body: "private text",
    }),
  );
  for (const who of ["olive", "ada", "mia"] as const) {
    const [notice] = await w.notices(who);
    assert.equal(notice?.kind, "update");
    assert.equal(notice.title, "Mail connection needs attention");
    assert.ok(!notice.body.includes("private text"));
    assert.ok(
      w.published.some(
        (event) => event.type === "notification.new" && event.userId === people[who].id,
      ),
    );
  }
  assert.deepEqual(await w.notices("gus"), []);
  assert.ok(w.frames.some((frame) => frame.t === "source.error.ack" && frame.at === now));
  w.disconnect();
  assert.equal((await w.notices("mia")).length, 1, "the machine is no longer needed to read it");
});

test("replayed failures do not undo personal read/dismiss state, and work preferences do not hide connection errors", async () => {
  const w = await world();
  const report = () => w.core.agent.onFrame(JSON.stringify({ t: "source.error", at: now }));
  await report();
  const [mine] = await w.notices("mia");
  assert.ok(mine);
  await w.call("mia", "PUT", "/v1/notification-prefs", { work: false, mentions: false });
  assert.equal((await w.notices("mia")).length, 1);
  await w.call("mia", "POST", `/v1/notifications/${mine.id}/read`);
  await report();
  assert.equal((await w.notices("mia"))[0]?.read, true);
  assert.equal((await w.notices("olive"))[0]?.read, false);
  await w.call("olive", "POST", `/v1/notifications/${mine.id}/dismiss`);
  assert.equal((await w.notices("mia")).length, 1, "another person cannot dismiss it");
  await w.call("mia", "POST", `/v1/notifications/${mine.id}/unread`);
  assert.equal((await w.notices("mia"))[0]?.read, false);
  await w.call("mia", "POST", `/v1/notifications/${mine.id}/dismiss`);
  await report();
  assert.deepEqual(await w.notices("mia"), []);
  assert.equal((await w.notices("olive")).length, 1);
});

test("future, stale and malformed failures create no notices, and removed people are not recipients", async () => {
  const w = await world();
  for (const at of [-1, now + HOUR, now - 8 * 24 * HOUR])
    await w.core.agent.onFrame(JSON.stringify({ t: "source.error", at }));
  assert.deepEqual(await w.notices("mia"), []);
  await w.core.syncPeople(
    Object.values(people)
      .filter((p) => p.id !== people.mia.id)
      .map((p) => ({
        sub: p.id,
        email: p.email,
        name: p.name,
        role: p.role,
      })),
  );
  await w.core.agent.onFrame(JSON.stringify({ t: "source.error", at: now }));
  assert.equal(w.core.entries.inScope("notice", { type: "person", id: people.mia.id }).length, 0);
  assert.equal((await w.notices("olive")).length, 1);
});

test("unacknowledged source reports survive reconnect and process restart, without duplicating cloud notices", async () => {
  const db = new SqliteRecordStore(memorySql());
  let up = false;
  const sent: RunnerFrame[] = [];
  const send = (frame: RunnerFrame) => {
    if (!up) return false;
    sent.push(frame);
    return true;
  };
  const first = new SourceErrors(db, send, () => now);
  await first.report();
  assert.equal((await db.list("system", "source-errors")).length, 1);
  assert.deepEqual(sent, []);
  const restarted = new SourceErrors(db, send, () => now);
  up = true;
  await restarted.flush();
  assert.deepEqual(sent, [{ t: "source.error", at: now }]);
  const w = await world();
  await w.core.agent.onFrame(JSON.stringify(sent[0]));
  // The first acknowledgement is lost; the next connection says the same thing again.
  await restarted.flush();
  await w.core.agent.onFrame(JSON.stringify(sent[1]));
  assert.equal((await w.notices("mia")).length, 1);
  const ack = w.frames.find((frame) => frame.t === "source.error.ack");
  assert.ok(ack && ack.t === "source.error.ack");
  await restarted.ack(ack.at);
  assert.deepEqual(await db.list("system", "source-errors"), []);
  await restarted.flush();
  assert.equal(sent.length, 2);
});

test("acknowledging an older source report leaves a newer pending report alone", async () => {
  const db = new SqliteRecordStore(memorySql());
  let clock = now;
  const errors = new SourceErrors(
    db,
    () => false,
    () => clock,
  );
  await errors.report();
  clock += HOUR;
  await errors.report();
  await errors.ack(now);
  assert.deepEqual(
    (await db.list<{ at: number }>("system", "source-errors")).map((r) => r.at),
    [clock],
  );
});
