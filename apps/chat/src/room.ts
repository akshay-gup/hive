import { DurableObject, type DurableObjectStorage } from "cloudflare:workers";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
import { verifyChatRunner } from "../../../packages/integrations/src/workspace-token.ts";
import type { RunnerLink } from "./agent-link.ts";
import { DeletedMarker } from "./deleted-marker.ts";
import { INTERNAL_HEADER, RUNNER_HEADER } from "./headers.ts";
import type { Peer } from "./realtime.ts";
import { RoomLogic } from "./room-logic.ts";

/** A Durable Object's SQLite as the `Sql` the chat code takes. */
export function durableSql(storage: DurableObjectStorage): Sql {
  let depth = 0;
  return {
    all: <T>(query: string, ...bindings: unknown[]) =>
      storage.sql.exec<T>(query, ...bindings).toArray(),
    run(query: string, ...bindings: unknown[]) {
      storage.sql.exec(query, ...bindings).toArray();
      // The rows the statement changed (not `rowsWritten`, which counts index rows too).
      return storage.sql.exec<{ n: number }>("SELECT changes() AS n").one().n;
    },
    transaction<T>(work: () => T): T {
      // One inside another is part of it, as in the test shim.
      if (depth > 0) return work();
      depth++;
      try {
        return storage.transactionSync(work);
      } finally {
        depth--;
      }
    },
  };
}

/** What is kept with a connection while the object sleeps: who it is and when their token runs out. */
interface Attachment {
  sub: string;
  exp: number;
}

/** The tag of a person's connection, and of the agent machine's: the two never receive each other's. */
const PERSON = "person";
const RUNNER = "runner";
/** The runner's connection ends with this when another connection took its place. */
const CLOSE_REPLACED = 4409;
const CLOSE_RUNNER_EXPIRED = 4401;

/**
 * One workspace's chat: a Durable Object that owns its data. It keeps people's connections through the
 * hibernation API, so it can sleep (and cost nothing) between messages while they stay connected.
 */
interface RoomEnv {
  FILES?: {
    delete(keys: string | string[]): Promise<void>;
    list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
      objects: { key: string }[];
      truncated: boolean;
      cursor?: string;
    }>;
  };
  FILE_LINK_KEY?: string;
  /** The control plane's public key: the agent's machine renews its token in-band, so the room checks it too. */
  CONTROL_PUBLIC_KEY?: string;
  /** Where the control plane is, and the key that proves to it that the room is asking: to wake the agent's machine. */
  CONTROL_URL?: string;
  CHAT_WAKE_KEY?: string;
}

