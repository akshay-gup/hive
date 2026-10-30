import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { WATCH_DOWN_TEXT, WATCH_STOP_TEXT } from "../packages/domain/src/agent-watch.ts";
import { type FakeTurn, fakeOpencode } from "./helpers/fake-opencode.ts";
import { detailOf, localBoard, localTask } from "./helpers/local-task.ts";

/**
 * Hive against something that speaks OpenCode's HTTP API, with nothing stubbed on Hive's side: the
 * SDK client, the global event stream, session binding, the task worker and the tool bridge, which the
 * agent reaches over HTTP. Only what the agent decides to do is the test's. (What the agent does in a chat is
 * in the chat-runner tests, which have the room on the other side.)
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
  t.after(async () => {
    await server.opencode.stop();
    await server.agent.stop();
    await opencode.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { ...server, db, config, opencode };
}

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

test("with refusing on and the machine's watch down, a task is not run, and says why", async (t) => {
  const f = await wired(t, ({ say }) => say("hello"));
  f.watch.setMode("enforce");
  f.watch.kernelDown(true, "the kernel watch went quiet");
  const task = await localTask(f.agent, "owner", { prompt: "Look around", kind: "agent" });
  await f.agent.worker.tick();
  const failed = await f.agent.getTask("owner", task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, WATCH_DOWN_TEXT);
  assert.equal(f.opencode.prompts.length, 0);
});
