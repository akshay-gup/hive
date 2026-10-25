import { AppError } from "./errors.ts";
import type { Sql } from "./sql.ts";

const MAX_EMOJI_LENGTH = 32;
const MAX_KINDS_PER_MESSAGE = 50;

export interface ReactionSummary {
  emoji: string;
  count: number;
  /** Who reacted, for showing and for knowing which are yours. */
  users: string[];
}

/** Reactions to messages: one per person, message and emoji. */
export class Reactions {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Add the reaction; true if it was not there before. */
  add(messageId: string, channelId: string, userId: string, emoji: string): boolean {
    const mark = emoji.trim();
    if (!mark || mark.length > MAX_EMOJI_LENGTH) throw new AppError("That is not an emoji", 422);
    return this.sql.transaction(() => {
      const known = this.sql.all<{ n: number }>(
        "SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ? AND emoji != ?",
        messageId,
        mark,
      );
      if ((known[0]?.n ?? 0) >= MAX_KINDS_PER_MESSAGE)
        throw new AppError("That message has as many reactions as it can take", 409);
      return (
        this.sql.run(
          "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, channel_id, at) VALUES (?, ?, ?, ?, ?)",
          messageId,
          userId,
          mark,
          channelId,
          this.now(),
        ) > 0
      );
    });
  }

  /** Take it away; true if it was there. */
  remove(messageId: string, userId: string, emoji: string): boolean {
    return (
      this.sql.run(
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
        messageId,
        userId,
        emoji.trim(),
      ) > 0
    );
  }

  /** The reactions on each of these messages, the first used first. */
  summary(messageIds: string[]): Map<string, ReactionSummary[]> {
    const out = new Map<string, ReactionSummary[]>();
    for (let i = 0; i < messageIds.length; i += 100) {
      const ids = messageIds.slice(i, i + 100);
      if (!ids.length) continue;
      const rows = this.sql.all<{ message_id: string; user_id: string; emoji: string }>(
        `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY at, user_id, emoji`,
        ...ids,
      );
      for (const row of rows) {
        const list = out.get(row.message_id) ?? [];
        let entry = list.find((one) => one.emoji === row.emoji);
        if (!entry) {
          entry = { emoji: row.emoji, count: 0, users: [] };
          list.push(entry);
        }
        entry.count += 1;
        entry.users.push(row.user_id);
        out.set(row.message_id, list);
      }
    }
    return out;
  }
}
