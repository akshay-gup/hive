import { DurableObject, type DurableObjectStorage } from "cloudflare:workers";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
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

/**
 * One workspace's chat: a Durable Object that owns its data. It keeps people's connections through the
 * hibernation API, so it can sleep (and cost nothing) between messages while they stay connected.
 */
interface RoomEnv {
  FILES?: { delete(keys: string | string[]): Promise<void> };
  FILE_LINK_KEY?: string;
}

export class ChatRoom extends DurableObject<RoomEnv> {
  private readonly room: RoomLogic;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: RoomEnv) {
    super(ctx, env);
    this.room = new RoomLogic(durableSql(ctx.storage), {
      purge: () => ctx.storage.deleteAll(),
      peers: () => this.peers(),
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

  private peers(): Peer[] {
    return this.ctx.getWebSockets().map((ws) => this.peer(ws));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return this.room.fetch(request);
    const identity = this.room.identityOf(request);
    if (identity instanceof Response) return identity;
    const Pair = (
      globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }
    ).WebSocketPair;
    const pair = new Pair();
    const server = pair[1] as WebSocket & { serializeAttachment(value: unknown): void };
    this.ctx.acceptWebSocket(server, [identity.sub]);
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") await this.room.realtime.receive(this.peer(ws), message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
