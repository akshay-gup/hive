import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import app, { type Env } from "../apps/chat/src/app.ts";
import { RoomLogic } from "../apps/chat/src/room-logic.ts";
import {
  generateWorkspaceKeys,
  signChatPeople,
  signChatPurge,
  signChatRevocation,
  signChatToken,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../packages/integrations/src/workspace-token.ts";
import { memorySql } from "./helpers/do-shim.ts";

type Identity = { sub: string; email: string; name: string; role: WorkspaceRole };
const keys = generateWorkspaceKeys();
const max = { sub: "acct_max", email: "max@example.com", name: "Max", role: "member" as const };
const ada = { sub: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" as const };

let rooms: Map<string, RoomLogic>;
let purged: string[];
let clock: number;
let limited: boolean;

const env = (): Env => ({
  ROOMS: {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (request: Request) => {
        const name = String(id);
        let room = rooms.get(name);
        if (!room) {
          room = new RoomLogic(memorySql(), {
            purge: async () => {
              purged.push(name);
            },
            clock: () => clock,
          });
          rooms.set(name, room);
        }
        return room.fetch(request);
      },
    }),
  },
  CONTROL_PUBLIC_KEY: keys.publicKey,
  CHAT_ALLOWED_ORIGINS: "https://app.test, https://other.test",
  CHAT_LIMITER: { limit: async () => ({ success: !limited }) },
});

beforeEach(() => {
  rooms = new Map();
  purged = [];
  clock = Date.now();
  limited = false;
});

const token = (who: Identity = max, workspaceId = "w1", now?: number) =>
  signChatToken(keys.privateKey, { ...who, workspaceId, now });
const ask = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token: bearer, ...rest } = init;
  return app.request(
    `https://chat.test${path}`,
    {
      ...rest,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(rest.headers ?? {}),
      },
    },
    env(),
  );
};

test("chat answers only to a chat token for that workspace", async () => {
  assert.equal((await ask("/w/w1/v1/channels")).status, 401);
  assert.equal((await ask("/w/w1/v1/channels", { token: "garbage" })).status, 401);
  const signIn = signWorkspaceToken(keys.privateKey, { ...max, workspaceId: "w1" });
  assert.equal((await ask("/w/w1/v1/channels", { token: signIn })).status, 401, "a sign-in token");
  assert.equal((await ask("/w/w1/v1/channels", { token: token(max, "w2") })).status, 401);
  const other = generateWorkspaceKeys();
  const forged = signChatToken(other.privateKey, { ...max, workspaceId: "w1" });
  assert.equal((await ask("/w/w1/v1/channels", { token: forged })).status, 401);
  const ok = await ask("/w/w1/v1/channels", { token: token() });
  assert.equal(ok.status, 200);
  assert.deepEqual(
    ((await ok.json()) as { id: string }[]).map((c) => c.id),
    ["general"],
  );
});

