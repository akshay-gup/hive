import { AppError } from "./errors.ts";
import { first, type Sql } from "./sql.ts";

/** The most a single file may be whatever the plan says: what one request to the Worker can carry. */
export const HARD_MAX_FILE_BYTES = 100 * 1024 ** 2;
/** How long a person has to send a file after being given the address to send it to. */
export const UPLOAD_MINUTES = 15;
const MAX_NAME = 200;

export interface FileRow {
  id: string;
  channelId: string;
  messageId: string | null;
  uploaderId: string;
  name: string;
  mime: string;
  bytes: number;
  /** Where the bytes are, in the bucket, below the workspace's own prefix. */
  r2Key: string;
  thumbKey: string | null;
  /** What the picture was said to be until it has arrived; what it is after. */
  thumbBytes: number;
  /** Whether the smaller picture has arrived. */
  thumbReady: boolean;
  width: number | null;
  height: number | null;
  state: "pending" | "ready";
  createdAt: string;
  expiresAt: string | null;
}

interface Row {
  id: string;
  channel_id: string;
  message_id: string | null;
  uploader_id: string;
  name: string;
  mime: string;
  bytes: number;
  r2_key: string;
  thumb_key: string | null;
  thumb_bytes: number;
  thumb_ready: number;
  width: number | null;
  height: number | null;
  state: "pending" | "ready";
  created_at: string;
  expires_at: string | null;
}

const COLUMNS =
  "id, channel_id, message_id, uploader_id, name, mime, bytes, r2_key, thumb_key, thumb_bytes, thumb_ready, width, height, state, created_at, expires_at";