/** HMAC-SHA256 of a text, as hex. */
async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ChatRoom extends DurableObject<RoomEnv> {
  private readonly room: RoomLogic;
  private readonly marker: DeletedMarker;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: RoomEnv) {
    super(ctx, env);
    this.marker = new DeletedMarker(ctx.storage);
    this.room = new RoomLogic(durableSql(ctx.storage), {
      purge: async () => {
        // The workspace's files in the bucket go first, while the room still knows which they are.
        const workspace = this.room.workspaceId();
        if (workspace && env.FILES) {
          let cursor: string | undefined;
          do {
            const page = await env.FILES.list({ prefix: `w/${workspace}/`, cursor, limit: 500 });
            if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
        }
        await this.marker.wipe(async () => {
          for (const socket of ctx.getWebSockets()) {
            try {
              socket.close(1008, "This workspace has been deleted");
            } catch {
              // Already closed.
            }
          }
        });
      },
      peers: () => this.peers(),
      runner: () => this.runner(),
      wake: () => ctx.waitUntil(this.wake()),
      keepAlive: (work) => ctx.waitUntil(work),
      linkKey: () => env.FILE_LINK_KEY,
      deleteObjects: async (keys) => {
        await env.FILES?.delete(keys);
      },
      wakeIn: (ms) => ctx.waitUntil(this.wakeIn(ms)),
    });
    // A heartbeat from the app is answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new (
        globalThis as unknown as {
          WebSocketRequestResponsePair: new (a: string, b: string) => unknown;
        }
      ).WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /** Ask to be woken for upkeep in `ms`, unless an earlier wake is already asked for. */
  private async wakeIn(ms: number): Promise<void> {
    const at = Date.now() + ms;
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    // A deleted workspace has no upkeep: only its marker, which goes when it has done its work.
    if (await this.marker.upkeep()) return;
    const { nextInMs } = await this.room.maintain();
    await this.ctx.storage.setAlarm(Date.now() + nextInMs);
  }

  private peer(ws: WebSocket): Peer {
    const attached = (
      ws as unknown as { deserializeAttachment(): Attachment }
    ).deserializeAttachment();
    return {
      id: attached.sub,
      exp: attached.exp,
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
    };
  }

  /** Only people: the agent's machine is not someone events are sent to. */
  private peers(): Peer[] {
    return this.ctx.getWebSockets(PERSON).map((ws) => this.peer(ws));
  }

  /** The agent's machine, if it holds a live connection. */
  private runner(): RunnerLink | null {
    const sockets = this.ctx.getWebSockets(RUNNER);
    const ws = sockets[sockets.length - 1];
    if (!ws) return null;
    const exp = (ws as unknown as { deserializeAttachment(): Attachment }).deserializeAttachment()
      .exp;
    if (Date.now() >= exp) {
      this.closeRunner(ws, "Token ran out");
      return null;
    }
    return { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) };
  }

  private closeRunner(ws: WebSocket, reason: string) {
    try {
      ws.close(CLOSE_RUNNER_EXPIRED, reason);
    } catch {
      // Already closed.
    }
  }

  /** Ask the control plane to start the agent's machine. It is asked for in the background; if it fails the run waits and fails in time. */
  private async wake(): Promise<void> {
    const workspace = this.room.workspaceId();
    const { CONTROL_URL: url, CHAT_WAKE_KEY: key } = this.env;
    if (!workspace || !url || !key) return;
    try {
      const at = String(Date.now());
      const mac = await hmacHex(key, `wake\n${workspace}\n${at}`);
      await fetch(`${url}/internal/chat/wake/${encodeURIComponent(workspace)}`, {
        method: "POST",
        headers: { "x-hive-at": at, "x-hive-mac": mac },
      });
    } catch (error) {
      console.error(`[Hive chat] could not wake the agent: ${String(error)}`);
    }
  }

  /** The agent's machine connects: it replaces any other, and says hello for the room to know what it is working on. */
  private acceptRunner(request: Request): Response {
    const given = request.headers.get(RUNNER_HEADER);
    const exp = Number(given);
    if (!given || !Number.isFinite(exp))
      return Response.json({ error: "Not allowed" }, { status: 401 });
    const Pair = (
      globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }
    ).WebSocketPair;
    const pair = new Pair();
    const server = pair[1] as WebSocket & { serializeAttachment(value: unknown): void };
    for (const old of this.ctx.getWebSockets(RUNNER)) {
      try {
        old.close(CLOSE_REPLACED, "Another connection took over");
      } catch {
        // Already closed.
      }
    }
    this.ctx.acceptWebSocket(server, [RUNNER]);
    server.serializeAttachment({ sub: "runner", exp } satisfies Attachment);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "hive.runner.v1" },
    } as ResponseInit);
  }

  async fetch(request: Request): Promise<Response> {
    // Nothing is answered for a deleted workspace, and a second delete has nothing left to do.
    if (await this.marker.deleted())
      return request.headers.get(INTERNAL_HEADER) === "purge"
        ? Response.json({ ok: true })
        : Response.json({ error: "This workspace has been deleted." }, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return this.room.fetch(request);
    if (request.headers.get(RUNNER_HEADER)) return this.acceptRunner(request);
    const identity = this.room.identityOf(request);
    if (identity instanceof Response) return identity;
    const Pair = (
      globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }
    ).WebSocketPair;
    const pair = new Pair();
    const server = pair[1] as WebSocket & { serializeAttachment(value: unknown): void };
    this.ctx.acceptWebSocket(server, [PERSON, identity.sub]);
    server.serializeAttachment({
      sub: identity.sub,
      exp: identity.expiresAt ?? Date.now() + 600_000,
    } satisfies Attachment);
    // The room knows this person from their token before they ask for anything.
    await this.room.core.syncPerson(identity);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "hive.v1" },
    } as ResponseInit);
  }

  /** The agent's machine sent something: a new token, or a frame for the agent to act on. */
  private async runnerMessage(ws: WebSocket, message: string): Promise<void> {
    const attached = (
      ws as unknown as { deserializeAttachment(): Attachment }
    ).deserializeAttachment();
    if (Date.now() >= attached.exp) return this.closeRunner(ws, "Token ran out");
    // Only the newest connection is heard.
    const sockets = this.ctx.getWebSockets(RUNNER);
    if (sockets[sockets.length - 1] !== ws) return;
    let renew: { t?: string; token?: string } | null = null;
    if (message.length < 8_000 && message.includes('"renew"')) {
      try {
        renew = JSON.parse(message) as { t?: string; token?: string };
      } catch {
        return;
      }
    }
    if (renew?.t === "renew") {
      const workspace = this.room.workspaceId();
      const key = this.env.CONTROL_PUBLIC_KEY;
      if (!workspace || !key || !renew.token) return;
      try {
        const { expiresAt } = verifyChatRunner(key, renew.token, { workspaceId: workspace });
        (ws as unknown as { serializeAttachment(value: unknown): void }).serializeAttachment({
          sub: "runner",
          exp: expiresAt,
        } satisfies Attachment);
      } catch {
        // A token that does not check changes nothing; the old one runs out in its time.
      }
      return;
    }
    await this.room.core.agent.onFrame(message);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (this.ctx.getTags(ws).includes(RUNNER)) return this.runnerMessage(ws, message);
    await this.room.realtime.receive(this.peer(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    // When the agent's machine goes, what was sent to it and not taken waits for the next.
    if (
      this.ctx.getTags(ws).includes(RUNNER) &&
      this.ctx.getWebSockets(RUNNER).every((other) => other === ws)
    )
      await this.room.core.agent.disconnected();
  }
}
