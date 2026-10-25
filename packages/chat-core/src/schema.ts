import { first, type Sql } from "./sql.ts";

/**
 * One step per version, each run once and in order, so a later change to the tables is a new step
 * and never an edit to an old one. The version is kept in `meta` (a Durable Object's SQLite does not
 * take every PRAGMA).
 */
const STEPS: string[][] = [
  [
    // Small, read-as-a-whole records: channels, people, notification settings. The same shape as the
    // workspace server's records, so the permission code that was written for it runs here unchanged.
    `CREATE TABLE records (
       owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
       data TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (owner, kind, id)
     ) WITHOUT ROWID`,
    `CREATE INDEX records_kind ON records (kind, updated_at)`,

    // Where each channel's messages are numbered up to. A post takes the next number here, so it does
    // not have to rewrite the channel record.
    `CREATE TABLE channel_state (
       channel_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0,
       last_at TEXT, last_by TEXT
     )`,

    // A message is a row. `seq` is its place in its channel (the cursor for paging and for what has
    // been read); a thread's replies are rows of the same channel that name the thread's first message.
    // Deleting leaves the row with its text taken out, so places and reply counts stay where they were.
    `CREATE TABLE messages (
       channel_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
       author_id TEXT NOT NULL, author_kind TEXT NOT NULL DEFAULT 'person',
       body TEXT NOT NULL, extra TEXT,
       thread_root TEXT,
       reply_count INTEGER NOT NULL DEFAULT 0, last_reply_seq INTEGER, last_reply_at TEXT, reply_users TEXT,
       client_id TEXT,
       created_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT,
       PRIMARY KEY (channel_id, seq)
     ) WITHOUT ROWID`,
    `CREATE INDEX msg_top ON messages (channel_id, seq) WHERE thread_root IS NULL`,
    `CREATE INDEX msg_thread ON messages (thread_root, seq) WHERE thread_root IS NOT NULL`,
    `CREATE INDEX msg_threads ON messages (channel_id, last_reply_seq) WHERE reply_count > 0`,
    `CREATE UNIQUE INDEX msg_idem ON messages (channel_id, author_id, client_id) WHERE client_id IS NOT NULL`,

    `CREATE TABLE reactions (
       message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL,
       channel_id TEXT NOT NULL, at TEXT NOT NULL,
       PRIMARY KEY (message_id, user_id, emoji)
     ) WITHOUT ROWID`,

    // How far each person has read each channel, as a place in its numbering.
    `CREATE TABLE reads (
       user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
       last_read_seq INTEGER NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (user_id, channel_id)
     ) WITHOUT ROWID`,

    // What a person is to be told. The key makes one notice per person, kind and message, which is
    // how a message that is edited or retried does not tell them twice.
    `CREATE TABLE notifications (
       user_id TEXT NOT NULL, kind TEXT NOT NULL, message_id TEXT NOT NULL,
       channel_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, read_at TEXT,
       PRIMARY KEY (user_id, kind, message_id)
     ) WITHOUT ROWID`,
    `CREATE INDEX notif_user ON notifications (user_id, read_at, at DESC)`,

    // Files are rows that point at R2. `pending` until the bytes are there and have the size that was
    // asked for; the bytes a pending file will take are counted as reserved.
    `CREATE TABLE files (
       id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT, uploader_id TEXT NOT NULL,
       name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, r2_key TEXT NOT NULL,
       thumb_key TEXT, thumb_bytes INTEGER NOT NULL DEFAULT 0, width INTEGER, height INTEGER,
       state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT
     )`,
    `CREATE INDEX files_channel ON files (channel_id, created_at DESC)`,
    `CREATE INDEX files_message ON files (message_id)`,
    `CREATE INDEX files_pending ON files (state, expires_at)`,

    // The workspace's stored bytes against what its plan allows (the plan's numbers arrive in a token).
    `CREATE TABLE usage (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       bytes_used INTEGER NOT NULL DEFAULT 0, bytes_reserved INTEGER NOT NULL DEFAULT 0,
       files INTEGER NOT NULL DEFAULT 0,
       max_file_bytes INTEGER, storage_bytes INTEGER, limits_iat INTEGER NOT NULL DEFAULT 0
     )`,
    `INSERT INTO usage (id) VALUES (1)`,

    // What happened, in order, for a client that was away to catch up on. Pruned as it ages.
    `CREATE TABLE events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT, user_id TEXT,
       type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL
     )`,

    // People whose sign-in is cut off: a token issued before this moment is no longer good.
    `CREATE TABLE revoked (user_id TEXT PRIMARY KEY, before INTEGER NOT NULL)`,

    // R2 objects to delete, which the Worker or an alarm does, since R2 is not touched inside a transaction.
    `CREATE TABLE gc (r2_key TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  ],
];

/** The newest version of the tables. */
export const SCHEMA_VERSION = STEPS.length;

/** Bring the database to the newest version: make the tables if there are none, and run the steps it has not had. */
export function migrate(sql: Sql): number {
  sql.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = first<{ value: string }>(sql, "SELECT value FROM meta WHERE key = 'schema'");
  const have = row ? Number(row.value) : 0;
  if (have > SCHEMA_VERSION)
    throw new Error(`This database is at schema ${have}; this code knows up to ${SCHEMA_VERSION}`);
  for (let version = have; version < SCHEMA_VERSION; version++) {
    sql.transaction(() => {
      for (const statement of STEPS[version] ?? []) sql.run(statement);
      sql.run(
        "INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        String(version + 1),
      );
    });
  }
  return SCHEMA_VERSION;
}
