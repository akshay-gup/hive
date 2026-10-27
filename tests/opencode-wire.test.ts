import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventSchemas } from "@ag-ui/core";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { WATCH_DOWN_TEXT, WATCH_STOP_TEXT } from "../packages/domain/src/agent-watch.ts";
import { encodeJevAction } from "../packages/domain/src/jev.ts";
import { type FakeTurn, fakeOpencode } from "./helpers/fake-opencode.ts";
import { detailOf, localBoard, localTask } from "./helpers/local-task.ts";

/**
 * Hive against something that speaks OpenCode's HTTP API, with nothing stubbed on Hive's side: the
 * SDK client, the global event stream, session binding, the AG-UI shim, the task worker and the tool
 * bridge, which the agent reaches over HTTP. Only what the agent decides to do is the test's.
 */
async function wired(
  t: TestContext,
  behave: (turn: FakeTurn) => void | Promise<void>,
  adjust: Partial<Config> = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "hive-wire-"));
  const db = await createStore();
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  const opencode = await fakeOpencode({
    behave,
    // The bridge's URL is the API's own port; reach the same route without listening on one.
    fetchTools: (_url, init) => {
      assert.ok(app, "the app has not been built yet");
      return Promise.resolve(app.request("/api/hive-tools", init));
    },
  });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir,
    model: "openai/fixture",
    opencodeServerUrl: opencode.url,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...adjust,
  };
  const server = await createApp(db, config);
  server.agent.board = localBoard(server.agent);
  app = server.app;
  await server.opencode.start();
  const { token } = await server.auth.session();
  t.after(async () => {
    await server.opencode.stop();
    await server.agent.stop();
    await opencode.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Send a chat message to the agent as the app does, and collect the events that come back. */
  async function chat(content: string, options: { threadId?: string; signal?: AbortSignal } = {}) {
    const response = await server.app.request("/api/agent/opencode/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: options.threadId ?? "wire-thread",
        runId: crypto.randomUUID(),
        messages: [{ id: crypto.randomUUID(), role: "user", content }],
      }),
      signal: options.signal,
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
    return { events, types: events.map((event) => String(event.type)) };
  }
  /** Press Stop on a thread, as the app does. */
  async function stop(threadId = "wire-thread") {
    return server.app.request("/api/agent/opencode/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
  }
  return { ...server, db, config, opencode, chat, stop };
}

test("a reply travels over OpenCode's protocol and comes back as AG-UI events", async (t) => {
  const f = await wired(t, ({ say }) => say("Hello from the agent."));
  const first = await f.chat("@hive hi there");
  for (const event of first.events) EventSchemas.parse(event);
  assert.deepEqual(first.types, [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  assert.equal(
    first.events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta,
    "Hello from the agent.",
  );
  const [prompt] = f.opencode.prompts;
  assert.deepEqual(prompt.model, { providerID: "openai", modelID: "fixture" });
  assert.equal(prompt.text, "hi there", "the mention is not part of what the agent is asked");
  assert.match(prompt.context, /\[hive context\]/);

  // In a person's own chat nobody else is listening, so the agent answers without being mentioned,
  // and every message goes to the same session. (Shared channels still need @hive: see
  // opencode-mention.test.ts.)
  await f.chat("just us chatting");
  assert.equal(f.opencode.prompts.length, 2);
  assert.equal(f.opencode.prompts[1].sessionID, prompt.sessionID);
  await f.chat("@hive and again");
  assert.equal(f.opencode.prompts.length, 3);
  assert.equal(f.opencode.prompts[2].sessionID, prompt.sessionID);
});

test("the agent reaches Hive's tools over HTTP, and their results come back as tool events", async (t) => {
  let offered: string[] = [];
  const f = await wired(t, async ({ tools, call, say }) => {
    offered = tools;
    const found = (await call("search_mail", { query: "aquarium" })) as {
      matches: { threadId: string }[];
    };
    await call("read_mail_thread", { threadId: found.matches[0].threadId });
    say("It leaves at 8:15.");
  });
  await f.workspace.ensureSample("local-user", f.actions);
  const chat = await f.chat("@hive Check my emails for the school trip");
  for (const event of chat.events) EventSchemas.parse(event);
  for (const name of [
    "search_mail",
    "read_mail_thread",
    "browse_web",
    "send_file",
    "delegate_task",
  ])
    assert.ok(offered.includes(name), name);
  const results = chat.events.filter((event) => event.type === "TOOL_CALL_RESULT");
  assert.equal(results.length, 2);
  assert.match(String(results[1].content), /8:15 AM/);
  assert.deepEqual(
    chat.events.filter((event) => event.type === "TOOL_CALL_START").map((e) => e.toolCallName),
    ["search_mail", "read_mail_thread"],
  );
});

test("a task runs as an OpenCode session, and the agent hands its work in for review", async (t) => {
  const f = await wired(t, async ({ call, text }) => {
    await call("finish_task", { summary: `Done: ${text.split("\n")[0]}` });
  });
  const task = await localTask(f.agent, "owner", { prompt: "Plan my week", kind: "agent" });
  await f.agent.worker.tick();
  const result = await detailOf(f.agent, "owner", task.id);
  assert.equal(result.task.status, "in_review", result.task.error ?? result.task.question);
  assert.match(String(result.task.result), /^Done: /);
  assert.deepEqual(f.opencode.prompts[0].model, { providerID: "openai", modelID: "fixture" });
  assert.match(f.opencode.prompts[0].parts.map((part) => part.text).join("\n"), /Plan my week/);
});

test("stopping a reply stops the OpenCode session", async (t) => {
  const pressed: { stop?: () => Promise<unknown> } = {};
  const f = await wired(t, async () => {
    await pressed.stop?.();
    // The agent is still working when the person stops the reply.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  pressed.stop = () => f.stop();
  await f.chat("@hive take your time");
  assert.deepEqual(f.opencode.aborted, [f.opencode.prompts[0].sessionID]);
});

test("choice cards: a panel the agent shows can be picked, and the pick reaches OpenCode in words", async (t) => {
  const f = await wired(
    t,
    async ({ call, say, index }) => {
      if (index === 1)
        await call("present_choices", {
          message: "What next?",
          context: "A school email",
          title: "Next steps",
          control: "clarification",
          options: [
            { id: "explore", label: "Explore exhibits", details: [], sources: [] },
            { id: "slip", label: "Complete permission slip", details: [], sources: [] },
          ],
        });
      say(index === 1 ? "Pick one." : "Great, exploring.");
    },
    { jevMode: "sample" },
  );
  const first = await f.chat("@hive Help me get ready for the trip");
  const shown = first.events.find((event) => event.type === "TOOL_CALL_RESULT");
  const panel = JSON.parse(String(shown?.content)).panel;
  assert.equal(panel.options.length, 2);
  const pick = encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "explore",
  });
  // No @hive: a pick answers the agent's own question.
  const second = await f.chat(pick);
  assert.equal(second.types.at(-1), "RUN_FINISHED");
  assert.equal(
    f.opencode.prompts[1].text,
    "I choose “Explore exhibits” from clarification choices. Continue with that preference.",
  );
  assert.equal(f.opencode.prompts[1].sessionID, f.opencode.prompts[0].sessionID);
});

test("when OpenCode cannot answer, the chat is told why", async (t) => {
  const f = await wired(t, () => {
    throw new Error("No API key found for provider openai");
  });
  const chat = await f.chat("@hive hello");
  assert.deepEqual(chat.types, ["RUN_STARTED", "RUN_ERROR"]);
  assert.equal(chat.events[1].message, "No API key found for provider openai");
});

test("a task whose session fails records why", async (t) => {
  const f = await wired(t, () => {
    throw new Error("No API key found for provider openai");
  });
  const task = await localTask(f.agent, "owner", { prompt: "Plan my week", kind: "agent" });
  await f.agent.worker.tick();
  const failed = await f.agent.getTask("owner", task.id);
  assert.equal(failed.status, "failed");
  assert.match(String(failed.error), /No API key found for provider openai/);
});

test("a question the agent asks in a person's own chat is there for the app to show, and answering it lets the run on", async (t) => {
  let waited: (() => boolean) | undefined;
  const f = await wired(t, async ({ emit, say, sessionID }) => {
    emit({
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID,
        questions: [
          {
            header: "Who",
            question: "Who is it for?",
            options: [{ label: "A friend", description: "Someone you know" }],
          },
        ],
      },
    });
    for (let i = 0; i < 400 && !waited?.(); i++) await new Promise((r) => setTimeout(r, 10));
    say("Done.");
  });
  waited = () => f.opencode.answered.length > 0;
  const { token } = await f.auth.session();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const running = f.chat("@hive help me draft a message");
  let pending: { requestId: string }[] = [];
  let status = 0;
  for (let i = 0; i < 200 && !pending.length; i++) {
    const response = await f.app.request(
      "/api/agent/opencode/threads/wire-thread/questions/pending",
      { headers: auth },
    );
    status = response.status;
    if (response.status === 200) pending = (await response.json()) as typeof pending;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status, 200, "the app can ask what is pending");
  assert.deepEqual(
    pending.map((q) => q.requestId),
    ["que_1"],
  );
  const reply = await f.app.request("/api/agent/opencode/questions/que_1/reply", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ answers: [["A friend"]] }),
  });
  assert.equal(reply.status, 200);
  const { types } = await running;
  assert.equal(types.at(-1), "RUN_FINISHED");
});

