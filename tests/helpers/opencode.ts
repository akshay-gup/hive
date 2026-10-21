import { HiveToolBridge } from "../../apps/server/src/opencode/hive-tools.ts";

export interface Prompt {
  sessionID: string;
  model?: { providerID: string; modelID: string };
  tools?: Record<string, boolean>;
  parts: { type: string; text: string; synthetic?: boolean }[];
}

/** What the stand-in agent can do when it is prompted: call Hive's tools, speak, and stop. */
export interface AgentTurn {
  prompt: Prompt;
  /** 1 for the task's own prompt, then one for each update sent while it works. */
  index: number;
  /** The names of the Hive tools the run offered. */
  tools: string[];
  /** Call a Hive tool the way OpenCode does, through the tool bridge. Throws what the tool reported if it failed. */
  call: (name: string, args?: unknown) => Promise<unknown>;
  /** Say something as the assistant. */
  say: (words: string, messageID?: string) => void;
  /** Send any event OpenCode would, such as a tool call as it runs. */
  emit: (event: Record<string, unknown>) => void;
  /** Stop: the session has nothing left to do. */
  idle: () => void;
}

/**
 * A stand-in for the OpenCode server, for tests of what Hive does around an agent run: the tools it
 * is offered, what it is told, and what becomes of what it does. Hive's own side is real, down to
 * the tool bridge: the agent calls tools by name over the same JSON-RPC OpenCode speaks, so
 * argument checks and results are the real ones.
 *
 * Assign `runtime` to `service.opencodeRuntime`, then give the agent something to do with `agent()`.
 */
export function opencodeStandIn(options: { dataDir: string; model?: string }) {
  const prompts: Prompt[] = [];
  const bridge = new HiveToolBridge("http://localhost:8787/api/hive-tools");
  let listener: (event: unknown) => void = () => {};
  let lease: { name: string; token: string } | undefined;
  let offered: string[] = [];
  let handler: (turn: AgentTurn) => void | Promise<void> = () => {};
  let todos: unknown[] = [];
  const emit = (event: Record<string, unknown>) => listener({ id: "e", properties: {}, ...event });
  const say = (words: string, messageID = `m${prompts.length}`) => {
    emit({ type: "message.updated", properties: { info: { id: messageID, role: "assistant" } } });
    emit({
      type: "message.part.updated",
      properties: { part: { id: `p-${messageID}`, messageID, type: "text", text: words } },
    });
  };
  const idle = () => emit({ type: "session.idle" });
  const rpc = async (method: string, params: unknown = {}) => {
    if (!lease) throw new Error("The run has not offered any tools");
    const response = await bridge.routes.request("/", {
      method: "POST",
      headers: { Authorization: `Bearer ${lease.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return response.json() as Promise<{
      result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
      error?: { message: string };
    }>;
  };
  const call = async (name: string, args: unknown = {}) => {
    const reply = await rpc("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(reply.error.message);
    const text = reply.result?.content?.[0]?.text ?? "null";
    if (reply.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const client = {
    session: {
      create: async () => ({ data: { id: "ses-1" } }),
      get: async () => ({ data: { id: "ses-1" } }),
      promptAsync: async (prompt: Prompt) => {
        prompts.push(prompt);
        await handler({ prompt, index: prompts.length, tools: offered, call, say, emit, idle });
        return {};
      },
      abort: async () => ({}),
      todo: async () => ({ data: todos }),
    },
    mcp: {
      add: async (request: { name: string; config: { headers: { Authorization: string } } }) => {
        lease = { name: request.name, token: request.config.headers.Authorization.slice(7) };
        return { data: { [request.name]: { status: "connected" } } };
      },
    },
  };
  const runtime = {
    config: { dataDir: options.dataDir, model: options.model ?? "anthropic/claude-test" },
    pool: { forDirectory: () => client },
    tracker: { record: () => {}, remove: () => true, rejectAllForScope: async () => 0 },
    bus: {
      track: () => {},
      onEvent: (_scope: string, next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
      waitForConnection: async () => {},
      enqueue: async (_scope: string, action: () => unknown) => action(),
    },
    // Reads which tools were offered as soon as the run connects them.
    hiveTools: {
      connect: async (...args: Parameters<HiveToolBridge["connect"]>) => {
        const connected = await bridge.connect(...args);
        offered = (await rpc("tools/list")).result?.tools?.map((tool) => tool.name) ?? [];
        return connected;
      },
    },
    steer: { pollMs: 25, settleMs: 5 },
  };
  return {
    runtime,
    prompts,
    /** What the agent does each time it is prompted. */
    agent: (next: (turn: AgentTurn) => void | Promise<void>) => {
      handler = next;
    },
    /** The todo list the session already holds when a run starts (a session picked up again has one). */
    setTodos: (list: unknown[]) => {
      todos = list;
    },
    /** Forget the prompts so far, for a second run in the same test. */
    reset: () => {
      prompts.length = 0;
      offered = [];
    },
  };
}
