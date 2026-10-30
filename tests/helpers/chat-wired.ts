import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { RunnerLink as RoomSide } from "../../apps/chat/src/agent-link.ts";
import { ChatCore } from "../../apps/chat/src/core.ts";
import { Realtime } from "../../apps/chat/src/realtime.ts";
import { createApp } from "../../apps/server/src/app.ts";
import type { SocketLike } from "../../apps/server/src/chat-runner/link.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { createStore } from "../../apps/server/src/db.ts";
import type { JevAdapter } from "../../apps/server/src/jev/adapter.ts";
import type { Channel } from "../../packages/domain/src/agent.ts";
import type { ChatMessage } from "../../packages/domain/src/chat.ts";
import type { AgentExtra } from "../../packages/domain/src/chat-agent.ts";
import { browserWorker } from "./browser.ts";
import { memorySql } from "./do-shim.ts";
import { type FakeTurn, fakeOpencode } from "./fake-opencode.ts";

export const people = {
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const;
export type Who = keyof typeof people;

/**
 * The agent's machine against the chat service's room, with nothing between them but the socket: a real
 * room (`ChatCore`), the real server with its runner (host, tools, sessions), and OpenCode's HTTP API
 * played by a stand-in. Only what the agent decides to do, and what people click, is the test's.
 */
export async function wired(
  t: TestContext,
  behave: (turn: FakeTurn) => void | Promise<void>,
  options: Partial<Config> & {
    jevAdapter?: JevAdapter;
    /** What a browser worker answers, if the agent is to browse. */
    browse?: Parameters<typeof browserWorker>[1];
  } = {},
) {
  const { jevAdapter, browse, ...overrides } = options;
  const worker = browse ? await browserWorker(t, browse) : {};
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
  /** The bytes of files the bucket would hold, by file id (the test puts them here). */
  const stored = new Map<string, Uint8Array>();
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
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    // The Worker's side of sending a file: the bytes arrive, and the room is told how many.
    const upload = /^https:\/\/chat\.test\/w\/w1\/f\/up\/([^/?]+)\?/.exec(String(url));
    if (upload && init?.method === "PUT") {
      const bytes = (init.body as Uint8Array).length;
      core.filing.uploaded(decodeURIComponent(upload[1] ?? ""), "file", bytes);
      return Response.json({ ok: true, bytes });
    }
    // The Worker's side of fetching one: the bytes the test put there.
    const download = /^https:\/\/chat\.test\/w\/w1\/f\/dl\/([^/?]+)\?/.exec(String(url));
    if (download) {
      const bytes = stored.get(decodeURIComponent(download[1] ?? ""));
      return bytes ? new Response(bytes as BodyInit) : new Response("gone", { status: 404 });
    }
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
    ...worker,
    ...overrides,
  };
  const server = await createApp(db, config, { chatRunner: { fetcher, socket }, jevAdapter });
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
  /** A person's own conversation with the agent. */
  const own = async (who: Who = "max") => {
    const mine = ((await (await call(who, "GET", "/v1/channels")).json()) as Channel[]).find(
      (c) => c.kind === "personal",
    );
    assert.ok(mine, "they have a conversation of their own");
    return mine;
  };
  const agentReplies = (channelId: string) =>
    core.messages.page(channelId, { limit: 100 }).messages.filter((m) => m.authorKind === "agent");
  /** What the agent did with its tools in a reply, as the app shows it: what it asked and what came back. */
  const toolsShown = (reply: { extra?: unknown }) => {
    const steps = ((reply.extra as AgentExtra | undefined)?.steps ?? []) as {
      role: string;
      toolCalls?: { id: string; function: { name: string; arguments: string } }[];
      toolCallId?: string;
      content?: string;
    }[];
    return steps
      .flatMap((step) => step.toolCalls ?? [])
      .map((made) => {
        const content =
          steps.find((step) => step.role === "tool" && step.toolCallId === made.id)?.content ?? "";
        let result: unknown = content;
        try {
          result = JSON.parse(content);
        } catch {}
        return {
          name: made.function.name,
          args: made.function.arguments ? JSON.parse(made.function.arguments) : undefined,
          result,
          content,
        };
      });
  };
  /** Say something in a person's own chat, and wait for the agent to finish answering it. */
  const say = async (who: Who, channelId: string, body: string) => {
    const before = agentReplies(channelId).length;
    await post(who, channelId, body);
    await until("the agent to answer", () => {
      const replies = agentReplies(channelId);
      const last = replies.at(-1);
      return (
        replies.length > before &&
        !!last &&
        ["done", "failed", "stopped"].includes((last.extra as AgentExtra).status)
      );
    });
    const reply = agentReplies(channelId).at(-1) as NonNullable<ReturnType<typeof agentReplies>[0]>;
    const status = (reply.extra as AgentExtra).status;
    return { reply, status, text: reply.body, tools: toolsShown(reply) };
  };
  return {
    own,
    say,
    toolsShown,
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
    stored,
  };
}
