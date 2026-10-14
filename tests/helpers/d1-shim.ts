import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "../../apps/control/src/d1-store.ts";

const migration = readFileSync(
  new URL("../../apps/control/migrations/0001_records.sql", import.meta.url),
  "utf8",
);

/**
 * A D1 stand-in on Node's built-in SQLite, which is the engine D1 runs, with the control plane's
 * own migration applied. For tests: it keeps nothing after the process ends.
 */
export function memoryD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: unknown[] = [];
      const bound = {
        bind(...next: unknown[]) {
          values = next;
          return bound;
        },
        async all<T>() {
          const results = statement.all(...(values as never[])) as T[];
          return { results, success: true, meta: {} };
        },
      };
      return bound;
    },
  };
}
