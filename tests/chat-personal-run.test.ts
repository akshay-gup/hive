import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelView } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import type { AgentExtra } from "../packages/domain/src/chat-agent.ts";
import { wired } from "./helpers/chat-wired.ts";

/** A personal chat with the agent, run against the real machine: no mention, answered below, one session. */
test("the agent answers every message in a personal chat, below it, in one session, with the tools of its own", async (t) => {
  const offered: string[][] = [];
  const f = await wired(t, ({ tools, say }) => {
    offered.push([...tools].sort());
    say("On it.");
  });
  const own = ((await (await f.call("max", "GET", "/v1/channels")).json()) as ChannelView[]).find(
    (c) => c.kind === "personal",
  );
  assert.ok(own);
  const answers = () =>
    f.core.messages.page(own.id, { limit: 50 }).messages.filter((m) => m.authorKind === "agent");
  const done = (n: number) =>
    f.until(`answer ${n}`, () => {
      const list = answers();
      return (
        list.length >= n &&
        list.slice(0, n).every((m) => ["done", "failed"].includes((m.extra as AgentExtra).status))
      );
    });
  const send = async (body: string) => {
    const response = await f.call("max", "POST", `/v1/channels/${own.id}/messages`, { body });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as ChatMessage;
  };
  await send("what should I do first?");
  await done(1);
  await send("and then?");
  await done(2);
  const [first, second] = answers();
  assert.equal(first?.threadRoot, null);
  assert.equal((first?.extra as AgentExtra).status, "done");
  assert.equal(first?.body, "On it.");
  assert.equal((second?.extra as AgentExtra).status, "done");
  // One session carries on, and the agent has what its first chat had that works through the room.
  assert.equal(f.opencode.prompts[0]?.sessionID, f.opencode.prompts[1]?.sessionID);
  for (const tool of [
    "delegate_task",
    "search_mail",
    "create_project",
    "agent_status",
    "read_board",
  ])
    assert.ok(offered[0]?.includes(tool), tool);
  for (const tool of ["request_upload", "present_choices"])
    assert.equal(offered[0]?.includes(tool), false, tool);
  assert.match(f.opencode.prompts[0]?.context ?? "", /private chat/);
  assert.doesNotMatch(f.opencode.prompts[0]?.context ?? "", /shared team chat/);
  // It does not tell the asker it has answered: they are looking at it.
  const notices = (await (await f.call("max", "GET", "/v1/notifications")).json()) as {
    kind: string;
  }[];
  assert.equal(notices.filter((n) => n.kind === "reply").length, 0);
});
