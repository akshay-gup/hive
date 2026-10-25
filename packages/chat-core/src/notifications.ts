import { first, type Sql } from "./sql.ts";

export interface Notice {
  userId: string;
  kind: string;
  messageId: string;
  channelId: string;
  seq: number;
  at: string;
  readAt: string | null;
}

interface Row {
  user_id: string;
  kind: string;
  message_id: string;
  channel_id: string;
  seq: number;
  at: string;
  read_at: string | null;
}

const toNotice = (row: Row): Notice => ({
  userId: row.user_id,
  kind: row.kind,
  messageId: row.message_id,
  channelId: row.channel_id,
  seq: row.seq,
  at: row.at,
  readAt: row.read_at,
});

/**
 * What each person is to be told: a mention, a reply in a thread they are in. There is one notice per
 * person, kind and message, so what is sent again (a retry, an edit) does not tell them twice.
 */
export class Notifications {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Tell a person; true if they had not been told about this message in this way. */
  add(notice: { userId: string; kind: string; messageId: string; channelId: string; seq: number }) {
    return (
      this.sql.run(
        `INSERT OR IGNORE INTO notifications (user_id, kind, message_id, channel_id, seq, at) VALUES (?, ?, ?, ?, ?, ?)`,
        notice.userId,
        notice.kind,
        notice.messageId,
        notice.channelId,
        notice.seq,
        this.now(),
      ) > 0
    );
  }

  list(userId: string, options: { unreadOnly?: boolean; limit?: number } = {}): Notice[] {
    return this.sql
      .all<Row>(
        `SELECT user_id, kind, message_id, channel_id, seq, at, read_at FROM notifications
         WHERE user_id = ? ${options.unreadOnly ? "AND read_at IS NULL" : ""}
         ORDER BY at DESC, message_id LIMIT ?`,
        userId,
        Math.min(options.limit ?? 100, 500),
      )
      .map(toNotice);
  }

  unreadCount(userId: string): number {
    return (
      first<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
        userId,
      )?.n ?? 0
    );
  }

  /** Mark some of a person's notices read (or all of them, with no ids); how many changed. */
  markRead(userId: string, messageIds?: string[]): number {
    if (!messageIds)
      return this.sql.run(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
        this.now(),
        userId,
      );
    let changed = 0;
    for (const id of messageIds)
      changed += this.sql.run(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND message_id = ? AND read_at IS NULL",
        this.now(),
        userId,
        id,
      );
    return changed;
  }

  markUnread(userId: string, messageIds: string[]): number {
    let changed = 0;
    for (const id of messageIds)
      changed += this.sql.run(
        "UPDATE notifications SET read_at = NULL WHERE user_id = ? AND message_id = ? AND read_at IS NOT NULL",
        userId,
        id,
      );
    return changed;
  }

  /** Remove some of a person's notices (or all, with no ids). */
  dismiss(userId: string, messageIds?: string[]): number {
    if (!messageIds) return this.sql.run("DELETE FROM notifications WHERE user_id = ?", userId);
    let changed = 0;
    for (const id of messageIds)
      changed += this.sql.run(
        "DELETE FROM notifications WHERE user_id = ? AND message_id = ?",
        userId,
        id,
      );
    return changed;
  }

  /** The notices about a message are dropped when it is deleted. */
  removeForMessage(messageId: string): number {
    return this.sql.run("DELETE FROM notifications WHERE message_id = ?", messageId);
  }
}
