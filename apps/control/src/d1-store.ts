import type { ControlStore } from "./store.ts";

/** The part of Cloudflare's D1 binding this uses. */
export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes?: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

type Scalar = string | number | boolean | null;

/** A field name goes into the SQL text (so an index on it can be used), which is only safe for plain names. */
function jsonPath(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Not a field name: ${field}`);
  return `json_extract(data, '$.${field}')`;
}

/**
 * The control plane's records in D1 (SQLite): the same table and the same behaviour as the
 * Postgres `Store`, for the calls the control plane makes.
 *
 * Two differences, neither of which the control plane depends on: `compareAndSwap` treats a field
 * that is missing as equal to null, and only compares fields holding a string, number, boolean or
 * null; and a patched field set to null is removed instead of kept as null.
 */
export class D1Store implements ControlStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  private async rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return (
      await this.db
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }
  private async data<T>(sql: string, params: unknown[]): Promise<T | null> {
    const [row] = await this.rows<{ data: string }>(sql, params);
    return row ? (JSON.parse(row.data) as T) : null;
  }

  get<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null> {
    return this.data<T>("SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?", [
      owner,
      kind,
      id,
    ]);
  }

  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const rows = await this.rows<{ data: string }>(
      "SELECT data FROM records WHERE owner = ? AND kind = ? ORDER BY updated_at DESC, id",
      [owner, kind],
    );
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  async listWhere<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
  ): Promise<T[]> {
    const rows = await this.rows<{ data: string }>(
      `SELECT data FROM records WHERE owner = ? AND kind = ? AND ${jsonPath(field)} = ? ORDER BY updated_at DESC, id`,
      [owner, kind, value],
    );
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.rows(
      "INSERT INTO records (owner, kind, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      [owner, kind, value.id, JSON.stringify(value), this.now()],
    );
    return value;
  }

  insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    return this.data<T>(
      "INSERT INTO records (owner, kind, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value), this.now()],
    );
  }

  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.rows("DELETE FROM records WHERE owner = ? AND kind = ? AND id = ?", [
      owner,
      kind,
      id,
    ]);
  }

  async removeBelow(owner: string, kind: string, field: string, limit: number): Promise<number> {
    const path = jsonPath(field);
    const removed = await this.rows(
      `DELETE FROM records WHERE owner = ? AND kind = ? AND json_type(data, '$.${field}') IN ('integer', 'real') AND ${path} < ? RETURNING id`,
      [owner, kind, limit],
    );
    return removed.length;
  }

  take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    return this.data<T>(
      "DELETE FROM records WHERE owner = ? AND kind = ? AND id = ? RETURNING data",
      [owner, kind, id],
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
      params,
    );
  }

  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const rows = await this.rows<{ owner: string; data: string }>(
      "SELECT owner, data FROM records WHERE kind = ? ORDER BY updated_at ASC",
      [kind],
    );
    return rows.map((row) => ({ owner: row.owner, value: JSON.parse(row.data) as T }));
  }
}
