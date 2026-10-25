import assert from "node:assert/strict";
import { test } from "node:test";
import { type ControlApi, ControlError } from "../src/hosted/control-api.ts";
import { openWorkspace } from "../src/hosted/open-workspace.ts";

const workspace = { id: "w1", name: "Acme", status: "ready", role: "member", createdAt: "x" };
const user = { id: "u1", email: "u@x.test", name: "U", role: "member" };

function control(chat: () => Promise<unknown>) {
  const calls: string[] = [];
  const api = {
    workspace: async () => workspace,
    wake: async () => {
      calls.push("wake");
    },
    workspaceToken: async () => ({ token: "t", url: "https://ws.test/", expiresAt: 1 }),
    chatToken: async () => {
      calls.push("chat");
      return chat();
    },
  } as unknown as ControlApi;
  return { api, calls };
}
const fetcher = (async () =>
  new Response(JSON.stringify({ token: "session", expiresAt: 123, user }), {
    status: 200,
  })) as unknown as typeof fetch;

test("a workspace opens with its chat service when the control plane has one", async () => {
  const chat = {
    token: "c",
    url: "https://chat.test/w/w1",
    wsUrl: "wss://chat.test/w/w1/v1/ws",
    expiresAt: 5,
  };
  const { api, calls } = control(async () => chat);
  const opened = await openWorkspace(api, "w1", { fetcher });
  assert.deepEqual(opened.chat, chat);
  assert.equal(opened.token, "session");
  assert.deepEqual(calls, ["wake", "chat"]);
});

test("a control plane with no chat service opens the workspace without one", async () => {
  const { api } = control(async () => {
    throw new ControlError("Chat is not set up", 404);
  });
  const opened = await openWorkspace(api, "w1", { fetcher });
  assert.equal(opened.chat, undefined);
  assert.equal(opened.token, "session");
});

test("any other trouble getting the chat token is not hidden", async () => {
  const { api } = control(async () => {
    throw new ControlError("Down", 503);
  });
  await assert.rejects(openWorkspace(api, "w1", { fetcher }), /Down/);
});
