import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { RunnerLink as RoomSide } from "../apps/chat/src/agent-link.ts";
import { ChatCore } from "../apps/chat/src/core.ts";
import { Realtime } from "../apps/chat/src/realtime.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { SocketLike } from "../apps/server/src/chat-runner/link.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { SHARED_OWNER } from "../packages/chat-core/src/shared.ts";
import type { Channel } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import type { AgentExtra } from "../packages/domain/src/chat-agent.ts";
import { memorySql } from "./helpers/do-shim.ts";
import { type FakeTurn, fakeOpencode } from "./helpers/fake-opencode.ts";

const people = {
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
type Who = keyof typeof people;

/**
 * The agent's machine against the chat service's room, with nothing between them but the socket: a real
 * room (`ChatCore`), the real server with its runner (host, tools, sessions), and OpenCode's HTTP API
 * played by a stand-in. Only what the agent decides to do, and what people click, is the test's.
 */
async function wired(t: TestContext, behave: (turn: FakeTurn) => void | Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "hive-chat-runner-"));
  const db = await createStore();
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  const opencode = await fakeOpencode({
    behave,
    fetchTools: (_url, init) => {
      assert.ok(app, "the app has not been built yet");
      return Promise.resolve(app.request("/api/hive-tools", init));
    },
  });

  // The room.
  let roomSide: RoomSide | null = null;
  let realtime: Realtime;
  const core = new ChatCore(memorySql(), {
    publish: (event) => void realtime.publish(event),
    runner: () => roomSide,
    stream: (channelId, message) => void realtime.stream(channelId, message),
    workspaceId: () => "w1",
    linkKey: () => "link-key",
  });
  realtime = new Realtime(core, () => []);
  await core.syncPeople(
    Object.values(people).map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );

  // The socket between them.
  const asked: string[] = [];
  const socket = (_url: string, protocols: string[]): SocketLike => {
    assert.equal(protocols[0], "hive.runner.v1");
    const sock: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (text) => {
        if (text === "ping") return sock.onmessage?.({ data: "pong" });
        void core.agent.onFrame(text);
      },
      close: () => undefined,
    };
    roomSide = {
      send: (text) => void sock.onmessage?.({ data: text }),
      close: (code, reason) => sock.onclose?.({ code, reason }),
    };
    queueMicrotask(() => sock.onopen?.({}));
    return sock;
  };
  const fetcher = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return Response.json({
      token: "runner-token",
      url: "wss://chat.test/w/w1/agent/v1/connect",
      expiresAt: Date.now() + 600_000,
    });
  }) as typeof fetch;

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
    chatRunner: { tokenUrl: "https://control.test/v1/release/w1/runner-token", key: "hwk_w1.key" },
  };
  const server = await createApp(db, config, { chatRunner: { fetcher, socket } });
  app = server.app;
  await server.opencode.start();
  t.after(async () => {
    await server.opencode.stop();
    await server.agent.stop();
    await opencode.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = (who: Who, method: string, path: string, body?: unknown) =>
    core.handle(
      new Request(`http://chat${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {
        sub: people[who].id,
        email: people[who].email,
        name: people[who].name,
        role: people[who].role,
        issuedAt: Date.now(),
      },
    );
  const channel = async (who: Who, name: string, visibility: "public" | "private" = "public") => {
    const made = (await (
      await call(who, "POST", "/v1/channels", { name, visibility })
    ).json()) as Channel;
    if (visibility === "public")
      for (const other of Object.keys(people) as Who[])
        if (other !== who && people[other].role !== "guest")
          await call(other, "POST", `/v1/channels/${made.id}/members`, {
            add: [people[other].email],
          });
    return made;
  };
  const post = async (who: Who, channelId: string, body: string, extra: object = {}) => {
    const response = await call(who, "POST", `/v1/channels/${channelId}/messages`, {
      body,
      ...extra,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as ChatMessage;
  };
  const replyTo = async (rootId: string, who: Who = "max") => {
    const { replies } = (await (
      await call(who, "GET", `/v1/messages/${rootId}/replies`)
    ).json()) as {
      replies: ChatMessage[];
    };
    const reply = replies.find((m) => m.author.kind === "agent");
    assert.ok(reply, "the agent replied");
    return reply;
  };
  const extra = (m: ChatMessage) => m.extra as AgentExtra;
  /** Wait for a condition, looking now and then. */
  const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ok()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`gave up waiting for ${what}`);
  };
  /** The machine has said hello and the room has taken it up. */
  await until("the machine to connect", async () => roomSide !== null);
  await until("the room to know the agent", async () =>
    Boolean(await core.store.get("system", "agent", "identity")),
  );
  const finished = async (rootId: string, who: Who = "max") => {
    await until("the run to end", async () => {
      const reply = await replyTo(rootId, who);
      return ["done", "failed", "stopped"].includes(extra(reply).status);
    });
    return replyTo(rootId, who);
  };
  return {
    core,
    db,
    dataDir,
    opencode,
    server,
    call,
    channel,
    post,
    replyTo,
    extra,
    until,
    finished,
    asked,
  };
}

test("a mention in a channel is answered in its thread, from the folder of that channel", async (t) => {
  const f = await wired(t, ({ say }) => say("The plan is to ship on Friday."));
  assert.deepEqual(f.asked, ["https://control.test/v1/release/w1/runner-token"]);
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
  const tasks = await f.db.list<{ title: string; channelId?: string; createdBy?: string }>(
    SHARED_OWNER,
    "tasks",
  );
  const owned = (
    await f.db.list<{ title: string; channelId?: string }>(people.max.id, "tasks")
  ).concat(tasks);
  const task = owned.find((x) => x.title === "Write the launch post");
  assert.ok(task, "the board has the item");
  assert.equal(task?.channelId, room.id);
});

test("the tools depend on the channel and the person: a private channel only reads, a guest only what a guest may", async (t) => {
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
  assert.deepEqual(offered, [["browse_web", "create_issue"], ["browse_web"], ["browse_web"]]);
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
