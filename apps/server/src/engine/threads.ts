import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SHARED_OWNER } from "../../../../packages/chat-core/src/shared.ts";
import {
  type ChannelThread,
  ORCHESTRATOR_CHANNEL_ID,
} from "../../../../packages/domain/src/agent.ts";

/** Filesystem-safe channel directory name (also used for permissions.json). */
export function safeChannelDirName(channelId: string): string {
  return channelId.replace(/[^a-z0-9-]/g, "-").slice(0, 80) || "channel";
}

/**
 * Channels are shared across users; each user's orchestrator is private.
 * Shared channels live under the "shared" owner, orchestrators under their user.
 */
export { SHARED_OWNER };

/** Which disk owner a channel's files live under. */
export function diskOwnerForChannel(channelId: string, owner: string): string {
  return channelId === ORCHESTRATOR_CHANNEL_ID ? owner : SHARED_OWNER;
}

/** Filesystem-safe owner directory name. */
export function safeOwnerDir(owner: string): string {
  return (
    owner
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "owner"
  );
}

/** A user's (or the shared) root on the API server's local disk, under DATA_DIR. */
export function ownerDir(baseDir: string, owner: string): string {
  return join(baseDir, "owners", safeOwnerDir(owner));
}

/**
 * A channel's working directory on the API server's local disk, under DATA_DIR.
 * Shared channels live under the "shared" owner; each user's orchestrator
 * lives under their own owner, so everyone gets a private orchestrator.
 * These directories are the OpenCode session working directories.
 */
export function channelWorkspaceDir(baseDir: string, owner: string, channelId: string): string {
  return join(ownerDir(baseDir, owner), "channels", safeChannelDirName(channelId));
}

const threadsDir = (baseDir: string, owner: string, channelId: string) =>
  join(channelWorkspaceDir(baseDir, owner, channelId), "threads");
const bindingPath = (baseDir: string, owner: string, channelId: string, threadId: string) =>
  join(threadsDir(baseDir, owner, channelId), `${threadId}.json`);

/**
 * Thread ↔ channel bindings, stored as one JSON file per thread inside the
 * channel's workspace directory (OpenCode-style), not in the records table.
 * Bindings are append-only and never rebound.
 */
export interface ThreadBindingStore {
  write(owner: string, binding: ChannelThread): Promise<void>;
  list(owner: string, channelId: string): Promise<ChannelThread[]>;
  /** Every binding across channels; used for thread → channel reverse lookup. */
  scan(owner: string): Promise<ChannelThread[]>;
}

/** Production implementation: bindings live on the API server's local disk. */
export class LocalDiskThreadStore implements ThreadBindingStore {
  constructor(private readonly baseDir: string) {}

  async write(owner: string, binding: ChannelThread): Promise<void> {
    const diskOwner = diskOwnerForChannel(binding.channelId, owner);
    const dir = threadsDir(this.baseDir, diskOwner, binding.channelId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      bindingPath(this.baseDir, diskOwner, binding.channelId, binding.threadId),
      JSON.stringify(binding),
    );
  }

  async list(owner: string, channelId: string): Promise<ChannelThread[]> {
    const diskOwner = diskOwnerForChannel(channelId, owner);
    const dir = threadsDir(this.baseDir, diskOwner, channelId);
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out: ChannelThread[] = [];
    for (const name of names) {
      try {
        const binding = JSON.parse(await readFile(join(dir, name), "utf8")) as ChannelThread;
        if (binding.threadId && binding.channelId === channelId) out.push(binding);
      } catch {
        /* skip unreadable bindings */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Every binding the user can see: shared channels plus their own
   * orchestrator. Used for thread → channel reverse lookup.
   */
  async scan(owner: string): Promise<ChannelThread[]> {
    const owners = owner === SHARED_OWNER ? [SHARED_OWNER] : [SHARED_OWNER, owner];
    const out: ChannelThread[] = [];
    for (const diskOwner of owners) {
      const channelsRoot = join(ownerDir(this.baseDir, diskOwner), "channels");
      let channelDirs: string[];
      try {
        channelDirs = (await readdir(channelsRoot, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const dirName of channelDirs) {
        // The directory name is the sanitized channel id; bindings carry the true id.
        for (const binding of await this.listByDir(diskOwner, dirName)) out.push(binding);
      }
    }
    return out;
  }

  private async listByDir(diskOwner: string, dirName: string): Promise<ChannelThread[]> {
    const dir = join(ownerDir(this.baseDir, diskOwner), "channels", dirName, "threads");
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out: ChannelThread[] = [];
    for (const name of names) {
      try {
        const binding = JSON.parse(await readFile(join(dir, name), "utf8")) as ChannelThread;
        if (binding.threadId && binding.channelId) out.push(binding);
      } catch {
        /* skip unreadable bindings */
      }
    }
    return out;
  }
}

/** In-memory implementation for tests. */
export class MemoryThreadStore implements ThreadBindingStore {
  private readonly bindings = new Map<string, ChannelThread>();

  async write(_owner: string, binding: ChannelThread): Promise<void> {
    this.bindings.set(`${binding.channelId}/${binding.threadId}`, binding);
  }

  async list(_owner: string, channelId: string): Promise<ChannelThread[]> {
    return [...this.bindings.values()]
      .filter((b) => b.channelId === channelId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async scan(_owner: string): Promise<ChannelThread[]> {
    return [...this.bindings.values()];
  }
}
