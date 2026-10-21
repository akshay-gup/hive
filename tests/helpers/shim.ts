import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Hono } from "hono";
import { createApp } from "../../apps/server/src/app.ts";
import type { JevAdapter } from "../../apps/server/src/jev/adapter.ts";
import { opencodeShimRoutes, PermissionRulesStore } from "../../apps/server/src/opencode/index.ts";
import { browserFixture } from "./browser.ts";
import { type AgentTurn, opencodeStandIn } from "./opencode.ts";

/** One AG-UI event the shim sent. */
export interface ShimEvent {
  type: string;
  [key: string]: unknown;
}

/** A tool call as the chat sees it: what was asked, and what came back. */
export interface ShownToolCall {
  name: string;
  args: unknown;
  /** The result as the client receives it, parsed when it is JSON. */
  result: unknown;
  /** The result exactly as sent. */
  content: string;
}

const pageOf = () => ({
  data: { url: "https://example.org", title: "Example", text: "Observed", truncated: false },
});

/**
 * The chat path as production wires it: a real app and store, the real AG-UI shim and the real tool
 * bridge, with a stand-in where OpenCode would be. Give the agent something to do with
 * `whenPrompted()`, then `run()` a message as the person would send it and read what the chat receives.
 */
export async function shimFixture(
  t: TestContext,
  options: {
    jevMode?: "sample" | "live";
    jevAdapter?: JevAdapter;
    /** What the browser worker answers; a page the agent can read by default. */
    browse?: Parameters<typeof browserFixture>[1];
  } = {},
) {
  const browser = await browserFixture(t, options.browse ?? pageOf);
  const config = { ...browser.config, model: "openai/fixture", jevMode: options.jevMode };
  const server = await createApp(browser.db, config, { jevAdapter: options.jevAdapter });
  t.after(() => server.agent.stop());
  await server.workspace.ensureSample("local-user", server.actions);
  const standIn = opencodeStandIn({ dataDir: config.dataDir, model: config.model });
  const shim = new Hono<{ Variables: { owner: string } }>();
  // Whoever signs in is read from a header here; the app derives it from the session.
  shim.use("*", async (c, next) => {
    c.set("owner", c.req.header("x-test-owner") ?? "local-user");
    await next();
  });
  shim.route(
    "/",
    opencodeShimRoutes({
      service: server.agent,
      bus: standIn.runtime.bus,
      pool: standIn.runtime.pool,
      config,
      tracker: standIn.runtime.tracker,
      rules: new PermissionRulesStore(config.dataDir),
      hiveTools: standIn.runtime.hiveTools,
    } as unknown as Parameters<typeof opencodeShimRoutes>[0]),
  );

  /** What the agent does when it is prompted. Its tool calls reach the chat as they do from OpenCode. */
  const whenPrompted = (handler: (turn: AgentTurn) => void | Promise<void>) =>
    standIn.agent(async (turn) => {
      let calls = 0;
      const call = async (name: string, args: unknown = {}) => {
        const callID = `call-${++calls}`;
        const part = (state: Record<string, unknown>) =>
          turn.emit({
            type: "message.part.updated",
            properties: {
              part: {
                id: `part-${callID}`,
                messageID: "m-tools",
                type: "tool",
                callID,
                tool: `hive_0123456789abcdef_${name}`,
                state,
              },
            },
          });
        part({ status: "running", input: args });
        try {
          const result = await turn.call(name, args);
          part({ status: "completed", input: args, output: JSON.stringify(result) });
          return result;
        } catch (error) {
          part({ status: "error", input: args, error: String(error) });
          throw error;
        }
      };
      await handler({ ...turn, call });
    });

  /** Send a message to the chat, as the client does, and collect what comes back. */
  async function run(
    message: string | { role: string; content: string }[],
    run: { threadId?: string; runId?: string; signal?: AbortSignal; owner?: string } = {},
  ) {
    const messages = (
      typeof message === "string" ? [{ role: "user", content: message }] : message
    ).map((item) => ({ id: randomUUID(), ...item }));
    const response = await shim.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": run.owner ?? "local-user" },
      body: JSON.stringify({
        threadId: run.threadId ?? "thread-1",
        runId: run.runId ?? randomUUID(),
        messages,
      }),
      signal: run.signal,
    });
    const events = (await response.text())
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as ShimEvent);
    const tools: ShownToolCall[] = events
      .filter((event) => event.type === "TOOL_CALL_START")
      .map((start) => {
        const args = events.find(
          (event) => event.type === "TOOL_CALL_ARGS" && event.toolCallId === start.toolCallId,
        )?.delta;
        const content = String(
          events.find(
            (event) => event.type === "TOOL_CALL_RESULT" && event.toolCallId === start.toolCallId,
          )?.content ?? "",
        );
        let result: unknown = content;
        try {
          result = JSON.parse(content);
        } catch {}
        return {
          name: String(start.toolCallName),
          args: typeof args === "string" ? JSON.parse(args) : undefined,
          result,
          content,
        };
      });
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    return { status: response.status, events, tools, text, last: events.at(-1)?.type };
  }

  /** Press Stop on a thread, as the client does. */
  async function stop(threadId = "thread-1") {
    return shim.request("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": "local-user" },
      body: JSON.stringify({ threadId }),
    });
  }

  return { ...server, browser, db: browser.db, config, standIn, whenPrompted, run, stop };
}
