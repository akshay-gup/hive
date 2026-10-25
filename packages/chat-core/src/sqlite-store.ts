import type { Sql } from "./sql.ts";
import type { RecordStore } from "./store.ts";

type Scalar = string | number | boolean | null;

/** A field name goes into the SQL text (so an index on it can be used), which is only safe for plain names. */
function jsonPath(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Not a field name: ${field}`);
  return `json_extract(data, '$.${field}')`;
}

/**
 * The chat records (channels, people, notification settings: what is small and read as a whole) in a
 * SQLite table of owner, kind, id and a JSON document. The same behaviour as the control plane's
 * `D1Store`, for the calls the permission code makes; the same two differences from the server's
 * Postgres `Store` apply: `compareAndSwap` treats a field that is missing as equal to null and only
 * compares plain values, and a patched field set to null is removed instead of kept as null.
 *
 * The statements are synchronous, so a call is never interrupted by another: that is what makes a
 * `compareAndSwap` inside a Durable Object an honest one.
 */
export class SqliteRecordStore implements RecordStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private data<T>(query: string, ...params: unknown[]): T | null {
    const [row] = this.sql.all<{ data: string }>(query, ...params);
    return row ? (JSON.parse(row.data) as T) : null;
  }

  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    return this.data<T>(
      "SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?",
      owner,
      kind,
      id,
    );
  }

  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    return this.sql
      .all<{ data: string }>(
        "SELECT data FROM records WHERE owner = ? AND kind = ? ORDER BY updated_at DESC, id",
        owner,
        kind,
      )
      .map((row) => JSON.parse(row.data) as T);
  }

  async listWhere<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
  ): Promise<T[]> {
    return this.sql
      .all<{ data: string }>(
        `SELECT data FROM records WHERE owner = ? AND kind = ? AND ${jsonPath(field)} = ? ORDER BY updated_at DESC, id`,
        owner,
        kind,
        value,
      )
      .map((row) => JSON.parse(row.data) as T);
  }

  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    this.sql.run(
      "INSERT INTO records (owner, kind, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      owner,
      kind,
      value.id,
      JSON.stringify(value),
      this.now(),
    );
    return value;
  }

  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    return this.data<T>(
      "INSERT INTO records (owner, kind, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING data",
      owner,
      kind,
      value.id,
      JSON.stringify(value),
      this.now(),
    );
  }

  async remove(owner: string, kind: string, id: string): Promise<void> {
    this.sql.run("DELETE FROM records WHERE owner = ? AND kind = ? AND id = ?", owner, kind, id);
  }

  async removeBelow(owner: string, kind: string, field: string, limit: number): Promise<number> {
    const path = jsonPath(field);
    return this.sql.all(
      `DELETE FROM records WHERE owner = ? AND kind = ? AND json_type(data, '$.${field}') IN ('integer', 'real') AND ${path} < ? RETURNING id`,
      owner,
      kind,
      limit,
    ).length;
  }

  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    return this.data<T>(
      "DELETE FROM records WHERE owner = ? AND kind = ? AND id = ? RETURNING data",
      owner,
      kind,
      id,
    );
  }

  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const tests: string[] = [];
    const params: unknown[] = [JSON.stringify(patch), this.now(), owner, kind, id];
    for (const [field, value] of Object.entries(expected)) {
      if (value !== null && typeof value === "object")
        throw new Error(`compareAndSwap compares plain values, not ${field}`);
      tests.push(`${jsonPath(field)} IS ?`);
      const plain = value as Scalar | undefined;
      params.push(typeof plain === "boolean" ? (plain ? 1 : 0) : (plain ?? null));
    }
    return this.data<T>(
      `UPDATE records SET data = json_patch(data, ?), updated_at = ? WHERE owner = ? AND kind = ? AND id = ?${tests.map((test) => ` AND ${test}`).join("")} RETURNING data`,
      ...params,
    );
  }

  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    return this.sql
      .all<{ owner: string; data: string }>(
        "SELECT owner, data FROM records WHERE kind = ? ORDER BY updated_at ASC",
        kind,
      )
      .map((row) => ({ owner: row.owner, value: JSON.parse(row.data) as T }));
  }
}