test("what is in a workspace's room is not in another's", async () => {
  const made = await ask("/w/w1/v1/channels", {
    method: "POST",
    token: token(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Design" }),
  });
  assert.equal(made.status, 201);
  const names = async (workspaceId: string) =>
    (
      (await (
        await ask(`/w/${workspaceId}/v1/channels`, { token: token(max, workspaceId) })
      ).json()) as {
        name: string;
      }[]
    ).map((c) => c.name);
  assert.deepEqual((await names("w1")).sort(), ["Design", "general"]);
  assert.deepEqual(await names("w2"), ["general"]);
});

test("who is asking is what the token says, whatever the caller puts in the request", async () => {
  const spoof = {
    "x-hive-identity": JSON.stringify({ ...ada, issuedAt: Date.now(), role: "owner" }),
    "x-hive-internal": "purge",
  };
  const response = await ask("/w/w1/v1/admin/channels", { token: token(max), headers: spoof });
  assert.equal(response.status, 403, "Max is a member, whatever the header says");
  assert.deepEqual(purged, []);
  const me = await ask("/w/w1/v1/me", { token: token(max), headers: spoof });
  assert.equal(((await me.json()) as { email: string }).email, "max@example.com");
});

test("only the app's own origins may use it from a browser", async () => {
  const preflight = (origin: string) =>
    ask("/w/w1/v1/channels", {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
  assert.equal(
    (await preflight("https://app.test")).headers.get("access-control-allow-origin"),
    "https://app.test",
  );
  assert.equal(
    (await preflight("https://other.test")).headers.get("access-control-allow-origin"),
    "https://other.test",
  );
  assert.equal(
    (await preflight("https://evil.test")).headers.get("access-control-allow-origin"),
    null,
  );
});

test("a person who asks too often is slowed", async () => {
  limited = true;
  assert.equal((await ask("/w/w1/v1/channels", { token: token() })).status, 429);
});

test("revoking someone ends the tokens made up to then, and a later one works", async () => {
  const before = token(max, "w1", clock - 5_000);
  assert.equal((await ask("/w/w1/v1/me", { token: before })).status, 200);
  const revoke = (bearer: string) =>
    ask("/w/w1/internal/revoke", { method: "POST", token: bearer });
  // A chat token cannot revoke, and neither can another workspace's revocation.
  assert.equal((await revoke(token(ada))).status, 401);
  assert.equal(
    (await revoke(signChatRevocation(keys.privateKey, { workspaceId: "w2", sub: max.sub }))).status,
    401,
  );
  const ended = await revoke(
    signChatRevocation(keys.privateKey, { workspaceId: "w1", sub: max.sub }),
  );
  assert.equal(ended.status, 200);
  assert.equal((await ask("/w/w1/v1/me", { token: before })).status, 401);
  // The other person is untouched, and so is Max once he has signed in again a moment later.
  assert.equal((await ask("/w/w1/v1/me", { token: token(ada, "w1", clock - 5_000) })).status, 200);
  assert.equal((await ask("/w/w1/v1/me", { token: token(max, "w1", clock + 2_000) })).status, 200);
});

test("clearing a removed workspace out is for the control plane alone", async () => {
  const purge = (bearer: string, workspaceId = "w1") =>
    ask(`/w/${workspaceId}/internal/purge`, { method: "POST", token: bearer });
  assert.equal((await purge(token())).status, 401);
  assert.equal((await purge(signChatPurge(keys.privateKey, { workspaceId: "w2" }))).status, 401);
  assert.deepEqual(purged, []);
  assert.equal((await purge(signChatPurge(keys.privateKey, { workspaceId: "w1" }))).status, 200);
  assert.deepEqual(purged, ["w1"]);
});

test("the control plane tells a workspace who is in it, so they can be found before they open chat", async () => {
  const put = (bearer: string, people: unknown) =>
    ask("/w/w1/internal/people", {
      method: "POST",
      token: bearer,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ people }),
    });
  const roster = [
    { ...max },
    { ...ada },
    { sub: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
    { sub: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
  ];
  assert.equal((await put(token(), roster)).status, 401, "not a person's to say");
  assert.equal(
    (await put(signChatPeople(keys.privateKey, { workspaceId: "w2" }), roster)).status,
    401,
  );
  const told = await put(signChatPeople(keys.privateKey, { workspaceId: "w1" }), roster);
  assert.equal(told.status, 200);
  const list = async () =>
    (
      (await (await ask("/w/w1/v1/dms/people", { token: token() })).json()) as { name: string }[]
    ).map((p) => p.name);
  assert.deepEqual(await list(), ["Max", "Ada", "Mia"], "the team, not the guest");
  // Someone no longer named is gone from it.
  await put(
    signChatPeople(keys.privateKey, { workspaceId: "w1" }),
    roster.filter((p) => p.sub !== "acct_mia"),
  );
  assert.deepEqual(await list(), ["Max", "Ada"]);
});

test("the live connection takes its token from the subprotocol, and passes on only what was checked", async () => {
  const seen: Request[] = [];
  const spy: Env = {
    ...env(),
    ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          seen.push(request);
          return new Response("up");
        },
      }),
    },
  };
  const connect = (headers: Record<string, string>) =>
    app.request("https://chat.test/w/w1/v1/ws", { headers }, spy);
  assert.equal((await connect({})).status, 426, "not a WebSocket");
  assert.equal((await connect({ upgrade: "websocket" })).status, 401, "no token");
  assert.equal(
    (await connect({ upgrade: "websocket", "sec-websocket-protocol": "hive.v1" })).status,
    401,
  );
  assert.equal(
    (await connect({ upgrade: "websocket", "sec-websocket-protocol": "hive.v1, garbage" })).status,
    401,
  );
  assert.equal(
    (await connect({ upgrade: "websocket", "sec-websocket-protocol": `other, ${token()}` })).status,
    401,
    "only the protocol this speaks",
  );
  assert.equal(seen.length, 0);
  const good = await connect({
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": "abc",
    "sec-websocket-version": "13",
    "sec-websocket-protocol": `hive.v1, ${token()}`,
    "x-hive-identity": JSON.stringify({ ...ada, issuedAt: 0, role: "owner" }),
    cookie: "session=secret",
  });
  assert.equal(good.status, 200);
  const forwarded = seen[0];
  assert.equal(forwarded?.headers.get("upgrade"), "websocket");
  assert.equal(forwarded?.headers.get("cookie"), null, "nothing else of the caller's");
  const identity = JSON.parse(forwarded?.headers.get("x-hive-identity") ?? "{}");
  assert.deepEqual([identity.email, identity.role], ["max@example.com", "member"]);
  assert.ok(identity.expiresAt > Date.now(), "the connection ends when the token does");
  assert.equal(
    forwarded?.headers.get("sec-websocket-protocol"),
    "hive.v1",
    "the token is not passed on",
  );
});
