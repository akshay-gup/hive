import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ChatCore } from "../apps/chat/src/core.ts";
import type { ChannelView, DirectMessagePerson } from "../packages/domain/src/agent.ts";
import { memorySql } from "./helpers/do-shim.ts";

/**
 * Direct messages in the chat service: a private channel between two people, made the first time one
 * of them opens it, found by the other's name, and not changeable into anything for more people.
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
  // The control plane tells the workspace who is in it.
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
const dmsOf = async (who: Who) => (await channelsOf(who)).filter((c) => c.kind === "dm");
const message = async (who: Who, to: Who) => {
  const response = await call(who, "POST", "/v1/dms", { email: people[to].email });
  assert.equal(response.status, 201, `${who} -> ${to}`);
  return (await response.json()) as ChannelView;
};

test("the first message makes a private channel of the two, the same one from either side, named for the other", async () => {
  const fromMax = await message("max", "mia");
  const fromMia = await message("mia", "max");
  assert.equal(fromMax.id, fromMia.id);
  assert.equal(fromMax.name, "Mia");
  assert.equal(fromMia.name, "Max");
  assert.deepEqual(fromMax.dm, { email: "mia@example.com", name: "Mia" });
  assert.deepEqual(
    [fromMax.visibility, fromMax.kind, fromMax.members],
    ["private", "dm", ["max@example.com", "mia@example.com"]],
  );
  // Asking again finds it and makes nothing new.
  assert.equal((await message("max", "mia")).id, fromMax.id);
  assert.equal((await dmsOf("max")).length, 1);
  assert.deepEqual(
    (await dmsOf("mia")).map((c) => c.name),
    ["Max"],
  );
});

test("a message to yourself is yours alone", async () => {
  const own = await message("max", "max");
  assert.equal(own.name, "Max (you)");
  assert.deepEqual(own.members, ["max@example.com"]);
  assert.equal(
    (await dmsOf("mia")).some((c) => c.id === own.id),
    false,
  );
});

test("no one else finds it or reaches it, the owner and admins included", async () => {
  const dm = await message("max", "mia");
  for (const who of ["olive", "ada", "gus"] as const) {
    assert.equal(
      (await channelsOf(who)).some((c) => c.id === dm.id),
      false,
      who,
    );
    assert.equal((await call(who, "GET", `/v1/channels/${dm.id}`)).status, 404, who);
    assert.equal((await call(who, "GET", `/v1/channels/${dm.id}/members`)).status, 404, who);
  }
  const directory = (await (await call("olive", "GET", "/v1/admin/channels")).json()) as {
    id: string;
  }[];
  assert.equal(
    directory.some((entry) => entry.id === dm.id),
    false,
  );
  assert.equal((await call("ada", "POST", `/v1/admin/channels/${dm.id}/archive`, {})).status, 404);
  // The two of them are in it.
  assert.equal((await call("mia", "GET", `/v1/channels/${dm.id}`)).status, 200);
});

test("it stays between the two: nobody is added or removed, it is not left, made public, given managers or archived", async () => {
  const dm = await message("max", "mia");
  const members = `/v1/channels/${dm.id}/members`;
  const add = await call("max", "POST", members, { add: ["olive@example.com"] });
  assert.equal(add.status, 403);
  assert.equal((await call("max", "POST", members, { remove: ["mia@example.com"] })).status, 403);
  assert.equal((await call("max", "POST", members, { remove: ["max@example.com"] })).status, 403);
  assert.equal(
    (await call("max", "PATCH", `/v1/channels/${dm.id}`, { visibility: "public" })).status,
    409,
  );
  assert.equal((await call("max", "PATCH", `/v1/channels/${dm.id}`, { topic: "x" })).status, 409);
  assert.equal(
    (
      await call("max", "POST", `/v1/channels/${dm.id}/managers`, {
        add: ["max@example.com"],
      })
    ).status,
    409,
  );
  assert.equal((await call("max", "POST", `/v1/channels/${dm.id}/archive`, {})).status, 409);
  const view = (await (await call("max", "GET", members)).json()) as {
    people: unknown[];
    you: Record<string, boolean>;
  };
  assert.equal(view.people.length, 2);
  assert.equal(Object.entries(view.you).filter(([k, v]) => k !== "in" && v).length, 0);
  assert.equal(
    (await dmsOf("max")).some((c) => c.id === dm.id),
    true,
    "and it is still there",
  );
});

test("a guest neither sends nor is sent direct messages, and there must be someone by that address", async () => {
  assert.equal((await call("gus", "POST", "/v1/dms", { email: people.max.email })).status, 403);
  assert.equal((await call("gus", "GET", "/v1/dms/people")).status, 403);
  assert.equal((await call("max", "POST", "/v1/dms", { email: people.gus.email })).status, 403);
  assert.equal((await call("max", "POST", "/v1/dms", { email: "nobody@example.com" })).status, 404);
  assert.equal((await call("max", "POST", "/v1/dms", {})).status, 404);
});

test("the people to message are the team, you first, and no guests", async () => {
  const list = (await (await call("max", "GET", "/v1/dms/people")).json()) as DirectMessagePerson[];
  assert.deepEqual(
    list.map((p) => [p.name, p.you]),
    [
      ["Max", true],
      ["Ada", false],
      ["Mia", false],
      ["Olive", false],
    ],
  );
});
