import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ChatCore } from "../apps/chat/src/core.ts";
import type { ChannelView } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import { memorySql } from "./helpers/do-shim.ts";

/**
 * A person's own conversation with the agent in the chat service: a private channel of one, made for each
 * person who is not a guest, that nobody else can open or change.
 */
const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

let core: ChatCore;
before(async () => {
  core = new ChatCore(memorySql());
  await core.syncPeople(
    Object.values(people).map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );
});

const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const person = people[who];
  return core.handle(
    new Request(`http://chat${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      sub: person.id,
      email: person.email,
      name: person.name,
      role: person.role,
      issuedAt: Date.now(),
    },
  );
};
const channelsOf = async (who: Who) =>
  (await (await call(who, "GET", "/v1/channels")).json()) as ChannelView[];
const own = async (who: Who) => {
  const found = (await channelsOf(who)).filter((c) => c.kind === "personal");
  assert.equal(found.length, 1, `${who} has one`);
  return found[0] as ChannelView;
};

test("everyone but a guest has one conversation of their own, the same each time, private to them", async () => {
  const max = await own("max");
  assert.equal(max.name, "Hive");
  assert.equal(max.visibility, "private");
  assert.deepEqual(max.members, ["max@example.com"]);
  assert.equal((await own("max")).id, max.id);
  assert.notEqual((await own("mia")).id, max.id);
  assert.equal(
    (await channelsOf("gus")).some((c) => c.kind === "personal"),
    false,
  );
  // The workspace still has its #general, and it was made even though a personal channel came first.
  assert.equal(
    (await channelsOf("max")).some((c) => c.name === "general"),
    true,
  );
});

test("no one else finds it or reaches it, the owner and admins included", async () => {
  const max = await own("max");
  for (const who of ["olive", "ada", "mia", "gus"] as const) {
    assert.equal(
      (await channelsOf(who)).some((c) => c.id === max.id),
      false,
      who,
    );
    for (const path of [
      `/v1/channels/${max.id}`,
      `/v1/channels/${max.id}/members`,
      `/v1/channels/${max.id}/messages`,
      `/v1/channels/${max.id}/threads`,
    ])
      assert.equal((await call(who, "GET", path)).status, 404, `${who} ${path}`);
    assert.equal(
      (await call(who, "POST", `/v1/channels/${max.id}/messages`, { body: "hi" })).status,
      404,
      who,
    );
  }
  const directory = (await (await call("olive", "GET", "/v1/admin/channels")).json()) as {
    id: string;
  }[];
  assert.equal(
    directory.some((entry) => entry.id === max.id),
    false,
  );
  assert.equal((await call("ada", "POST", `/v1/admin/channels/${max.id}/join`, {})).status, 404);
  assert.equal((await call("ada", "POST", `/v1/admin/channels/${max.id}/archive`, {})).status, 404);
});

test("it stays theirs alone: nobody is added, it is not left, made public, given managers, archived or deleted", async () => {
  const max = await own("max");
  const members = `/v1/channels/${max.id}/members`;
  assert.equal((await call("max", "POST", members, { add: ["mia@example.com"] })).status, 403);
  assert.equal((await call("max", "POST", members, { remove: ["max@example.com"] })).status, 403);
  assert.equal(
    (await call("max", "PATCH", `/v1/channels/${max.id}`, { visibility: "public" })).status,
    409,
  );
  assert.equal(
    (await call("max", "PATCH", `/v1/channels/${max.id}`, { agent: false })).status,
    409,
  );
  assert.equal((await call("max", "POST", `/v1/channels/${max.id}/archive`, {})).status, 409);
  assert.equal((await call("max", "DELETE", `/v1/channels/${max.id}`)).status, 409);
  assert.equal((await own("max")).id, max.id);
});

test("every message of theirs asks the agent, without naming it, and it answers below, not in a thread", async () => {
  const max = await own("max");
  const posted = await call("max", "POST", `/v1/channels/${max.id}/messages`, {
    body: "what is on today?",
  });
  assert.equal(posted.status, 201);
  const sent = (await posted.json()) as ChatMessage;
  assert.equal(sent.threadRoot ?? null, null);
  const page = core.messages.page(max.id, { limit: 20 }).messages;
  const reply = page.find((m) => m.authorKind === "agent");
  assert.ok(reply, "the agent has a reply waiting");
  assert.equal(reply.threadRoot, null);
  const run = core.runs.byTrigger(sent.id);
  assert.ok(run);
  assert.equal(run.rootId, max.id, "one thread for the whole conversation");
  assert.equal(run.replyId, reply.id);
  // A second message goes in the same thread, so the agent's session carries on.
  const second = (await (
    await call("max", "POST", `/v1/channels/${max.id}/messages`, { body: "and tomorrow?" })
  ).json()) as ChatMessage;
  assert.equal(core.runs.byTrigger(second.id)?.rootId, max.id);
  // Another channel's message without a mention is nothing to the agent.
  const general = (await channelsOf("max")).find((c) => c.name === "general");
  const chatter = (await (
    await call("max", "POST", `/v1/channels/${general?.id}/messages`, { body: "lunch?" })
  ).json()) as ChatMessage;
  assert.equal(core.runs.byTrigger(chatter.id), null);
});

test("the flags the owner reads do not name a person's own conversation", async () => {
  const max = await own("max");
  core.flags.add(
    "flag-1",
    {
      source: "kernel",
      scope: "channel",
      tool: "cat",
      target: "/data/hive/postgres/PG_VERSION",
      rule: "database",
      severity: "high",
      action: "marked",
      mode: "audit",
    },
    { id: "run-x", channelId: max.id, askedBy: people.max.id },
  );
  const seen = (await (await call("olive", "GET", "/v1/agent-flags")).json()) as {
    flags: { scope: string; channelId?: string; channelName?: string }[];
  };
  const flag = seen.flags.find((f) => f.scope === "own-chat");
  assert.ok(flag, "it is shown, as the app's own chat");
  assert.equal(flag.channelId, undefined);
  assert.equal(flag.channelName, undefined);
});
