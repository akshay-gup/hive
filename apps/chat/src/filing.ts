import { z } from "zod";
import type { Access, Person } from "../../../packages/chat-core/src/access.ts";
import { isIn, managesChannel } from "../../../packages/chat-core/src/access.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { ChatEvent, Events } from "../../../packages/chat-core/src/events.ts";
import type { FileRow, Files } from "../../../packages/chat-core/src/files.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { RecordStore } from "../../../packages/chat-core/src/store.ts";
import type { Channel } from "../../../packages/domain/src/agent.ts";
import { type LinkKind, signedPath, type Variant } from "./uploads.ts";

/** How long the address to send a file to, or to fetch it from, lasts. */
const UPLOAD_MS = 15 * 60_000;
const DOWNLOAD_MS = 5 * 60_000;

export const beginUploadSchema = z.object({
  channelId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  mime: z.string().max(200).default("application/octet-stream"),
  bytes: z.number().int().positive(),
  /** A smaller picture to show in the conversation, if the app made one. */
  thumbBytes: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 ** 2)
    .optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
});

/**
 * Sending files and fetching them. The room decides who may, and gives out an address good for that one
 * thing; the Worker, which holds the bucket, does the carrying and tells the room what arrived. The
 * room never waits on the bucket.
 */
export class Filing {
  constructor(
    private readonly deps: {
      store: RecordStore;
      access: Access;
      files: Files;
      events: Events;
      publish: (event: ChatEvent) => void;
      /** The key addresses are signed with, and the workspace they are for. */
      linkKey: () => string | undefined;
      /** There is work for the bucket (things to delete, uploads to expire) to be done soon. */
      workQueued: () => void;
      /** Said when a file leaves a message that is still there, so screens update it. */
      fileGone: (file: FileRow) => void;
    },
  ) {}

  private async open(
    owner: string,
    channelId: string,
  ): Promise<{ channel: Channel; person: Person }> {
    await this.deps.access.assertChannel(owner, channelId);
    const channel = await this.deps.store.get<Channel>(SHARED_OWNER, "channels", channelId);
    const person = await this.deps.access.person(owner);
    if (!channel || !person?.email) throw new AppError("Channel not found", 404);
    return { channel, person };
  }

  private key(): string {
    const key = this.deps.linkKey();
    if (!key) throw new AppError("Sending files is not set up here", 503);
    return key;
  }

  private path(
    workspaceId: string,
    kind: LinkKind,
    file: FileRow,
    variant: Variant,
    ms: number,
    bytes?: number,
  ) {
    const exp = Date.now() + ms;
    return {
      path: signedPath(this.key(), { workspaceId, kind, fileId: file.id, variant, exp, bytes }),
      expiresAt: exp,
    };
  }

  /** A person is going to send a file to a channel: room is set aside, and they are given where to send it. */
  async begin(owner: string, workspaceId: string, raw: unknown) {
    const input = beginUploadSchema.parse(raw);
    const { channel, person } = await this.open(owner, input.channelId);
    if (channel.status === "archived") throw new AppError("This channel is archived", 409);
    if (!isIn(person, channel)) throw new AppError("Join the channel to take part in it", 403);
    this.key();
    const file = this.deps.files.reserve({
      channelId: channel.id,
      uploaderId: owner,
      name: input.name,
      mime: input.mime,
      bytes: input.bytes,
      thumbBytes: input.thumbBytes,
      width: input.width,
      height: input.height,
    });
    this.deps.workQueued();
    const upload = this.path(workspaceId, "up", file, "file", UPLOAD_MS, file.bytes);
    const thumb =
      file.thumbKey && file.thumbBytes > 0
        ? this.path(workspaceId, "up", file, "thumb", UPLOAD_MS, file.thumbBytes)
        : undefined;
    return {
      fileId: file.id,
      upload: upload.path,
      ...(thumb ? { thumbUpload: thumb.path } : {}),
      expiresAt: upload.expiresAt,
    };
  }

  /** An address to fetch a file from, for someone who may open its channel. */
  async link(owner: string, workspaceId: string, fileId: string, variant: Variant) {
    const file = this.deps.files.get(fileId);
    if (!file || file.state !== "ready") throw new AppError("File not found", 404);
    await this.open(owner, file.channelId);
    if (variant === "thumb" && !file.thumbReady) throw new AppError("File not found", 404);
    return this.path(workspaceId, "dl", file, variant, DOWNLOAD_MS);
  }

  async inChannel(owner: string, channelId: string): Promise<FileRow[]> {
    await this.open(owner, channelId);
    return this.deps.files.inChannel(channelId);
  }

  /** A file leaves: its sender, a manager of the channel, the owner or an admin who can open it. */
  async remove(owner: string, fileId: string): Promise<{ ok: true }> {
    const file = this.deps.files.get(fileId);
    if (!file) throw new AppError("File not found", 404);
    const { channel, person } = await this.open(owner, file.channelId);
    if (channel.status === "archived") throw new AppError("This channel is archived", 409);
    if (file.uploaderId !== owner && !managesChannel(person, channel))
      throw new AppError(
        "Only who sent a file, a channel manager, an admin or the owner can delete it",
        403,
      );
    this.deps.files.remove(fileId);
    this.deps.workQueued();
    this.deps.fileGone(file);
    return { ok: true };
  }

  // What the Worker asks of the room, once it has checked an address (see room-logic.ts)

  /** Is this upload one that is waiting for its bytes? What the Worker needs to carry it. */
  uploadState(fileId: string, variant: Variant) {
    const file = this.deps.files.get(fileId);
    if (!file) return null;
    if (variant === "file" && file.state === "pending")
      return { mime: file.mime, bytes: file.bytes, key: file.r2Key };
    if (variant === "thumb" && file.state === "ready" && file.thumbKey && !file.thumbReady)
      return { mime: "image/webp", bytes: file.thumbBytes, key: file.thumbKey };
    return null;
  }

  /** The bytes have arrived, as many as the bucket says. */
  uploaded(fileId: string, variant: Variant, bytes: number): FileRow {
    const file =
      variant === "file"
        ? this.deps.files.complete(fileId, bytes)
        : this.deps.files.completeThumb(fileId, bytes);
    this.deps.workQueued();
    const event = this.deps.events.append(
      "file.ready",
      { fileId, variant },
      { userId: file.uploaderId, channelId: file.channelId },
    );
    this.deps.publish(event);
    return file;
  }

  /** What the Worker needs to fetch a file. */
  download(fileId: string, variant: Variant) {
    const file = this.deps.files.get(fileId);
    if (!file || file.state !== "ready") return null;
    if (variant === "thumb")
      return file.thumbKey && file.thumbReady
        ? { key: file.thumbKey, mime: "image/webp", name: file.name, bytes: file.thumbBytes }
        : null;
    return { key: file.r2Key, mime: file.mime, name: file.name, bytes: file.bytes };
  }
}
