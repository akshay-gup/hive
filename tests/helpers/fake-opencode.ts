import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What Hive prompted the session with. */
export interface FakePrompt {
  sessionID: string;
  directory: string;
  model?: { providerID: string; modelID: string };
  /** Everything Hive sent, as it was sent. */
  parts: { type: string; text?: string; synthetic?: boolean }[];
  /** What the person said: the last part of the prompt that is not Hive's own context. */
  text: string;
  /** Hive's context for the run (who is talking, which tools, the conversation so far). */
  context: string;
}

/** One prompt, and what the agent can do about it. */
export interface FakeTurn extends FakePrompt {
  /** 1 for the first prompt the server was given. */
  index: number;
  /** The Hive tools this run offered, by their own names. */
  tools: string[];
  /** Call a Hive tool the way OpenCode does: over HTTP, through the tool bridge. Throws if it fails. */
  call: (name: string, args?: unknown) => Promise<unknown>;
  /** Say something as the assistant. */
  say: (words: string) => void;
  /** Send any event OpenCode would. */
  emit: (event: { type: string; properties?: Record<string, unknown> }) => void;
}

export interface FakeOpencode {
  url: string;
  prompts: FakePrompt[];
  /** The sessions that were stopped. */
  aborted: string[];
  /** The answers Hive gave to what the agent asked: permissions and questions. */
  answered: { kind: "permission" | "question"; requestID: string; action: string; body: Body }[];
  close: () => Promise<void>;
}

/** The parts of a request body the fake reads. */
interface Body {
  title?: string;
  parts?: FakePrompt["parts"];
  model?: FakePrompt["model"];
  name?: string;
  reply?: string;
  answers?: string[][];
  config?: { url?: string; headers?: Record<string, string> };
}

const readBody = async (request: IncomingMessage): Promise<Body> => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
};

/**
 * A server that speaks OpenCode's HTTP API as far as Hive uses it: health, the global event stream,
 * sessions, prompts, and registering a tool server. What the agent does with a prompt is up to the
 * test, so everything between Hive and the wire is real: the SDK client, the event stream, and the
 * tool bridge, which the agent reaches over HTTP exactly as OpenCode does.
 *
 * When `behave` returns, the session goes idle. If it throws, the session reports an error.
 */
