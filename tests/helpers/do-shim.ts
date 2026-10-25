import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../packages/chat-core/src/schema.ts";
import type { Sql } from "../../packages/chat-core/src/sql.ts";

/**
 * A Durable Object's SQLite on Node's built-in SQLite (the engine a Durable Object runs), as the
 * `Sql` the chat code takes. Nothing is kept after the process ends. A transaction inside a
 * transaction is part of the outer one, as it is in a Durable Object.
 */
export function memorySql(options: { migrated?: boolean } = {}): Sql {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const sql: Sql = {
    all<T>(query: string, ...bindings: unknown[]) {
      return db.prepare(query).all(...(bindings as never[])) as T[];
    },
    run(query: string, ...bindings: unknown[]) {
      return Number(db.prepare(query).run(...(bindings as never[])).changes);
    },
    transaction<T>(work: () => T): T {
      if (depth > 0) return work();
      depth++;
      db.exec("BEGIN");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
  };
  if (options.migrated !== false) migrate(sql);
  return sql;
}
