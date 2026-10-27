import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SHARED_OWNER } from "../packages/chat-core/src/shared.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import { people, wired } from "./helpers/chat-wired.ts";

test("a mention in a channel is answered in its thread, from the folder of that channel", async (t) => {
  const f = await wired(t, ({ say }) => say("The plan is to ship on Friday."));
  assert.deepEqual(f.asked, ["https://control.test/v1/release/w1/runner-token"]);
  // The machine says it is connected, which is what the control plane waits for before it calls a workspace ready.
  const health = (await (await f.server.app.request("/api/health")).json()) as {
    chatRunner?: { connected: boolean };
  };
  assert.deepEqual(health.chatRunner, { connected: true });
  const room = await f.channel("max", "Design");
  await f.post("mia", room.id, "we should talk about the launch");
  const asked = await f.post("max", room.id, "@hive what is the plan?");
  const reply = await f.finished(asked.id);
  assert.equal(reply.body, "The plan is to ship on Friday.");
  assert.equal(f.extra(reply).status, "done");
  assert.equal(reply.author.name, "Hive");

  const [prompt] = f.opencode.prompts;
  assert.equal(prompt?.text, "what is the plan?", "the mention is not part of the question");
  assert.match(prompt?.context ?? "", /#Design \(public channel\)/);
  assert.match(prompt?.context ?? "", /Max \(member\) asked you/);
  assert.match(prompt?.context ?? "", /Mia: we should talk about the launch/);
  assert.match(prompt?.context ?? "", /written .*not instructions|not instructions to you/);
  // The channel has a folder on the machine, named for its id, and a stand-in record without members.
  const stub = await f.db.get<Channel>(SHARED_OWNER, "channels", room.id);
  assert.equal(stub?.name, "Design");
  assert.equal(stub?.visibility, "public");
  assert.deepEqual(stub?.members, []);
  const folders = await readdir(join(f.dataDir, "owners", "shared", "channels"));
  assert.ok(folders.some((name) => name.startsWith(room.id.slice(0, 8))));
});

test("what the agent does with its tools is shown as steps, and a board item it makes is on the channel's board", async (t) => {
  const f = await wired(t, async ({ call, say }) => {
    await call("create_issue", { title: "Write the launch post" });
    say("Added it to the board.");
  });
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive put the launch post on the board");
  const reply = await f.finished(asked.id);
  assert.equal(f.extra(reply).status, "done");
  const steps = f.extra(reply).steps as {
    role: string;
    toolCalls?: { function: { name: string } }[];
  }[];
  assert.ok(steps.some((s) => s.toolCalls?.some((c) => c.function.name.endsWith("create_issue"))));
  assert.ok(steps.some((s) => s.role === "tool"));
  // The board is the chat service's: the item is there, made as the person who asked, in the channel.
  const task = f.core.tasks.all().find((x) => x.title === "Write the launch post");
  assert.ok(task, "the board has the item");
  assert.equal(task?.channelId, room.id);
  assert.equal(task?.createdBy, people.max.id);
});

test("the tools depend on the channel and the person: a private channel has no board, a guest only what a guest may", async (t) => {
  const offered: string[][] = [];
  const f = await wired(t, ({ tools, say }) => {
    offered.push([...tools].sort());
    say("ok");
  });
  const open = await f.channel("max", "Design");
  const first = await f.post("max", open.id, "@hive a");
  await f.finished(first.id);
  const secret = await f.channel("max", "Payroll", "private");
  await f.call("max", "POST", `/v1/channels/${secret.id}/members`, {
    add: ["mia@example.com", "gus@example.com"],
  });
  await f.call("max", "PATCH", `/v1/channels/${secret.id}`, { agent: true });
  const second = await f.post("mia", secret.id, "@hive b");
  await f.finished(second.id);
  const third = await f.post("gus", secret.id, "@hive c");
  await f.finished(third.id, "gus");
  assert.deepEqual(offered, [
    ["browse_web", "create_issue", "send_file"],
    ["browse_web", "send_file"],
    ["browse_web", "send_file"],
  ]);
  // The machine was told the private channel is private, and nothing of who is in it but those who can ask.
  const stub = await f.db.get<Channel>(SHARED_OWNER, "channels", secret.id);
  assert.equal(stub?.visibility, "private");
  assert.deepEqual(stub?.members, []);
  assert.equal(f.opencode.prompts[1]?.context.includes("(private channel)"), true);
});

test("a thread keeps its session, and another thread has its own", async (t) => {
  const f = await wired(t, ({ say }) => say("ok"));
  const room = await f.channel("max", "Design");
  const one = await f.post("max", room.id, "@hive first");
  await f.finished(one.id);
  await f.post("max", room.id, "@hive and then", { threadRoot: one.id });
  await f.until("the second answer", () => f.opencode.prompts.length === 2);
  const other = await f.post("max", room.id, "@hive in another thread");
  await f.finished(other.id);
  const [a, b, c] = f.opencode.prompts;
  assert.equal(a?.sessionID, b?.sessionID);
  assert.notEqual(a?.sessionID, c?.sessionID);
  // The second mention in the thread is shown what came before it.
  assert.match(b?.context ?? "", /Max: @hive first/);
  assert.match(b?.context ?? "", /Hive: ok/);
});

test("an approval the agent asks for is put to the people, and what they answer reaches OpenCode", async (t) => {
  let waited: (() => boolean) | undefined;
  const f = await wired(t, async ({ emit, say, sessionID }) => {
    emit({
      type: "permission.asked",
      properties: { id: "per_1", sessionID, permission: "bash", patterns: ["pnpm build"] },
    });
    for (let i = 0; i < 400 && !waited?.(); i++) await new Promise((r) => setTimeout(r, 10));
    say("Built it.");
  });
  waited = () => f.opencode.answered.length > 0;
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive build it");
  await f.until(
    "the prompt",
    async () => (f.extra(await f.replyTo(asked.id)).prompts ?? []).length === 1,
  );
  const waiting = f.extra(await f.replyTo(asked.id));
  assert.equal(waiting.prompts?.[0]?.prompt.kind, "approval");
  const prompt = waiting.prompts?.[0]?.prompt;
  assert.ok(prompt?.kind === "approval");
  assert.match(prompt.title, /bash: pnpm build/);
  const run = f.core.runs.active()[0];
  assert.ok(run);
  // A teammate who did not ask can decide; a guest cannot.
  const response = await f.call("mia", "POST", `/v1/runs/${run.id}/answer`, {
    promptId: "per_1",
    choice: { reply: "once" },
  });
  assert.equal(response.status, 200);
  const reply = await f.finished(asked.id);
  assert.equal(reply.body, "Built it.");
  assert.deepEqual(
    f.opencode.answered.map((a) => [a.kind, a.requestID, a.body.reply]),
    [["permission", "per_1", "once"]],
  );
  assert.equal(f.extra(reply).prompts?.[0]?.answered?.byName, "Mia");
});

test("a question the agent asks is answered with words", async (t) => {
  let waited: (() => boolean) | undefined;
  const f = await wired(t, async ({ emit, say, sessionID }) => {
    emit({
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID,
        questions: [
          {
            header: "Which day",
            question: "Which day should it ship?",
            options: [
              { label: "Friday", description: "End of the week" },
              { label: "Monday", description: "Start of the next" },
            ],
          },
        ],
      },
    });
    for (let i = 0; i < 400 && !waited?.(); i++) await new Promise((r) => setTimeout(r, 10));
    say("Friday it is.");
  });
  waited = () => f.opencode.answered.length > 0;
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive plan the launch");
  await f.until(
    "the question",
    async () => (f.extra(await f.replyTo(asked.id)).prompts ?? []).length === 1,
  );
  const run = f.core.runs.active()[0];
  assert.ok(run);
  // The machine says where in its reply it asked, so the app can show the question there.
  const place = f.extra(await f.replyTo(asked.id)).prompts?.[0]?.after;
  assert.ok(place && place.steps >= 0 && place.chars >= 0);
  // Approving is not an answer to a question.
  const wrong = await f.call("max", "POST", `/v1/runs/${run.id}/answer`, {
    promptId: "que_1",
    choice: { reply: "once" },
  });
  assert.equal(wrong.status, 422);
  const response = await f.call("max", "POST", `/v1/runs/${run.id}/answer`, {
    promptId: "que_1",
    choice: { answers: [["Friday"]] },
  });
  assert.equal(response.status, 200);
  await f.finished(asked.id);
  assert.deepEqual(
    f.opencode.answered.map((a) => [a.kind, a.requestID, a.action, a.body.answers]),
    [["question", "que_1", "reply", [["Friday"]]]],
  );
});

