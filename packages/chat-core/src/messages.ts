import { AppError } from "./errors.ts";
import { first, type Sql } from "./sql.ts";

/** How many different people are remembered as having replied in a thread, for showing their faces. */
const MAX_REPLY_USERS = 50;

export type AuthorKind = "person" | "agent" | "system";

export interface Message {
  id: string;
  channelId: string;
  /** Its place in the channel: the cursor for paging and for what has been read. */
  seq: number;
  authorId: string;
  authorKind: AuthorKind;
  /** Empty for a message that was deleted. */
  body: string;
  /** What an author other than a person adds (an agent's tool cards): opaque here. */
  extra: unknown;
  /** The first message of the thread this one is a reply in; null for a message of the channel itself. */
  threadRoot: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  replyUsers: string[];
  /** What the sender called it when they sent it, so their own screen can tell which message came back. */
  clientId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface Row {
  channel_id: string;
  seq: number;
  id: string;
  author_id: string;
  author_kind: AuthorKind;
  body: string;
  extra: string | null;
  thread_root: string | null;
  reply_count: number;
  last_reply_at: string | null;
  reply_users: string | null;
  client_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

const COLUMNS =
  "channel_id, seq, id, author_id, author_kind, body, extra, thread_root, reply_count, last_reply_at, reply_users, client_id, created_at, edited_at, deleted_at";

function toMessage(row: Row): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    authorId: row.author_id,
    authorKind: row.author_kind,
    body: row.body,
    extra: row.extra ? (JSON.parse(row.extra) as unknown) : null,
    threadRoot: row.thread_root,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
    replyUsers: row.reply_users ? (JSON.parse(row.reply_users) as string[]) : [],
    clientId: row.client_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}

export interface PostInput {
  channelId: string;
  authorId: string;
  authorKind?: AuthorKind;
  body: string;
  extra?: unknown;
  /** The message to reply to; replies go to the first message of a thread, never to a reply. */
  threadRoot?: string | null;
  /** The sender's own name for this post, so one sent twice (a retry) is one message. */
  clientId?: string | null;
  id?: string;
}

/**
 * The messages of a workspace's channels, as rows. A post takes the next number of its channel, so
 * the order is the one the Durable Object saw, whatever the clocks of the senders say. Everything here
 * is about what is stored; who may post, read or delete is decided before it is called.
 */
export class Messages {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Add a message. Posting the same `clientId` again returns the message that was made the first time. */
  post(input: PostInput): { message: Message; created: boolean } {
    return this.sql.transaction(() => {
      if (input.clientId) {
        const again = first<Row>(
          this.sql,
          `SELECT ${COLUMNS} FROM messages WHERE channel_id = ? AND author_id = ? AND client_id = ?`,
          input.channelId,
          input.authorId,
          input.clientId,
        );
        if (again) return { message: toMessage(again), created: false };
      }
      const threadRoot = input.threadRoot ?? null;
      if (threadRoot) {
        const root = first<Row>(
          this.sql,
          `SELECT ${COLUMNS} FROM messages WHERE id = ?`,
          threadRoot,
        );
        if (!root || root.channel_id !== input.channelId)
          throw new AppError("That message is not in this channel", 404);
        if (root.thread_root) throw new AppError("Reply to the first message of a thread", 409);
      }
      const at = this.now();
      const state = first<{ last_seq: number }>(
        this.sql,
        `INSERT INTO channel_state (channel_id, last_seq, last_at, last_by) VALUES (?, 1, ?, ?)
         ON CONFLICT (channel_id) DO UPDATE SET last_seq = last_seq + 1, last_at = excluded.last_at, last_by = excluded.last_by
         RETURNING last_seq`,
        input.channelId,
        at,
        input.authorId,
      );
      const seq = state?.last_seq ?? 1;
      const id = input.id ?? crypto.randomUUID();
      this.sql.run(
        `INSERT INTO messages (channel_id, seq, id, author_id, author_kind, body, extra, thread_root, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.channelId,
        seq,
        id,
        input.authorId,
        input.authorKind ?? "person",
        input.body,
        input.extra === undefined || input.extra === null ? null : JSON.stringify(input.extra),
        threadRoot,
        input.clientId ?? null,
        at,
      );
      if (threadRoot) {
        const root = first<{ reply_users: string | null }>(
          this.sql,
          "SELECT reply_users FROM messages WHERE id = ?",
          threadRoot,
        );
        const users = new Set<string>(root?.reply_users ? JSON.parse(root.reply_users) : []);
        if (users.size < MAX_REPLY_USERS) users.add(input.authorId);
        this.sql.run(
          "UPDATE messages SET reply_count = reply_count + 1, last_reply_seq = ?, last_reply_at = ?, reply_users = ? WHERE id = ?",
          seq,
          at,
          JSON.stringify([...users]),
          threadRoot,
        );
      }
      const made = this.get(id);
      if (!made) throw new AppError("The message could not be saved", 500);
      return { message: made, created: true };
    });
  }

  get(id: string): Message | null {
    const row = first<Row>(this.sql, `SELECT ${COLUMNS} FROM messages WHERE id = ?`, id);
    return row ? toMessage(row) : null;
  }

  /**
   * A page of the channel's own messages (not thread replies), oldest first: the newest `limit`, or the
   * newest `limit` before `before`. A deleted message that has no replies is left out; one that has
   * stays, so the thread under it still has something to hang from.
   */
  page(
    channelId: string,
    options: { before?: number; limit?: number } = {},
  ): { messages: Message[]; more: boolean } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.sql.all<Row>(
      `SELECT ${COLUMNS} FROM messages
       WHERE channel_id = ? AND thread_root IS NULL AND seq < ? AND (deleted_at IS NULL OR reply_count > 0)
       ORDER BY seq DESC LIMIT ?`,
      channelId,
      options.before ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    const more = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(toMessage), more };
  }

  /** What came after a place in the channel, oldest first, thread replies included: for a client filling a gap. */
  since(channelId: string, seq: number, limit = 200): Message[] {
    return this.sql
      .all<Row>(
        `SELECT ${COLUMNS} FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        channelId,
        seq,
        Math.min(limit, 500),
      )
      .map(toMessage);
  }

  /** The replies in a thread, oldest first (deleted ones are gone). */
  replies(rootId: string, options: { after?: number; limit?: number } = {}): Message[] {
    return this.sql
      .all<Row>(
        `SELECT ${COLUMNS} FROM messages WHERE thread_root = ? AND seq > ? AND deleted_at IS NULL ORDER BY seq ASC LIMIT ?`,
        rootId,
        options.after ?? 0,
        Math.min(Math.max(options.limit ?? 100, 1), 500),
      )
      .map(toMessage);
  }

  /** The channel's threads, the most recently replied to first. */
  threads(channelId: string, limit = 50): Message[] {
    return this.sql
      .all<Row>(
        `SELECT ${COLUMNS} FROM messages WHERE channel_id = ? AND reply_count > 0 AND thread_root IS NULL
         ORDER BY last_reply_seq DESC LIMIT ?`,
        channelId,
        Math.min(limit, 200),
      )
      .map(toMessage);
  }

  /** Change what a message says. Only its author may, and not once it is deleted. */
  edit(id: string, authorId: string, body: string): Message {
    return this.sql.transaction(() => {
      const found = this.get(id);
      if (!found || found.deletedAt) throw new AppError("Message not found", 404);
      if (found.authorId !== authorId || found.authorKind !== "person")
        throw new AppError("Only the person who wrote a message can edit it", 403);
      this.sql.run(
        "UPDATE messages SET body = ?, edited_at = ? WHERE id = ?",
        body,
        this.now(),
        id,
      );
      return this.get(id) as Message;
    });
  }

  /**
   * Take a message away: its text goes and its place stays. The message as it was is returned, so what
   * it held (its files) can be let go of in the same transaction. Deleting a reply counts one fewer on
   * its thread.
   */
  remove(id: string): Message | null {
    return this.sql.transaction(() => {
      const found = this.get(id);
      if (!found || found.deletedAt) return null;
      this.sql.run(
        "UPDATE messages SET body = '', extra = NULL, deleted_at = ? WHERE id = ?",
        this.now(),
        id,
      );
      if (found.threadRoot)
        this.sql.run(
          "UPDATE messages SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?",
          found.threadRoot,
        );
      this.sql.run("DELETE FROM reactions WHERE message_id = ?", id);
      return found;
    });
  }

  /**
   * Change what an agent's reply says. Only an agent's message is changed this way (a person's goes through
   * `edit`, by its author), and a deleted one is left deleted.
   */
  patchAgent(id: string, change: { body: string; extra: unknown }): Message | null {
    const changed = this.sql.run(
      "UPDATE messages SET body = ?, extra = ?, edited_at = NULL WHERE id = ? AND author_kind = 'agent' AND deleted_at IS NULL",
      change.body,
      JSON.stringify(change.extra),
      id,
    );
    return changed > 0 ? this.get(id) : null;
  }

  /** Where the channel's numbering has got to (0 before the first message). */
  lastSeq(channelId: string): number {
    return (
      first<{ last_seq: number }>(
        this.sql,
        "SELECT last_seq FROM channel_state WHERE channel_id = ?",
        channelId,
      )?.last_seq ?? 0
    );
  }

  /** When the channel last had a message, and who wrote it. */
  lastActivity(channelId: string): { at: string; by: string } | null {
    const row = first<{ last_at: string | null; last_by: string | null }>(
      this.sql,
      "SELECT last_at, last_by FROM channel_state WHERE channel_id = ?",
      channelId,
    );
    return row?.last_at && row.last_by ? { at: row.last_at, by: row.last_by } : null;
  }

  /** Every message of a channel is let go of (the channel was deleted); returns how many went. */
  removeChannel(channelId: string, batch = 500): number {
    const ids = this.sql
      .all<{ id: string }>("SELECT id FROM messages WHERE channel_id = ? LIMIT ?", channelId, batch)
      .map((row) => row.id);
    for (const id of ids) {
      this.sql.run("DELETE FROM reactions WHERE message_id = ?", id);
      this.sql.run("DELETE FROM messages WHERE id = ?", id);
    }
    return ids.length;
  }
}