/** A call of one of OpenCode's own tools (not one of Hive's), as OpenCode reports it. */
const nativeCall = (
  turn: FakeTurn,
  callID: string,
  tool: string,
  input: object,
  output: string,
) => {
  const messageID = `msg_${callID}`;
  turn.emit({
    type: "message.updated",
    properties: { info: { id: messageID, role: "assistant", sessionID: "x" } },
  });
  const part = (state: Record<string, unknown>) =>
    turn.emit({
      type: "message.part.updated",
      properties: { part: { id: `prt_${callID}`, messageID, type: "tool", callID, tool, state } },
    });
  part({ status: "running", input });
  part({ status: "completed", input, output });
};

test("with refusing on, a call in a person's own chat that reaches the machine's data stops the run and shows nothing of it", async (t) => {
  let dataDir = "";
  const f = await wired(t, (turn) => {
    nativeCall(turn, "c1", "bash", { command: `cat ${dataDir}/postgres/PG_VERSION` }, "secret-17");
    turn.say("the answer is secret-17");
  });
  dataDir = f.config.dataDir;
  f.watch.setMode("enforce");
  const run = await f.chat("@hive look");
  const error = run.events.find((event) => event.type === "RUN_ERROR");
  assert.equal(error?.message, WATCH_STOP_TEXT);
  assert.ok(!JSON.stringify(run.events).includes("secret-17"));
  assert.ok(!run.types.includes("RUN_FINISHED"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.opencode.deleted.length, 1, "the session it read in is forgotten");
});

test("with refusing on, a task that reaches the machine's data fails with the reason, and its log shows nothing of it", async (t) => {
  let dataDir = "";
  const f = await wired(t, async (turn) => {
    nativeCall(turn, "c1", "bash", { command: `cat ${dataDir}/postgres/PG_VERSION` }, "secret-17");
    await turn.call("finish_task", { summary: "done" }).catch(() => undefined);
  });
  dataDir = f.config.dataDir;
  f.watch.setMode("enforce");
  const task = await localTask(f.agent, "owner", { prompt: "Look around", kind: "agent" });
  await f.agent.worker.tick();
  const failed = await f.agent.getTask("owner", task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, WATCH_STOP_TEXT);
  const log = await f.db.list<{ taskId?: string }>("shared", "run-events");
  assert.ok(!JSON.stringify(log.filter((e) => e.taskId === task.id)).includes("secret-17"));
});

test("with refusing on and the machine's watch down, the person's own chat and a task are not run, and say why", async (t) => {
  const f = await wired(t, ({ say }) => say("hello"));
  f.watch.setMode("enforce");
  f.watch.kernelDown(true, "the kernel watch went quiet");
  const run = await f.chat("@hive hi");
  assert.equal(run.events.find((event) => event.type === "RUN_ERROR")?.message, WATCH_DOWN_TEXT);
  const task = await localTask(f.agent, "owner", { prompt: "Look around", kind: "agent" });
  await f.agent.worker.tick();
  const failed = await f.agent.getTask("owner", task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, WATCH_DOWN_TEXT);
  assert.equal(f.opencode.prompts.length, 0);
});