export async function fakeOpencode(options: {
  behave: (turn: FakeTurn) => void | Promise<void>;
  version?: string;
  /** Where the agent's tool calls go; defaults to the URL Hive registered. */
  fetchTools?: (url: string, init: RequestInit) => Promise<Response>;
  port?: number;
}): Promise<FakeOpencode> {
  const listeners = new Set<ServerResponse>();
  const sessions = new Map<string, { directory: string }>();
  const registered = new Map<
    string,
    Map<string, { name: string; url: string; headers: Record<string, string> }>
  >();
  const prompts: FakePrompt[] = [];
  const aborted: string[] = [];
  const answered: FakeOpencode["answered"] = [];
  let sessionCount = 0;
  let messageCount = 0;

  const publish = (directory: string, type: string, properties: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`;
    for (const listener of listeners) listener.write(frame);
  };
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };

  async function prompt(sessionID: string, directory: string, body: Body) {
    const parts = body.parts ?? [];
    const own = parts.filter((part) => part.type === "text" && !part.synthetic);
    const turn: FakePrompt = {
      sessionID,
      directory,
      model: body.model,
      parts,
      text: own.at(-1)?.text ?? "",
      context: parts.find((part) => part.synthetic)?.text ?? "",
    };
    prompts.push(turn);
    const emit = (type: string, properties: Record<string, unknown> = {}) =>
      publish(directory, type, { sessionID, ...properties });
    const tools = registered.get(directory);
    const server = tools ? [...tools.values()].at(-1) : undefined;
    const rpc = async (method: string, params: unknown = {}) => {
      if (!server) throw new Error("No tools were registered for this session");
      const send = options.fetchTools ?? fetch;
      const response = await send(server.url, {
        method: "POST",
        headers: { ...server.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await response.json()) as {
        result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
        error?: { message?: string } | string;
      };
    };
    const offered = server
      ? ((await rpc("tools/list")).result?.tools ?? []).map((tool) => tool.name)
      : [];
    let calls = 0;
    const messageID = `msg_${++messageCount}`;
    let said = false;
    const announce = () => {
      if (said) return;
      said = true;
      emit("message.updated", { info: { id: messageID, role: "assistant", sessionID } });
    };
    const part = (state: Record<string, unknown>, callID: string, tool: string) => {
      announce();
      emit("message.part.updated", {
        part: { id: `prt_${callID}`, messageID, type: "tool", callID, tool, state },
      });
    };
    const fake: FakeTurn = {
      ...turn,
      index: prompts.length,
      tools: offered,
      emit: (event) => emit(event.type, event.properties),
      say: (words) => {
        announce();
        emit("message.part.updated", {
          part: { id: `prt_text_${messageID}`, messageID, type: "text", text: words },
        });
      },
      call: async (name, args = {}) => {
        const callID = `call_${messageCount}_${++calls}`;
        // OpenCode names a tool for the server that offers it.
        const tool = `${server?.name}_${name}`;
        part({ status: "running", input: args }, callID, tool);
        const reply = await rpc("tools/call", { name, arguments: args });
        const text = reply.result?.content?.[0]?.text ?? "null";
        if (reply.error || reply.result?.isError) {
          const message =
            typeof reply.error === "string" ? reply.error : (reply.error?.message ?? text);
          part({ status: "error", input: args, error: message }, callID, tool);
          throw new Error(message);
        }
        part({ status: "completed", input: args, output: text }, callID, tool);
        return JSON.parse(text);
      },
    };
    try {
      await options.behave(fake);
      emit("session.idle");
    } catch (error) {
      // The shape OpenCode sends: the message is under `data`, and the error has a name.
      emit("session.error", {
        error: {
          name: "UnknownError",
          data: { message: error instanceof Error ? error.message : String(error) },
        },
      });
    }
  }

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fake");
      const directory =
        url.searchParams.get("directory") ??
        decodeURIComponent(String(request.headers["x-opencode-directory"] ?? ""));
      const path = url.pathname;
      if (request.method === "GET" && path === "/global/health")
        return json(response, { healthy: true, version: options.version ?? "1.18.33" });
      if (request.method === "GET" && path === "/global/event") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`,
        );
        listeners.add(response);
        const beat = setInterval(() => response.write(": ping\n\n"), 10_000);
        response.on("close", () => {
          clearInterval(beat);
          listeners.delete(response);
        });
        return;
      }
      if (request.method === "POST" && path === "/session") {
        const body = await readBody(request);
        const id = `ses_fake_${++sessionCount}`;
        sessions.set(id, { directory });
        return json(response, { id, title: body.title ?? "", directory });
      }
      const session = /^\/session\/([^/]+)(?:\/(prompt_async|abort))?$/.exec(path);
      if (session) {
        const [, id, action] = session;
        if (!sessions.has(id)) return json(response, { error: "Session not found" }, 404);
        if (request.method === "GET" && !action) return json(response, { id, directory });
        if (request.method === "PATCH" && !action) return json(response, { id, directory });
        if (request.method === "POST" && action === "abort") {
          aborted.push(id);
          return json(response, true);
        }
        if (request.method === "POST" && action === "prompt_async") {
          const body = await readBody(request);
          response.writeHead(204).end();
          void prompt(id, sessions.get(id)?.directory || directory, body);
          return;
        }
      }
      const answer = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(path);
      if (request.method === "POST" && answer) {
        const body = await readBody(request);
        answered.push({
          kind: answer[1] as "permission" | "question",
          requestID: decodeURIComponent(answer[2] ?? ""),
          action: answer[3] ?? "",
          body,
        });
        return json(response, true);
      }
      if (request.method === "POST" && path === "/mcp") {
        const body = await readBody(request);
        const servers = registered.get(directory) ?? new Map();
        servers.set(body.name, {
          name: body.name,
          url: body.config?.url,
          headers: body.config?.headers ?? {},
        });
        registered.set(directory, servers);
        return json(
          response,
          Object.fromEntries([...servers.keys()].map((name) => [name, { status: "connected" }])),
        );
      }
      json(response, { error: `Not found: ${request.method} ${path}` }, 404);
    } catch (error) {
      json(response, { error: String(error) }, 500);
    }
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    aborted,
    answered,
    close: async () => {
      for (const listener of listeners) listener.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
