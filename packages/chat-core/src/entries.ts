import { first, type Sql } from "./sql.ts";

/** Whose an entry is: a person's, a project's, a channel's, or the whole team's. */
export type EntryScopeType = "person" | "project" | "channel" | "team";
export interface EntryScope {
  type: EntryScopeType;
  /** The person, project or channel; nothing for the team. */
  id?: string;
}

/** Something the room keeps that is not a task: a notice, a goal, a routine, an idea. What it is, is its `kind`. */
export interface Entry<Data = Record<string, unknown>> {
  id: string;
  kind: string;
  scope: EntryScope;
  createdBy: string;
  /** For the kinds that have a state (a routine is active or paused). */
  status?: string;
  /** For the kinds that wake up at a time (the next time a routine fires), as an ISO date. */
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  data: Data;
}

interface Row {
  id: string;
  kind: string;
  scope_type: EntryScopeType;
  scope_id: string;
  created_by: string;
  status: string | null;
  due_ms: number | null;
  created_ms: number;
  updated_ms: number;
  data: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

const toEntry = (row: Row): Entry => ({
  id: row.id,
  kind: row.kind,
  scope: { type: row.scope_type, ...(row.scope_id ? { id: row.scope_id } : {}) },
  createdBy: row.created_by,
  ...(row.status ? { status: row.status } : {}),
  ...(row.due_ms !== null ? { dueAt: iso(row.due_ms) } : {}),
  createdAt: iso(row.created_ms),
  updatedAt: iso(row.updated_ms),
  data: JSON.parse(row.data) as Record<string, unknown>,
});

/** What a caller says of an entry it keeps; the rest (the times) the store fills in. */
export type EntryInput = Pick<Entry, "id" | "kind" | "scope" | "createdBy"> &
  Partial<Pick<Entry, "status" | "dueAt" | "data" | "createdAt">>;

/**
 * The room's entries, as rows. This is only the storage: who may see or change one is entry-rules.ts, and
 * what a kind means (when a routine fires, what a goal's milestones are) is its own module's.
 */
export class Entries {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  get(id: string): Entry | null {
    const row = first<Row>(this.sql, "SELECT * FROM entries WHERE id = ?", id);
    return row ? toEntry(row) : null;
  }

  /** Keep an entry: made if it is new, changed if it is not (when it was made stays). */
  put(input: EntryInput): Entry {
    const now = this.clock();
    const due = input.dueAt ? Date.parse(input.dueAt) : null;
    const data = JSON.stringify(input.data ?? {});
    const changed = this.sql.run(
      `UPDATE entries SET kind = ?, scope_type = ?, scope_id = ?, status = ?, due_ms = ?, updated_ms = ?, data = ?
       WHERE id = ?`,
      input.kind,
      input.scope.type,
      input.scope.id ?? "",
      input.status ?? null,
      due,
      now,
      data,
      input.id,
    );
    if (!changed)
      this.sql.run(
        `INSERT INTO entries (id, kind, scope_type, scope_id, created_by, status, due_ms, created_ms, updated_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.kind,
        input.scope.type,
        input.scope.id ?? "",
        input.createdBy,
        input.status ?? null,
        due,
        input.createdAt ? Date.parse(input.createdAt) : now,
        now,
        data,
      );
    return this.get(input.id) as Entry;
  }

  /** Keep an entry only if there is none with its id; the one already there if there is. */
  putIfAbsent(input: EntryInput): { entry: Entry; made: boolean } {
    const there = this.get(input.id);
    if (there) return { entry: there, made: false };
    return { entry: this.put(input), made: true };
  }

  /** All entries of a kind, oldest first. */
  list(kind: string): Entry[] {
    return this.sql
      .all<Row>("SELECT * FROM entries WHERE kind = ? ORDER BY created_ms, id", kind)
      .map(toEntry);
  }

  /** The entries of a kind that belong to one scope. */
  inScope(kind: string, scope: EntryScope): Entry[] {
    return this.sql
      .all<Row>(
        "SELECT * FROM entries WHERE kind = ? AND scope_type = ? AND scope_id = ? ORDER BY created_ms, id",
        kind,
        scope.type,
        scope.id ?? "",
      )
      .map(toEntry);
  }

  /** Every entry of any kind in one scope, for counting what would go with a project. */
  allInScope(scope: EntryScope): Entry[] {
    return this.sql
      .all<Row>(
        "SELECT * FROM entries WHERE scope_type = ? AND scope_id = ? ORDER BY created_ms, id",
        scope.type,
        scope.id ?? "",
      )
      .map(toEntry);
  }

  /** How many entries of a kind a person has made. */
  countBy(kind: string, createdBy: string): number {
    return (
      first<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM entries WHERE kind = ? AND created_by = ?",
        kind,
        createdBy,
      )?.n ?? 0
    );
  }

  /** The entries of a kind whose time has come, soonest first. */
  due(kind: string, now: number, limit = 20): Entry[] {
    return this.sql
      .all<Row>(
        `SELECT * FROM entries WHERE kind = ? AND status = 'active' AND due_ms IS NOT NULL AND due_ms <= ?
         ORDER BY due_ms, id LIMIT ?`,
        kind,
        now,
        limit,
      )
      .map(toEntry);
  }

  /** When the next active entry of a kind is due, or null when none is waiting. */
  nextDueMs(kind: string): number | null {
    return (
      first<{ at: number | null }>(
        this.sql,
        "SELECT MIN(due_ms) AS at FROM entries WHERE kind = ? AND status = 'active' AND due_ms IS NOT NULL",
        kind,
      )?.at ?? null
    );
  }

  remove(id: string): Entry | null {
    const was = this.get(id);
    if (!was) return null;
    this.sql.run("DELETE FROM entries WHERE id = ?", id);
    return was;
  }

  /** Everything in a scope goes: a deleted project's goals and routines, a deleted channel's. */
  removeScope(scope: EntryScope): Entry[] {
    const gone = this.allInScope(scope);
    if (gone.length)
      this.sql.run(
        "DELETE FROM entries WHERE scope_type = ? AND scope_id = ?",
        scope.type,
        scope.id ?? "",
      );
    return gone;
  }
}
