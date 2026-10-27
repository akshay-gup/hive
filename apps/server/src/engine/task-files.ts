import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../../../../packages/chat-core/src/errors.ts";
import {
  type AgentTask,
  attachmentTypes,
  taskBriefLimits,
} from "../../../../packages/domain/src/agent.ts";

/** A task's file as the agent finds it: a path inside the workspace its run works in. */
export interface StagedFile {
  id: string;
  /** What the person called it. */
  name: string;
  /** Relative to the workspace directory, e.g. `attachments/<taskId>/form.pdf`. */
  path: string;
  mimeType: string;
  size: number;
  fileId?: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const textTypes = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const startsWith = (bytes: Uint8Array, ...signature: number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

/** Whether the first bytes agree with what the extension claims, so a renamed file is refused. */
function looksLike(extension: string, bytes: Uint8Array): boolean {
  switch (extension) {
    case ".pdf":
      return startsWith(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d);
    case ".png":
      return startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case ".jpg":
    case ".jpeg":
      return startsWith(bytes, 0xff, 0xd8, 0xff);
    case ".gif":
      return startsWith(bytes, 0x47, 0x49, 0x46, 0x38) && [0x37, 0x39].includes(bytes[4]);
    case ".webp":
      return (
        startsWith(bytes, 0x52, 0x49, 0x46, 0x46) &&
        startsWith(bytes.subarray(8), 0x57, 0x45, 0x42, 0x50)
      );
    default:
      // Text: valid UTF-8 and no NUL bytes.
      if (bytes.includes(0)) return false;
      try {
        utf8.decode(bytes);
        return true;
      } catch {
        return false;
      }
  }
}

/** The name a file is shown by: no path, no control characters, a bounded length, a known extension. */
function displayName(raw: string, extension: string): string {
  const base = Array.from(raw.split(/[\\/]/).at(-1) ?? "")
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .trim();
  const stem = base.slice(0, Math.max(0, base.length - extension.length)).replace(/^\.+/, "");
  return `${stem.slice(0, 100).trim() || "file"}${extension}`;
}

/** Check a file a person wants to attach. Returns what to store, or throws a message they can act on. */
export function inspectAttachment(
  rawName: string,
  bytes: Uint8Array,
): { name: string; mimeType: string } {
  const dot = rawName.lastIndexOf(".");
  const extension = dot < 0 ? "" : rawName.slice(dot).toLowerCase();
  const mimeType = attachmentTypes[extension];
  if (!mimeType)
    throw new AppError(
      `Attach a PDF, an image, or a text, Markdown, CSV or JSON file (${Object.keys(attachmentTypes).join(", ")})`,
      422,
    );
  if (!bytes.length) throw new AppError("That file is empty", 422);
  if (bytes.length > taskBriefLimits.attachmentBytes)
    throw new AppError(
      `Files must be ${taskBriefLimits.attachmentBytes / (1024 * 1024)} MB or smaller`,
      413,
    );
  if (!looksLike(extension, bytes))
    throw new AppError(`That file is not a real ${extension.slice(1).toUpperCase()} file`, 422);
  return { name: displayName(rawName, extension), mimeType };
}

/** A name that is safe as one path segment on disk. */
const diskName = (name: string) => name.replace(/[^\p{L}\p{N}._ ()-]/gu, "_");

/**
 * Where a task's file bytes live, and how they reach the agent.
 *
 * Bytes sit under `<data dir>/task-files/<task id>/<attachment id>`, away from the agent's
 * workspace, and leave only through a signed, per-task download link. Each run copies them into
 * the workspace it works in (`attachments/<task id>/`), so the agent reads them like any file.
 */
export class TaskFiles {
  constructor(private readonly dataDir: string) {}

  private directory(taskId: string): string {
    if (!/^[\w-]+$/.test(taskId)) throw new AppError("That task is not there, or you cannot see it.", 404);
    return join(this.dataDir, "task-files", taskId);
  }
  private path(taskId: string, id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new AppError("File not found", 404);
    return join(this.directory(taskId), id);
  }

  async save(taskId: string, id: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.directory(taskId), { recursive: true, mode: 0o700 });
    await writeFile(this.path(taskId, id), bytes, { mode: 0o600, flag: "wx" });
  }
  async read(taskId: string, id: string) {
    try {
      return await readFile(this.path(taskId, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new AppError("File not found", 404);
      throw error;
    }
  }
  async remove(taskId: string, id: string): Promise<void> {
    await rm(this.path(taskId, id), { force: true });
  }
  /** Everything stored for the task, and the copies staged for the agent in `workspace`. */
  async removeAll(taskId: string, workspace?: string): Promise<void> {
    await rm(this.directory(taskId), { recursive: true, force: true });
    if (workspace)
      await rm(join(workspace, "attachments", taskId), { recursive: true, force: true });
  }

  /** The text of the task's text files, cut to `maxChars`, for an agent that cannot open files itself. */
  async readText(
    task: AgentTask,
    files: StagedFile[],
    maxChars: number,
  ): Promise<Map<string, string>> {
    const text = new Map<string, string>();
    for (const file of files) {
      if (!textTypes.has(file.mimeType)) continue;
      try {
        const bytes = await this.read(task.id, file.id);
        // A character is at most four bytes, so this reads enough without decoding a whole 10 MB file.
        text.set(
          file.id,
          new TextDecoder().decode(bytes.subarray(0, maxChars * 4)).slice(0, maxChars),
        );
      } catch (error) {
        if (!(error instanceof AppError && error.status === 404)) throw error;
      }
    }
    return text;
  }

  /** Where each of the task's files goes in a workspace. Stable, and unique within the task. */
  layout(task: AgentTask): StagedFile[] {
    const used = new Set<string>();
    return (task.attachments ?? []).map((attachment) => {
      const base = diskName(attachment.name);
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const extension = dot > 0 ? base.slice(dot) : "";
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}${extension}`;
      used.add(name.toLowerCase());
      return {
        id: attachment.id,
        name: attachment.name,
        path: `attachments/${task.id}/${name}`,
        mimeType: attachment.mimeType,
        size: attachment.size,
        ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
      };
    });
  }

  /**
   * Copy the task's files into `workspace` and say where they went. A full stage first clears the
   * folder, so a removed file does not linger; `only` adds named files to what is already there.
   * A file that has gone missing from storage is skipped rather than failing the run.
   */
  async stage(
    task: AgentTask,
    workspace: string,
    only?: ReadonlySet<string>,
  ): Promise<StagedFile[]> {
    const folder = join(workspace, "attachments", task.id);
    if (!only) await rm(folder, { recursive: true, force: true });
    const layout = this.layout(task);
    if (!layout.length) return [];
    await mkdir(folder, { recursive: true });
    const staged: StagedFile[] = [];
    for (const file of layout) {
      if (only && !only.has(file.id)) continue;
      try {
        await copyFile(this.path(task.id, file.id), join(workspace, file.path));
        staged.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return staged;
  }
}
