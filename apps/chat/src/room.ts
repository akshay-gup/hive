import { DurableObject, type DurableObjectStorage } from "cloudflare:workers";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
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

/** One workspace's chat: a Durable Object that owns its data. */
export class ChatRoom extends DurableObject<unknown> {
  private readonly room: RoomLogic;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: unknown) {
    super(ctx, env);
    this.room = new RoomLogic(durableSql(ctx.storage), { purge: () => ctx.storage.deleteAll() });
  }

  fetch(request: Request): Promise<Response> {
    return this.room.fetch(request);
  }
}
