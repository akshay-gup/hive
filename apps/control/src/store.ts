/**
 * What the control plane needs of its database: records filed by owner, kind and id, each a JSON
 * object with an `id`. The server's own `Store` (Postgres, or the embedded database) is one
 * implementation; `D1Store` is the one that runs on Cloudflare.
 */
export interface ControlStore {
  get<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null>;
  /** Every record of a kind under an owner, newest change first. */
  list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]>;
  /** Records whose top-level text field equals `value`. */
  listWhere<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
  ): Promise<T[]>;
  put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T>;
  /** Add the record unless one with that id exists; null when it did. */
  insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null>;
  remove(owner: string, kind: string, id: string): Promise<void>;
  /**
   * Remove the records of a kind whose top-level number field is under `limit` (a record without
   * that field as a number is left alone), and say how many went. This is how what has run out is
   * swept up in one go, without reading it all.
   */
  removeBelow(owner: string, kind: string, field: string, limit: number): Promise<number>;
  /** Remove the record and return it, so only one caller gets it. */
  take<T>(owner: string, kind: string, id: string): Promise<T | null>;
  /**
   * Merge `patch` into the record, but only while its top-level fields equal `expected` (an empty
   * `expected` always matches). Returns the record after the change, or null when it is missing or
   * no longer matches: the way two callers that read the same record settle who goes first.
   */
  compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null>;
  /** Every record of a kind, oldest change first. */
  scan<T>(kind: string): Promise<{ owner: string; value: T }[]>;
}
