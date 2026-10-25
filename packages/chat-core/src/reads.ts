import { first, type Sql } from "./sql.ts";

/** How far each person has read each channel, and what that leaves unread. */
export class Reads {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Move a person's place in a channel forward; it never goes back. */
  mark(userId: string, channelId: string, seq: number): number {
    this.sql.run(
      `INSERT INTO reads (user_id, channel_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET
         last_read_seq = MAX(last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at`,
      userId,
      channelId,
      Math.max(0, Math.floor(seq)),
      this.now(),
    );
    return this.at(userId, channelId);
  }

  /** The place a person has read a channel to (0 if they have not). */
  at(userId: string, channelId: string): number {
    return (
      first<{ last_read_seq: number }>(
        this.sql,
        "SELECT last_read_seq FROM reads WHERE user_id = ? AND channel_id = ?",
        userId,
        channelId,
      )?.last_read_seq ?? 0
    );
  }

  /** Every place a person has, by channel. */
  all(userId: string): Map<string, number> {
    const rows = this.sql.all<{ channel_id: string; last_read_seq: number }>(
      "SELECT channel_id, last_read_seq FROM reads WHERE user_id = ?",
      userId,
    );
    return new Map(rows.map((row) => [row.channel_id, row.last_read_seq]));
  }

  /** Whether the channel has a message of someone else's, not in a thread, after the person's place. */
  hasUnread(userId: string, channelId: string, readTo = this.at(userId, channelId)): boolean {
    return (
      first(
        this.sql,
        `SELECT 1 FROM messages WHERE channel_id = ? AND thread_root IS NULL AND deleted_at IS NULL
         AND seq > ? AND author_id != ? LIMIT 1`,
        channelId,
        readTo,
        userId,
      ) !== undefined
    );
  }

  /** How many such messages, counted only up to `cap` (a badge says 99+, it does not need the rest). */
  unreadCount(userId: string, channelId: string, cap = 100): number {
    return (
      first<{ n: number }>(
        this.sql,
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM messages WHERE channel_id = ? AND thread_root IS NULL AND deleted_at IS NULL
           AND seq > ? AND author_id != ? LIMIT ?)`,
        channelId,
        this.at(userId, channelId),
        userId,
        cap,
      )?.n ?? 0
    );
  }
}
