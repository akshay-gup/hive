import { first, type Sql } from "./sql.ts";

export interface ChatEvent {
  id: number;
  /** The channel it concerns, for working out who may be told. */
  channelId: string | null;
  /** The one person it concerns, when it is for them alone (their own reads, their notices). */
  userId: string | null;
  type: string;
  data: unknown;
  at: number;
}

interface Row {
  id: number;
  channel_id: string | null;
  user_id: string | null;
  type: string;
  data: string;
  at: number;
}

const toEvent = (row: Row): ChatEvent => ({
  id: row.id,
  channelId: row.channel_id,
  userId: row.user_id,
  type: row.type,
  data: JSON.parse(row.data) as unknown,
  at: row.at,
});

/**
 * What happened in the workspace, in order, for a client that was away to catch up on. Each client
 * remembers the last number it saw and asks for what came after; when that is older than what is kept,
 * it is told to fetch afresh.
 */
export class Events {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  append(
    type: string,
    data: unknown,
    scope: { channelId?: string | null; userId?: string | null } = {},
  ): ChatEvent {
    const row = first<Row>(
      this.sql,
      `INSERT INTO events (channel_id, user_id, type, data, at) VALUES (?, ?, ?, ?, ?)
       RETURNING id, channel_id, user_id, type, data, at`,
      scope.channelId ?? null,
      scope.userId ?? null,
      type,
      JSON.stringify(data ?? null),
      this.clock(),
    ) as Row;
    return toEvent(row);
  }

  /** What came after `cursor`, oldest first. */
  since(cursor: number, limit = 500): ChatEvent[] {
    return this.sql
      .all<Row>(
        "SELECT id, channel_id, user_id, type, data, at FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
        cursor,
        Math.min(limit, 1000),
      )
      .map(toEvent);
  }

  /** The newest number there is (0 before the first event). */
  latest(): number {
    return first<{ id: number | null }>(this.sql, "SELECT MAX(id) AS id FROM events")?.id ?? 0;
  }

  /**
   * Whether a client that has seen up to `cursor` can be caught up from what is kept, or has missed
   * something that has since been pruned.
   */
  covers(cursor: number): boolean {
    const gone = first<{ value: string }>(
      this.sql,
      "SELECT value FROM meta WHERE key = 'events_pruned_to'",
    );
    return cursor >= (gone ? Number(gone.value) : 0);
  }

  /** Let go of the oldest: what is older than `maxAgeMs`, and whatever is past the newest `keep`. */
  prune(options: { keep?: number; maxAgeMs?: number } = {}): number {
    const keep = options.keep ?? 50_000;
    const maxAgeMs = options.maxAgeMs ?? 3 * 24 * 3600_000;
    const below = this.latest() - keep;
    const cutoff = this.clock() - maxAgeMs;
    return this.sql.transaction(() => {
      const top = first<{ id: number | null }>(
        this.sql,
        "SELECT MAX(id) AS id FROM events WHERE id <= ? OR at < ?",
        below,
        cutoff,
      )?.id;
      if (top === null || top === undefined) return 0;
      this.sql.run(
        "INSERT INTO meta (key, value) VALUES ('events_pruned_to', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        String(top),
      );
      return this.sql.run("DELETE FROM events WHERE id <= ?", top);
    });
  }
}
