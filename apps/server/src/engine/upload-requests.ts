import { createHash } from "node:crypto";
import { AppError } from "../../../../packages/chat-core/src/errors.ts";
import { ORCHESTRATOR_CHANNEL_ID } from "../../../../packages/domain/src/agent.ts";
import {
  type UploadedFile,
  type UploadRequest,
  type UploadRequestState,
  uploadRequestLimits,
} from "../../../../packages/domain/src/workspace-files.ts";
import type { Store } from "../db.ts";
import { requesterNames } from "../requesters.ts";

interface Stored extends UploadRequestState {
  id: string;
  /** Who the agent was working for, which decides who may see a request in a private channel. */
  owner: string;
}

/**
 * Requests an agent has made for files, and what has been uploaded for each. The agent's tool call
 * returns at once, so this is where "did they answer" lives: the chat card reads it, and each
 * upload made for a request is recorded here, in the folder the agent asked for.
 */
export class UploadRequests {
  constructor(private readonly db: Store) {}

  /**
   * Record a request. `key` identifies the tool call, so a call that is retried is the same request
   * rather than a second one.
   */
  async create(
    owner: string,
    channelId: string,
    key: string,
    ask: { prompt: string; accept?: string[]; multiple: boolean; folder: string },
  ): Promise<UploadRequest> {
    const requestId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const stored: Stored = {
      id: requestId,
      owner,
      requestId,
      channelId,
      ...ask,
      files: [],
      createdAt: new Date().toISOString(),
    };
    const record = (await this.db.insertIfAbsent(owner, "upload-requests", stored)) ?? stored;
    return {
      requested: true,
      channelId: record.channelId,
      requestId: record.requestId,
      prompt: record.prompt,
      ...(record.accept?.length ? { accept: record.accept } : {}),
      multiple: record.multiple,
      folder: record.folder,
    };
  }

  private async stored(owner: string, channelId: string, requestId: string): Promise<Stored> {
    const found = /^[a-f0-9]{16}$/.test(requestId)
      ? await this.db.get<Stored>(owner, "upload-requests", requestId)
      : null;
    // A person's own orchestrator is private, so its requests are too.
    if (
      !found ||
      found.channelId !== channelId ||
      (channelId === ORCHESTRATOR_CHANNEL_ID && found.owner !== owner)
    )
      throw new AppError("Upload request not found", 404);
    return found;
  }

  /** The request as a client sees it. */
  async get(owner: string, channelId: string, requestId: string): Promise<UploadRequestState> {
    const { id: _id, owner: _owner, ...request } = await this.stored(owner, channelId, requestId);
    const names = await requesterNames(
      this.db,
      request.files.map((file) => file.uploadedBy),
    );
    return {
      ...request,
      files: request.files.map((file) => ({
        ...file,
        uploadedByName: file.uploadedBy ? names.get(file.uploadedBy) : undefined,
        mine: file.uploadedBy === owner,
      })),
    };
  }

  /** Whether the request still takes a file, and where it goes; throws a message to show if not. */
  async folder(owner: string, channelId: string, requestId: string): Promise<string> {
    const request = await this.stored(owner, channelId, requestId);
    if (!request.multiple && request.files.length >= 1)
      throw new AppError("This request asked for one file, and it already has one", 409);
    if (request.files.length >= uploadRequestLimits.files)
      throw new AppError("This request has all the files it can take", 409);
    return request.folder;
  }

  /** Record a file added for the request. */
  async attach(
    owner: string,
    channelId: string,
    requestId: string,
    file: { path: string; name: string; size: number; kind?: UploadedFile["kind"] },
  ): Promise<void> {
    const request = await this.stored(owner, channelId, requestId);
    const entry: UploadedFile = {
      ...file,
      uploadedAt: new Date().toISOString(),
      uploadedBy: owner,
    };
    // One statement, so two people adding at once never drop one of the files.
    const next = await this.db.appendItem<Stored>(
      owner,
      "upload-requests",
      request.id,
      "files",
      entry,
      {
        max: request.multiple ? uploadRequestLimits.files : 1,
      },
    );
    if (!next) throw new AppError("This request has all the files it can take", 409);
  }
}
