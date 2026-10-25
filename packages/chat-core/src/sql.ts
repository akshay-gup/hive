/**
 * What the chat code needs of a SQLite database, in the shape a Durable Object's storage gives it:
 * statements run at once, and a transaction is a function that runs without anything else going in
 * between. A Durable Object adapter (`apps/chat/src/room.ts`) and the test shim
 * (`tests/helpers/do-shim.ts`) each provide one.
 *
 * Bind only strings, numbers and null: a Durable Object's SQLite takes nothing else.
 */
export interface Sql {
  /** Run a statement and return the rows it gives (none, for one that writes). */
  all<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
  /** Run a statement and return how many rows it changed. */
  run(query: string, ...bindings: unknown[]): number;
  /** Run `work` as one unit: whatever it wrote stays only if it returns, and is undone if it throws. */
  transaction<T>(work: () => T): T;
}

/** The first row a statement gives, or undefined. */
export function first<T = Record<string, unknown>>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T | undefined {
  return sql.all<T>(query, ...bindings)[0];
}