const toFile = (row: Row): FileRow => ({
  id: row.id,
  channelId: row.channel_id,
  messageId: row.message_id,
  uploaderId: row.uploader_id,
  name: row.name,
  mime: row.mime,
  bytes: row.bytes,
  r2Key: row.r2_key,
  thumbKey: row.thumb_key,
  thumbBytes: row.thumb_bytes,
  thumbReady: row.thumb_ready === 1,
  width: row.width,
  height: row.height,
  state: row.state,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export interface Usage {
  bytesUsed: number;
  bytesReserved: number;
  files: number;
  maxFileBytes: number | null;
  storageBytes: number | null;
}

/** A name that is only a name: no folders, no control characters, not too long. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .filter((c) => (c.codePointAt(0) ?? 0) >= 32 && c.codePointAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, MAX_NAME);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

/**
 * The files people send, as rows that point at objects in the bucket, and the account of the bytes
 * they take. A file is `pending` from the moment its person is given somewhere to send it, with the
 * bytes it will take set aside, and `ready` once the bytes are there and are the size they said. What is
 * set aside counts against the workspace's allowance, so people cannot send more than it holds by all
 * starting at once. Everything the bucket must let go of is written to `gc` first, since the bucket
 * is not touched inside a transaction.
 */
export class Files {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly clock: () => number = Date.now,
  ) {}

  usage(): Usage {
    const row = first<{
      bytes_used: number;
      bytes_reserved: number;
      files: number;
      max_file_bytes: number | null;
      storage_bytes: number | null;
    }>(
      this.sql,
      "SELECT bytes_used, bytes_reserved, files, max_file_bytes, storage_bytes FROM usage WHERE id = 1",
    );
    return {
      bytesUsed: row?.bytes_used ?? 0,
      bytesReserved: row?.bytes_reserved ?? 0,
      files: row?.files ?? 0,
      maxFileBytes: row?.max_file_bytes ?? null,
      storageBytes: row?.storage_bytes ?? null,
    };
  }

  /**
   * Take the plan's numbers, as a token says them, if it is newer than the ones held: a plan that
   * changes reaches the room with the next token anyone opens, and an older token cannot undo it.
   */
  setLimits(limits: { maxFileBytes: number; storageBytes: number }, issuedAt: number): void {
    this.sql.run(
      `UPDATE usage SET max_file_bytes = ?, storage_bytes = ?, limits_iat = ? WHERE id = 1 AND limits_iat < ?`,
      limits.maxFileBytes,
      limits.storageBytes,
      issuedAt,
      issuedAt,
    );
  }

  /**
   * Set aside room for a file and make the row for it. Refused when it is bigger than one file may
   * be, or when the workspace has not got the room: both say what the limit is, so the person is told.
   */
  reserve(input: {
    channelId: string;
    uploaderId: string;
    name: string;
    mime: string;
    bytes: number;
    thumbBytes?: number;
    width?: number;
    height?: number;
  }): FileRow {
    const bytes = Math.floor(input.bytes);
    const thumbBytes = Math.floor(input.thumbBytes ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0) throw new AppError("That file is empty", 422);
    if (thumbBytes < 0 || thumbBytes > 2 * 1024 ** 2)
      throw new AppError("That preview picture is too big", 422);
    return this.sql.transaction(() => {
      const usage = this.usage();
      const most = Math.min(usage.maxFileBytes ?? HARD_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES);
      if (bytes > most)
        throw new AppError(
          `Files can be up to ${megabytes(most)}. That one is ${megabytes(bytes)}.`,
          413,
        );
      const need = bytes + thumbBytes;
      if (
        usage.storageBytes !== null &&
        usage.bytesUsed + usage.bytesReserved + need > usage.storageBytes
      ) {
        const left = Math.max(usage.storageBytes - usage.bytesUsed - usage.bytesReserved, 0);
        throw new AppError(
          `This workspace has ${megabytes(left)} of file storage left, and that file needs ${megabytes(need)}.`,
          413,
        );
      }
      const id = crypto.randomUUID();
      const expires = new Date(this.clock() + UPLOAD_MINUTES * 60_000).toISOString();
      this.sql.run(
        `INSERT INTO files (id, channel_id, uploader_id, name, mime, bytes, r2_key, thumb_key, thumb_bytes, width, height, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id,
        input.channelId,
        input.uploaderId,
        cleanName(input.name),
        input.mime.slice(0, 200) || "application/octet-stream",
        bytes,
        `f/${id}`,
        thumbBytes > 0 ? `f/${id}.thumb` : null,
        thumbBytes,
        input.width ?? null,
        input.height ?? null,
        this.now(),
        expires,
      );
      this.sql.run("UPDATE usage SET bytes_reserved = bytes_reserved + ? WHERE id = 1", need);
      return this.get(id) as FileRow;
    });
  }

  get(id: string): FileRow | null {
    const row = first<Row>(this.sql, `SELECT ${COLUMNS} FROM files WHERE id = ?`, id);
    return row ? toFile(row) : null;
  }

  /** The files of these messages, by message. */
  ofMessages(messageIds: string[]): Map<string, FileRow[]> {
    const out = new Map<string, FileRow[]>();
    for (let i = 0; i < messageIds.length; i += 100) {
      const ids = messageIds.slice(i, i + 100);
      if (!ids.length) continue;
      const rows = this.sql.all<Row>(
        `SELECT ${COLUMNS} FROM files WHERE state = 'ready' AND message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, id`,
        ...ids,
      );
      for (const row of rows) {
        const list = out.get(row.message_id as string) ?? [];
        list.push(toFile(row));
        out.set(row.message_id as string, list);
      }
    }
    return out;
  }

  /** The files sent to a channel, newest first. */
  inChannel(channelId: string, limit = 50): FileRow[] {
    return this.sql
      .all<Row>(
        `SELECT ${COLUMNS} FROM files WHERE channel_id = ? AND state = 'ready' ORDER BY created_at DESC, id LIMIT ?`,
        channelId,
        Math.min(limit, 200),
      )
      .map(toFile);
  }

  /**
   * The file's bytes have arrived. If they are more than were asked for the file is thrown away and the
   * room given back; otherwise it is ready, and what was set aside for it is counted as used (what
   * actually arrived, which can be less). Its smaller picture, if it has one, is still to come.
   */
  complete(id: string, arrived: number): FileRow {
    // Throwing inside the transaction would undo throwing the file away, so it is told after.
    const result = this.sql.transaction((): FileRow | "too big" => {
      const file = this.get(id);
      if (!file || file.state !== "pending") throw new AppError("That upload is not open", 409);
      if (arrived > file.bytes) {
        this.discard(file);
        return "too big";
      }
      this.sql.run("UPDATE files SET state = 'ready', bytes = ? WHERE id = ?", arrived, id);
      this.sql.run(
        "UPDATE usage SET bytes_reserved = MAX(bytes_reserved - ?, 0), bytes_used = bytes_used + ?, files = files + 1 WHERE id = 1",
        file.bytes,
        arrived,
      );
      // With no picture to wait for, the open upload is over.
      if (file.thumbBytes === 0)
        this.sql.run("UPDATE files SET expires_at = NULL WHERE id = ?", id);
      return this.get(id) as FileRow;
    });
    if (result === "too big") throw new AppError("That file is bigger than it was said to be", 413);
    return result;
  }

  /** The smaller picture has arrived, after the file; it is counted the same way. */
  completeThumb(id: string, arrived: number): FileRow {
    const result = this.sql.transaction((): FileRow | "too big" => {
      const file = this.get(id);
      if (!file || file.state !== "ready" || !file.thumbKey || file.thumbReady)
        throw new AppError("That upload is not open", 409);
      if (arrived > file.thumbBytes) {
        // Only the picture is thrown away; the file stays without it.
        this.sql.run(
          "UPDATE usage SET bytes_reserved = MAX(bytes_reserved - ?, 0) WHERE id = 1",
          file.thumbBytes,
        );
        this.sql.run(
          "UPDATE files SET thumb_key = NULL, thumb_bytes = 0, expires_at = NULL WHERE id = ?",
          id,
        );
        this.sql.run(
          "INSERT OR IGNORE INTO gc (r2_key, at) VALUES (?, ?)",
          file.thumbKey,
          this.clock(),
        );
        return "too big";
      }
      this.sql.run(
        "UPDATE files SET thumb_ready = 1, thumb_bytes = ?, expires_at = NULL WHERE id = ?",
        arrived,
        id,
      );
      this.sql.run(
        "UPDATE usage SET bytes_reserved = MAX(bytes_reserved - ?, 0), bytes_used = bytes_used + ? WHERE id = 1",
        file.thumbBytes,
        arrived,
      );
      return this.get(id) as FileRow;
    });
    if (result === "too big")
      throw new AppError("That picture is bigger than it was said to be", 413);
    return result;
  }

  /** Put files on a message: only the sender's, ready, in that channel, and not on another message. */
  attach(ids: string[], messageId: string, channelId: string, uploaderId: string): void {
    for (const id of new Set(ids)) {
      const file = this.get(id);
      if (
        !file ||
        file.state !== "ready" ||
        file.channelId !== channelId ||
        file.uploaderId !== uploaderId ||
        file.messageId
      )
        throw new AppError("One of those files cannot be sent with this message", 422);
      this.sql.run("UPDATE files SET message_id = ? WHERE id = ?", messageId, id);
    }
  }

  /** Let go of a file: its row goes, its bytes are given back, and what is in the bucket is queued to be deleted. */
  private discard(file: FileRow) {
    this.sql.run("DELETE FROM files WHERE id = ?", file.id);
    if (file.state === "ready") {
      // What arrived is used; a picture that never came is still set aside.
      this.sql.run(
        "UPDATE usage SET bytes_used = MAX(bytes_used - ?, 0), files = MAX(files - 1, 0) WHERE id = 1",
        file.bytes + (file.thumbReady ? file.thumbBytes : 0),
      );
      if (!file.thumbReady && file.thumbKey)
        this.sql.run(
          "UPDATE usage SET bytes_reserved = MAX(bytes_reserved - ?, 0) WHERE id = 1",
          file.thumbBytes,
        );
    } else {
      this.sql.run(
        "UPDATE usage SET bytes_reserved = MAX(bytes_reserved - ?, 0) WHERE id = 1",
        file.bytes + file.thumbBytes,
      );
    }
    for (const key of [file.r2Key, file.thumbKey])
      if (key)
        this.sql.run("INSERT OR IGNORE INTO gc (r2_key, at) VALUES (?, ?)", key, this.clock());
  }

  remove(id: string): FileRow | null {
    return this.sql.transaction(() => {
      const file = this.get(id);
      if (!file) return null;
      this.discard(file);
      return file;
    });
  }

  /** A message was deleted: its files go with it. */
  removeOfMessage(messageId: string): number {
    return this.sql.transaction(() => {
      const rows = this.sql.all<Row>(
        `SELECT ${COLUMNS} FROM files WHERE message_id = ?`,
        messageId,
      );
      for (const row of rows) this.discard(toFile(row));
      return rows.length;
    });
  }

  /** A channel was deleted: every file it had goes. */
  removeOfChannel(channelId: string): number {
    return this.sql.transaction(() => {
      const rows = this.sql.all<Row>(
        `SELECT ${COLUMNS} FROM files WHERE channel_id = ?`,
        channelId,
      );
      for (const row of rows) this.discard(toFile(row));
      return rows.length;
    });
  }

  /** Uploads that were never finished give their room back. Returns how many. */
  expire(): number {
    return this.sql.transaction(() => {
      const at = new Date(this.clock()).toISOString();
      const rows = this.sql.all<Row>(
        `SELECT ${COLUMNS} FROM files WHERE state = 'pending' AND expires_at < ?`,
        at,
      );
      for (const row of rows) this.discard(toFile(row));
      // A file whose smaller picture never came keeps the file and gives back what was set aside for it.
      const late = this.sql.all<Row>(
        `SELECT ${COLUMNS} FROM files WHERE state = 'ready' AND thumb_key IS NOT NULL AND thumb_ready = 0 AND expires_at < ?`,
        at,
      );
      for (const row of late) {
        const file = toFile(row);
        this.sql.run(
          "UPDATE usage SET bytes_reserved = MAX(bytes_reserved - ?, 0) WHERE id = 1",
          file.thumbBytes,
        );
        this.sql.run(
          "UPDATE files SET thumb_key = NULL, thumb_bytes = 0, expires_at = NULL WHERE id = ?",
          file.id,
        );
        if (file.thumbKey)
          this.sql.run(
            "INSERT OR IGNORE INTO gc (r2_key, at) VALUES (?, ?)",
            file.thumbKey,
            this.clock(),
          );
      }
      return rows.length + late.length;
    });
  }

  /** What the bucket is to delete next. */
  pendingDeletes(limit = 100): string[] {
    return this.sql
      .all<{ r2_key: string }>("SELECT r2_key FROM gc ORDER BY at LIMIT ?", limit)
      .map((row) => row.r2_key);
  }

  /** The bucket has deleted these. */
  deleted(keys: string[]): void {
    for (const key of keys) this.sql.run("DELETE FROM gc WHERE r2_key = ?", key);
  }

  hasWork(): boolean {
    return (
      first(this.sql, "SELECT 1 FROM gc LIMIT 1") !== undefined ||
      first(this.sql, "SELECT 1 FROM files WHERE expires_at IS NOT NULL LIMIT 1") !== undefined
    );
  }

  /** The usage counted afresh from the files, to compare with what has been kept; and set right if it has drifted. */
  reconcile(): { drifted: boolean; bytesUsed: number; files: number } {
    return this.sql.transaction(() => {
      const sum = first<{ b: number | null; n: number }>(
        this.sql,
        "SELECT SUM(bytes + CASE WHEN thumb_ready = 1 THEN thumb_bytes ELSE 0 END) AS b, COUNT(*) AS n FROM files WHERE state = 'ready'",
      );
      const reserved = first<{ b: number | null }>(
        this.sql,
        `SELECT SUM(CASE WHEN state = 'pending' THEN bytes + thumb_bytes
                         WHEN thumb_key IS NOT NULL AND thumb_ready = 0 THEN thumb_bytes ELSE 0 END) AS b FROM files`,
      );
      const now = this.usage();
      const bytesUsed = sum?.b ?? 0;
      const files = sum?.n ?? 0;
      const bytesReserved = reserved?.b ?? 0;
      const drifted =
        now.bytesUsed !== bytesUsed || now.files !== files || now.bytesReserved !== bytesReserved;
      if (drifted)
        this.sql.run(
          "UPDATE usage SET bytes_used = ?, files = ?, bytes_reserved = ? WHERE id = 1",
          bytesUsed,
          files,
          bytesReserved,
        );
      return { drifted, bytesUsed, files };
    });
  }
}

/** A size said in words people use. */
export function megabytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
  return `${Number((bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0))} MB`;
}
