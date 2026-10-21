import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { guestTools } from "../apps/server/src/engine/tools.ts";
import { PermissionRulesStore } from "../apps/server/src/opencode/index.ts";
import { shimFixture } from "./helpers/shim.ts";

/**
 * What the agent does when a guest speaks to it: only in a thread of a channel they were added to,
 * only where it asks before it acts (a guest cannot allow anything, so where it does not ask, what
 * a guest wrote would be done unchecked), and with only the tools the conversation needs.
 */
async function workspace(t: TestContext) {
  const f = await shimFixture(t, { managed: true });
  const user = (id: string, role: string) =>
    f.db.put("system", "users", {
      id,
      email: `${id.slice(5)}@example.com`,
      name: id.slice(5),
      role,
      createdAt: "2026-01-01",
      lastLoginAt: "2026-01-01",
    });
  await user("acct:olive", "owner");
  await user("acct:max", "member");
  await user("acct:gus", "guest");
  const acme = await f.agent.createChannel("acct:olive", { name: "Acme" });
  const hr = await f.agent.createChannel("acct:olive", { name: "HR" });
  await f.agent.setChannelMembers("acct:olive", acme.id, { members: ["gus@example.com"] });
  const acmeThread = await f.agent.registerThread("acct:olive", acme.id, "Kickoff");
  const hrThread = await f.agent.registerThread("acct:olive", hr.id, "Payroll");
  const rules = new PermissionRulesStore(f.config.dataDir);
  return { f, acme, hr, acmeThread, hrThread, rules };
}
const refusal = (events: { type: string; message?: unknown }[]) =>
  events.find((event) => event.type === "RUN_ERROR")?.message;

test("a guest's message in their channel reaches the agent, which is offered them the small set of tools", async (t) => {
  const { f, acmeThread } = await workspace(t);
  const offered: string[][] = [];
  f.whenPrompted(async ({ tools, idle }) => {
    offered.push(tools);
    idle();
  });
  const run = await f.run("@hive can you make a to-do for the brief?", {
    threadId: acmeThread.threadId,
    owner: "acct:gus",
  });
  assert.equal(refusal(run.events), undefined);
  assert.equal(offered.length, 1);
  assert.ok(offered[0].includes("create_issue"));
  for (const name of offered[0]) assert.ok(guestTools.has(name), `${name} is not for a guest`);
  // The same thread, asked by a member, has everything.
  const member = await f.run("@hive and what is in the mail?", {
    threadId: acmeThread.threadId,
    owner: "acct:max",
  });
  assert.equal(refusal(member.events), undefined);
  assert.ok(offered[1].includes("search_mail") && offered[1].includes("delegate_task"));
});

test("a guest is not heard by an agent that runs without asking first", async (t) => {
  const { f, acme, acmeThread, rules } = await workspace(t);
  let prompted = 0;
  f.whenPrompted(async ({ idle }) => {
    prompted++;
    idle();
  });
  await rules.setChannelMode("acct:olive", acme.id, "auto");
  const refused = await f.run("@hive list the files next door", {
    threadId: acmeThread.threadId,
    owner: "acct:gus",
  });
  assert.match(
    String(refusal(refused.events)),
    /allowed to act without asking first, so guests can't use it/,
  );
  assert.equal(prompted, 0);
  // The team is unaffected by it, and the guest is heard again once the channel asks first.
  const member = await f.run("@hive list the files", {
    threadId: acmeThread.threadId,
    owner: "acct:max",
  });
  assert.equal(refusal(member.events), undefined);
  assert.equal(prompted, 1);
  await rules.setChannelMode("acct:olive", acme.id, "ask");
  const heard = await f.run("@hive hello", { threadId: acmeThread.threadId, owner: "acct:gus" });
  assert.equal(refusal(heard.events), undefined);
  assert.equal(prompted, 2);
  // Nor where one thing is allowed without asking: a guest would be the one to say when.
  await rules.setChannelRules("acct:olive", acme.id, ["bash:allow"]);
  const allowed = await f.run("@hive run the report", {
    threadId: acmeThread.threadId,
    owner: "acct:gus",
  });
  assert.match(String(refusal(allowed.events)), /allowed to act without asking first/);
  assert.equal(prompted, 2);
  await rules.setChannelRules("acct:olive", acme.id, ["bash:deny"]);
  const denied = await f.run("@hive hello again", {
    threadId: acmeThread.threadId,
    owner: "acct:gus",
  });
  assert.equal(refusal(denied.events), undefined);
  assert.equal(prompted, 3);
});

test("a guest cannot start the agent in a channel they were not added to, or in a chat of their own", async (t) => {
  const { f, hrThread } = await workspace(t);
  let prompted = 0;
  f.whenPrompted(async ({ idle }) => {
    prompted++;
    idle();
  });
  const elsewhere = await f.run("@hive what does payroll look like?", {
    threadId: hrThread.threadId,
    owner: "acct:gus",
  });
  assert.equal(refusal(elsewhere.events), "Guests can open only the channels they were added to");
  // A thread nobody bound would otherwise be bound to a main chat of their own.
  const unbound = await f.run("hello", { threadId: "a-chat-of-my-own", owner: "acct:gus" });
  assert.equal(refusal(unbound.events), "Guests can open only the channels they were added to");
  assert.equal(prompted, 0);
  assert.equal(await f.db.get("acct:gus", "channels", "orchestrator"), null);
  assert.equal(await f.agent.channelOfThread("acct:gus", "a-chat-of-my-own"), null);
});
