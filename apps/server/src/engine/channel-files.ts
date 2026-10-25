import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { AppError } from "../../../../packages/chat-core/src/errors.ts";
import type { Channel } from "../../../../packages/domain/src/agent.ts";
import {
  type ChannelFile,
  type ChannelFolder,
  channelFileLimits,
  describeFile,
  textKinds,
  uploadsFolder,
} from "../../../../packages/domain/src/workspace-files.ts";
import type { Files } from "../files.ts";
import { channelWorkspaceDir, diskOwnerForChannel } from "./threads.ts";

/** Folders at the top of a workspace that Hive keeps for itself: thread bindings and staged task files. */
const internal = new Set(["threads", "attachments"]);
/** Folders no one wants to browse: what installing and running code leaves behind. */
const clutter = new Set(["node_modules", "__pycache__"]);
/** How far down, and how many files in, the list of recent files looks. */
const recentDepth = 6;
const recentScan = 5000;

/** A name that is not a place a person or an agent should reach. Case is ignored: some disks do. */
const hiddenSegment = (name: string) => name.startsWith(".") || clutter.has(name.toLowerCase());
/** Hidden files and folders, and Hive's own folders at the top, are neither listed nor served. */
const hidden = (segments: string[]) =>
  segments.some(hiddenSegment) || (segments.length > 0 && internal.has(segments[0].toLowerCase()));
/** A name that can be listed, linked to and written back: no path separators or control characters. */
const plainName = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  !/[\\/]/.test(name) &&
  Array.from(name).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const unavailable = () => new AppError("That file is not available", 404);

/** The parts of a path relative to a workspace, or an error if it could point anywhere else. */
function segmentsOf(raw: string): string[] {
  if (raw.length > 1024 || raw.startsWith("/")) throw new AppError("That path is not valid", 400);
  const segments = raw.split("/").filter((part) => part && part !== ".");
  if (segments.some((part) => part === ".." || !plainName(part)))
    throw new AppError("That path is not valid", 400);
  return segments;
}

const outside = (inside: string) => inside === ".." || inside.startsWith(`..${sep}`);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code(error) ?? "");