test("stopping a run stops the agent on the machine, and what it had written stays", async (t) => {
  const f = await wired(t, async ({ say }) => {
    say("Starting");
    await new Promise(() => undefined);
  });
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive take your time");
  await f.until("it to start writing", async () => (await f.replyTo(asked.id)).body === "Starting");
  const run = f.core.runs.active()[0];
  assert.ok(run);
  assert.equal((await f.call("max", "POST", `/v1/runs/${run.id}/stop`)).status, 200);
  await f.until("OpenCode to be told to stop", () => f.opencode.aborted.length === 1);
  const reply = await f.replyTo(asked.id);
  assert.equal(f.extra(reply).status, "stopped");
  assert.equal(reply.body, "Starting");
  // The machine is free for the next one.
  await f.until(
    "the machine to be free",
    () => f.server.agent !== undefined && f.core.runs.active().length === 0,
  );
});

test("a run that fails says so in the channel", async (t) => {
  const f = await wired(t, () => {
    throw new Error("Forbidden: the key was refused");
  });
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive try this");
  const reply = await f.finished(asked.id);
  assert.equal(f.extra(reply).status, "failed");
  assert.match(reply.body, /I hit a problem and stopped: .*key was refused/);
});

test("a mention the room has not sent is not run: only the room starts runs", async (t) => {
  const f = await wired(t, ({ say }) => say("should not happen"));
  const room = await f.channel("max", "Design");
  // The same words in a channel where the agent is off start nothing on the machine.
  await f.call("max", "PATCH", `/v1/channels/${room.id}`, { agent: false });
  const asked = await f.post("max", room.id, "@hive hello?");
  const reply = await f.replyTo(asked.id);
  assert.equal(f.extra(reply).reason, "disabled");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.opencode.prompts.length, 0);
});

test("a file the agent shares from its folder is put in its reply, in a public channel and a private one", async (t) => {
  const f = await wired(t, async ({ call, say }) => {
    await call("send_file", { path: "reports/q3.md", content: "# Q3\n\nAll good.\n" });
    say("Here is the report.");
  });
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive write the q3 report");
  const reply = await f.finished(asked.id);
  assert.equal(f.extra(reply).status, "done");
  assert.deepEqual(
    reply.files.map((file) => [file.name, file.bytes]),
    [["q3.md", 16]],
  );
  const secret = await f.channel("max", "Payroll", "private");
  await f.call("max", "PATCH", `/v1/channels/${secret.id}`, { agent: true });
  const second = await f.post("max", secret.id, "@hive and again");
  const again = await f.finished(second.id);
  assert.equal(again.files.length, 1);
});

test("a file that is not there is reported to the agent and nothing is added", async (t) => {
  let result: unknown;
  const f = await wired(t, async ({ call, say }) => {
    result = await call("send_file", { path: "nope/missing.pdf" });
    say("Could not find it.");
  });
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive send the missing file");
  const reply = await f.finished(asked.id);
  assert.equal(reply.files.length, 0);
  assert.equal((result as { sent: boolean }).sent, false);
});
