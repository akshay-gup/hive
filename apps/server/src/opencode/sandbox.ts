/**
 * What keeps the agent out of a private channel's folder.
 *
 * Every command the agent runs goes through apps/workspace/vm/hive-sandbox, which reads a policy
 * file this writes: while the workspace has a private channel, the command is confined to its own
 * channel's folder, the open channels' folders to read, and the machine. OpenCode's own file tools
 * are not commands and are not confined that way, so a session also gets a rule that denies them
 * everything else on the volume.
 *
 * The policy is written from the channels as they are, whenever a channel is made or changes who
 * may open it and before each run, so it is never kept apart from the channels it describes.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Channel } from "../../../../packages/domain/src/agent.ts";
import { channelWorkspaceDir } from "../engine/threads.ts";
import { SHARED_OWNER } from "../shared.ts";
import type { PermissionRuleset } from "./permissions.ts";

export interface SandboxSettings {
  /** DATA_DIR: where channel folders are, and the workspace's own records. */
  dataDir: string;
  /** Where the policy is written (HIVE_SANDBOX_POLICY). Without it this machine confines nothing. */
  file?: string;
  /** The disk the workspace keeps everything on (HIVE_SANDBOX_VOLUME); by default, where dataDir is. */
  volume?: string;
}

export class SandboxPolicy {
  private written = "";
  private confining = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly volume: string;

  constructor(
    private readonly settings: SandboxSettings,
    private readonly channels: () => Promise<Channel[]>,
  ) {
    this.volume = settings.volume?.trim() || dirname(settings.dataDir);
  }

  /** Whether this machine has a shell that reads the policy. */
  get enabled(): boolean {
    return Boolean(this.settings.file);
  }

  /** Writes the policy for the channels as they are now. A write that fails is an error: an agent let loose on a private channel is worse than one that waits. */
  sync(): Promise<void> {
    const next = this.queue.then(() => this.write());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(): Promise<void> {
    const file = this.settings.file;
    if (!file) return;
    const folders = (await this.channels())
      .filter((channel) => channel.visibility === "private")
      .map((channel) => channelWorkspaceDir(this.settings.dataDir, SHARED_OWNER, channel.id))
      .sort();
    const text = JSON.stringify({
      version: 1,
      confine: folders.length > 0,
      dataDir: this.settings.dataDir,
      private: folders,
    });
    this.confining = folders.length > 0;
    if (text === this.written) return;
    await mkdir(dirname(file), { recursive: true });
    const partial = join(dirname(file), `.${Date.now()}.sandbox-policy`);
    await writeFile(partial, text, { mode: 0o644 });
    // A command that starts at this moment reads the policy as it was or as it is, never half of it.
    await rename(partial, file);
    this.written = text;
  }

  /**
   * The rules that go last in a session's rules: while commands are confined, the file tools may not
   * go outside the channel's own folder on the volume either. The last rule wins, so nothing a channel
   * has said about itself undoes this.
   */
  async rules(): Promise<PermissionRuleset> {
    if (!this.enabled) return [];
    await this.sync();
    return this.confining
      ? [{ permission: "external_directory", pattern: `${this.volume}/*`, action: "deny" }]
      : [];
  }
}