/** A name a person's upload can be saved under: no path, no odd characters, a bounded length. */
function uploadName(raw: string): string {
  const base = Array.from(raw.split(/[\\/]/).at(-1) ?? "")
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .replace(/[^\p{L}\p{N}._ ()+,&'-]/gu, "_")
    .replace(/^\.+/, "");
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
  const stem = (extension ? base.slice(0, dot) : base).trim().slice(0, 100).trim() || "file";
  const name = `${stem}${extension}`;
  return hiddenSegment(name) ? `_${name}` : name;
}

/** `Start of the file`, for a card to show: text only, and only if it looks like text. */
async function excerptOf(real: string): Promise<string | undefined> {
  const handle = await open(real, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return undefined;
    const text = new TextDecoder().decode(bytes).trim();
    return text ? text.slice(0, channelFileLimits.excerptChars) : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * The files in a channel's workspace: the folder its agent works in, which is also where what the
 * agent makes ends up. A shared channel has one workspace for everyone; each person's orchestrator
 * has a private one.
 *
 * Everything goes through `resolve`, which keeps every path inside the workspace, even when the
 * agent has left a link pointing out of it, and keeps Hive's own folders and hidden files out of
 * reach. Bytes leave through time-limited links that carry what they are good for: one file, or for
 * a web page, the folder it sits in, so the files it refers to load too.
 */
export class ChannelFiles {
  constructor(
    private readonly config: { dataDir: string; publicUrl: string },
    private readonly files: Pick<Files, "signToken" | "verifyToken">,
    private readonly channel: (owner: string, channelId: string) => Promise<Channel | null>,
  ) {}

  /** The workspace folder of a channel the person can see; made if it is not there yet. */
  private async root(owner: string, channelId: string, write = false): Promise<string> {
    const channel = await this.channel(owner, channelId);
    if (!channel) throw new AppError("Channel not found", 404);
    if (write && channel.status === "archived")
      throw new AppError("This channel is archived, so files cannot be added", 409);
    const root = channelWorkspaceDir(
      this.config.dataDir,
      diskOwnerForChannel(channelId, owner),
      channelId,
    );
    await mkdir(root, { recursive: true });
    return root;
  }

  /** Where `segments` really is, if it is inside the workspace and not one of Hive's own places. */
  private async resolve(root: string, segments: string[]): Promise<string> {
    if (hidden(segments)) throw unavailable();
    const base = await realpath(root);
    let real: string;
    try {
      real = await realpath(join(base, ...segments));
    } catch (error) {
      if (missing(error)) throw new AppError("File not found", 404);
      throw error;
    }
    const inside = relative(base, real);
    // A link left in the workspace can point anywhere, including at a hidden place inside it.
    if (outside(inside) || isAbsolute(inside) || hidden(inside.split(sep).filter(Boolean)))
      throw unavailable();
    return real;
  }

  /** Make each folder of the path, one at a time, never going through a link. */
  private async ensureFolder(root: string, segments: string[]): Promise<void> {
    let at = await realpath(root);
    for (const part of segments) {
      at = join(at, part);
      try {
        const info = await lstat(at);
        if (!info.isDirectory()) throw new AppError("Choose a different folder", 422);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (code(error) !== "ENOENT") throw error;
        await mkdir(at);
      }
    }
  }

  private describe(segments: string[], info: { size: number; mtime: Date }): ChannelFile {
    const name = segments.at(-1) ?? "";
    return {
      name,
      path: segments.join("/"),
      type: "file",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      ...describeFile(name),
    };
  }

  /**
   * A time-limited link to the file. A web page's link is good for its folder, so the styles,
   * scripts and images it refers to by relative path load too; every other link is good for the
   * one file.
   */
  link(owner: string, channelId: string, file: ChannelFile): string {
    const scope = file.kind === "html" ? dirname(file.path).replace(/^\.$/, "") : file.path;
    const token = this.files.signToken(owner, `${channelId}\n${scope}`);
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    return `${this.config.publicUrl}/api/agent/channels/${encodeURIComponent(channelId)}/view/${token}/${path}`;
  }

  /** The path of a file as the workspace names it, whether the agent gave it that way or in full. */
  async pathOf(owner: string, channelId: string, raw: string): Promise<string> {
    if (!raw.startsWith("/")) return segmentsOf(raw).join("/");
    const root = await this.root(owner, channelId);
    for (const base of [root, await realpath(root)]) {
      const inside = relative(base, raw);
      if (inside && !outside(inside) && !isAbsolute(inside))
        return segmentsOf(inside.split(sep).join("/")).join("/");
    }
    throw new AppError("Share files from inside this channel's workspace", 422);
  }

  /** The folder files for a request go in: the uploads folder unless named, never hidden or Hive's own. */
  async folderFor(owner: string, channelId: string, raw?: string): Promise<string> {
    await this.root(owner, channelId, true);
    const segments = segmentsOf(raw?.trim() || uploadsFolder);
    if (!segments.length || hidden(segments)) throw new AppError("Choose a different folder", 422);
    return segments.join("/");
  }

  /** One folder: folders first, then files, each by name. Links are never followed. */
  async list(owner: string, channelId: string, path = ""): Promise<ChannelFolder> {
    const root = await this.root(owner, channelId);
    const segments = segmentsOf(path);
    const real = await this.resolve(root, segments);
    if (!(await stat(real)).isDirectory()) throw new AppError("That is not a folder", 400);
    const entries: ChannelFile[] = [];
    for (const entry of await readdir(real, { withFileTypes: true })) {
      const here = [...segments, entry.name];
      if (!plainName(entry.name) || hidden(here)) continue;
      if (!entry.isFile() && !entry.isDirectory()) continue;
      let info: Stats;
      try {
        info = await lstat(join(real, entry.name));
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      entries.push(
        entry.isDirectory()
          ? {
              name: entry.name,
              path: here.join("/"),
              type: "folder",
              size: 0,
              modifiedAt: info.mtime.toISOString(),
            }
          : this.describe(here, info),
      );
    }
    entries.sort(
      (a, b) =>
        Number(b.type === "folder") - Number(a.type === "folder") || a.name.localeCompare(b.name),
    );
    const limit = channelFileLimits.listEntries;
    return {
      channelId,
      path: segments.join("/"),
      entries: entries.slice(0, limit).map((file) => this.withLink(owner, channelId, file)),
      truncated: entries.length > limit,
    };
  }

  /** The files changed most recently anywhere in the workspace, newest first. */
  async recent(
    owner: string,
    channelId: string,
    limit: number = channelFileLimits.recentFiles,
  ): Promise<ChannelFolder> {
    const root = await realpath(await this.root(owner, channelId));
    const found: ChannelFile[] = [];
    const folders: string[][] = [[]];
    let scanned = 0;
    while (folders.length && scanned < recentScan) {
      const segments = folders.pop() as string[];
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, ...segments), { withFileTypes: true });
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        const here = [...segments, entry.name];
        if (!plainName(entry.name) || hidden(here)) continue;
        if (entry.isDirectory()) {
          if (here.length < recentDepth) folders.push(here);
        } else if (entry.isFile()) {
          scanned++;
          try {
            found.push(this.describe(here, await lstat(join(root, ...here))));
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
      }
    }
    found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
    return {
      channelId,
      path: "",
      entries: found.slice(0, limit).map((file) => this.withLink(owner, channelId, file)),
      truncated: found.length > limit,
    };
  }

  private withLink(owner: string, channelId: string, file: ChannelFile): ChannelFile {
    return file.type === "file" ? { ...file, url: this.link(owner, channelId, file) } : file;
  }

  /** One file, with a link to it and, if it is text, the start of it. */
  async info(owner: string, channelId: string, path: string): Promise<ChannelFile> {
    const root = await this.root(owner, channelId);
    const segments = segmentsOf(path);
    const real = await this.resolve(root, segments);
    const info = await stat(real);
    if (!info.isFile()) throw new AppError("That is not a file", 400);
    const file = this.describe(segments, info);
    const excerpt = file.kind && textKinds.has(file.kind) ? await excerptOf(real) : undefined;
    return this.withLink(owner, channelId, { ...file, ...(excerpt ? { excerpt } : {}) });
  }

  /** A file's bytes, for a run to send on: no larger than `limit`, from inside the workspace only. */
  async read(
    owner: string,
    channelId: string,
    path: string,
    limit: number,
  ): Promise<{ file: ChannelFile; bytes: Uint8Array }> {
    const root = await this.root(owner, channelId);
    const segments = segmentsOf(path);
    const real = await this.resolve(root, segments);
    const info = await stat(real);
    if (!info.isFile()) throw new AppError("That is not a file", 400);
    if (info.size > limit) throw new AppError("That file is too large to share here", 413);
    return { file: this.describe(segments, info), bytes: await readFile(real) };
  }

  /**
   * The file a link points at, if the link is good and `path` is in what it covers. Anyone holding
   * the link has what its owner had, so this also checks the channel is still the owner's to see.
   */
  async byLink(token: string, channelId: string, path: string) {
    const { owner, subject } = this.files.verifyToken(token);
    const split = subject.indexOf("\n");
    const scopeChannel = split < 0 ? subject : subject.slice(0, split);
    const scope = split < 0 ? "" : subject.slice(split + 1);
    const segments = segmentsOf(path);
    const wanted = segments.join("/");
    if (
      scopeChannel !== channelId ||
      !(scope === "" || wanted === scope || wanted.startsWith(`${scope}/`))
    )
      throw new AppError("Invalid access link", 403);
    const real = await this.resolve(await this.root(owner, channelId), segments);
    const info = await stat(real);
    if (!info.isFile()) throw new AppError("That is not a file", 400);
    return { owner, real, file: this.describe(segments, info) };
  }

  /** Add a file a person chose. A name already taken is kept, and the new file gets `(2)`, `(3)`... */
  async save(
    owner: string,
    channelId: string,
    folder: string | undefined,
    rawName: string,
    bytes: Uint8Array,
  ): Promise<ChannelFile> {
    if (!bytes.length) throw new AppError("That file is empty", 422);
    if (bytes.length > channelFileLimits.uploadBytes)
      throw new AppError(
        `Files must be ${channelFileLimits.uploadBytes / (1024 * 1024)} MB or smaller`,
        413,
      );
    const root = await this.root(owner, channelId, true);
    const segments = segmentsOf(folder?.trim() || uploadsFolder);
    if (hidden(segments)) throw new AppError("Choose a different folder", 422);
    await this.ensureFolder(root, segments);
    const real = await this.resolve(root, segments);
    const name = uploadName(rawName);
    const dot = name.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
      try {
        // `wx` never replaces a file, and never writes through a link that is already there.
        const handle = await open(join(real, candidate), "wx", 0o644);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        return this.withLink(
          owner,
          channelId,
          this.describe([...segments, candidate], await stat(join(real, candidate))),
        );
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
    }
    throw new AppError("Too many files with that name; rename it and try again", 409);
  }

  /** Write a text file for the agent, replacing what is there. Used when the agent has no files of its own. */
  async write(owner: string, channelId: string, path: string, text: string): Promise<ChannelFile> {
    const bytes = new TextEncoder().encode(text);
    if (!bytes.length) throw new AppError("That file would be empty", 422);
    if (bytes.length > channelFileLimits.writeBytes)
      throw new AppError(
        `Text files written this way must be ${channelFileLimits.writeBytes / 1024} KB or smaller`,
        413,
      );
    const root = await this.root(owner, channelId, true);
    const segments = segmentsOf(path);
    if (!segments.length || hidden(segments)) throw unavailable();
    const folder = segments.slice(0, -1);
    await this.ensureFolder(root, folder);
    const real = await this.resolve(root, folder);
    const target = join(real, segments.at(-1) as string);
    // `O_NOFOLLOW` makes a link at the target an error instead of a way out of the workspace.
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o644,
    ).catch((error) => {
      if (code(error) === "ELOOP" || code(error) === "EISDIR")
        throw new AppError("That path is not a file", 422);
      throw error;
    });
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return this.withLink(owner, channelId, this.describe(segments, await stat(target)));
  }
}

/**
 * The bytes a `Range` header asks for, or undefined to send the whole file. A video cannot be
 * played or skipped through without this. `unsatisfiable` means answer 416.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return undefined;
  let start: number;
  let end: number;
  if (!match[1]) {
    // `-N` is the last N bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}
