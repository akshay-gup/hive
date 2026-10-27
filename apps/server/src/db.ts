import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

/**
 * Kinds of record that belong to the whole workspace rather than to whoever made them.
 *
 * Hive is a team product: apart from the orchestrator chat (and the sign-in sessions, which live
 * under their own owner), everything is shared by every signed-in user. Store calls for these
 * kinds ignore the owner they are given, so a task, a board, a review, a draft or the agent's
 * memory is one record whoever opens it. The workspace has one Google connection (`credentials`),
 * and the mail, calendar and files that come through it are the team's. Tasks, goals and reviews
 * carry `createdBy`, only to show who asked.
 */
export const SHARED_KINDS: ReadonlySet<string> = new Set([
  // Work
  "tasks",
  "task-sessions",
  "runs",
  "run-events",
  "live-runs",
  "goals",
  "monitors",
  "agent-artifacts",
  "upload-requests",
  "actions",
  "activity",
  // The workspace's one Google connection, and what comes through it
  "credentials",
  "settings",
  "mail",
  "events",
  "imports",
  "files",
  "drafts",
  // Browser sessions
  "browsers",
  "chat-browsers",
  "browser-downloads",
  "browser-shots",
  // The agent
  "memories",
  "agent-settings",
  "ideas",
  "notifications",
  "sample-pages",
]);
const homeOf = (owner: string, kind: string) => (SHARED_KINDS.has(kind) ? SHARED_OWNER : owner);

export class Store {
  constructor(private readonly db: Database) {}
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [homeOf(owner, kind), kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [homeOf(owner, kind), kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Records whose top-level text field equals `value`, without loading the whole kind. */
  async listWhere<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3::text=$4::text ORDER BY updated_at DESC,id",
      [homeOf(owner, kind), kind, field, value],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [homeOf(owner, kind), kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      homeOf(owner, kind),
      kind,
      id,
    ]);
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [homeOf(owner, kind), kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /**
   * Append `item` to the array in `field`, in one statement. Reading the record and writing it
   * back (or `compareAndSwap`, whose `@>` check treats an array as a superset) would drop an entry
   * when two people add one at the same moment. Options: `max` refuses the append once the array is
   * that long; `where` only appends while the record contains it (the way `compareAndSwap`
   * expects); `merge` sets other fields in the same statement. Returns the record, or null when it
   * is missing, full, or no longer matches `where`.
   */
  async appendItem<T>(
    owner: string,
    kind: string,
    id: string,
    field: string,
    item: unknown,
    options: {
      max?: number;
      where?: Record<string, unknown>;
      merge?: Record<string, unknown>;
    } = {},
  ): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records SET data=jsonb_set(data,ARRAY[$4::text],COALESCE(data->$4::text,'[]'::jsonb)||jsonb_build_array($5::jsonb),true)||$6::jsonb,updated_at=now()
       WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $7::jsonb
       AND ($8::int IS NULL OR jsonb_array_length(COALESCE(data->$4::text,'[]'::jsonb))<$8::int) RETURNING data`,
      [
        homeOf(owner, kind),
        kind,
        id,
        field,
        JSON.stringify(item),
        JSON.stringify(options.merge ?? {}),
        JSON.stringify(options.where ?? {}),
        options.max ?? null,
      ],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** Drop the entry of the array in `field` whose `id` is `itemId`; `merge` sets other fields in the same statement. Returns the record, or null if it is missing. */
  async removeItem<T>(
    owner: string,
    kind: string,
    id: string,
    field: string,
    itemId: string,
    merge: Record<string, unknown> = {},
  ): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records SET data=jsonb_set(data,ARRAY[$4::text],COALESCE((
         SELECT jsonb_agg(entry ORDER BY position)
         FROM jsonb_array_elements(COALESCE(data->$4::text,'[]'::jsonb)) WITH ORDINALITY AS entries(entry,position)
         WHERE entry->>'id' IS DISTINCT FROM $5::text
       ),'[]'::jsonb),true)||$6::jsonb,updated_at=now()
       WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data`,
      [homeOf(owner, kind), kind, id, field, itemId, JSON.stringify(merge)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** Merge `patch` into the entries of the array in `field` whose `id` is in `itemIds`. Returns the record, or null if it is missing. */
  async patchItems<T>(
    owner: string,
    kind: string,
    id: string,
    field: string,
    itemIds: string[],
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records SET data=jsonb_set(data,ARRAY[$4::text],COALESCE((
         SELECT jsonb_agg(CASE WHEN entry->>'id' IN (SELECT jsonb_array_elements_text($5::jsonb)) THEN entry||$6::jsonb ELSE entry END ORDER BY position)
         FROM jsonb_array_elements(COALESCE(data->$4::text,'[]'::jsonb)) WITH ORDINALITY AS entries(entry,position)
       ),'[]'::jsonb),true),updated_at=now()
       WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data`,
      [homeOf(owner, kind), kind, id, field, JSON.stringify(itemIds), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [homeOf(owner, kind), kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [homeOf(owner, "actions"), id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async removeBelow(owner: string, kind: string, field: string, limit: number): Promise<number> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND CASE WHEN jsonb_typeof(data->$3::text)='number' THEN (data->>$3::text)::numeric END < $4::numeric RETURNING id",
      [homeOf(owner, kind), kind, field, limit],
    );
    return result.rows.length;
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [homeOf(owner, kind), kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [homeOf(owner, "credentials"), connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = { query: async (sql, params) => pool.query(sql, params), close: () => pool.end() };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    database = {
      query: (sql, params) => embedded.query<Row>(sql, params),
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  return new Store(database);
}
