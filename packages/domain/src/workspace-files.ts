import { z } from "zod";

/**
 * Files in a channel's workspace: what the agent makes there and what people upload to it. The
 * server lists, serves and stores them; every client shows them the same way, by `kind`.
 */

/** How a file is shown, and so which preview a client picks for it. */
export const fileKinds = [
  "image",
  "pdf",
  "video",
  "audio",
  "markdown",
  "html",
  "csv",
  "json",
  "code",
  "text",
  "archive",
  "office",
  "other",
] as const;
export type FileKind = (typeof fileKinds)[number];

export interface FileType {
  mimeType: string;
  kind: FileKind;
}

const image = (subtype: string): FileType => ({ mimeType: `image/${subtype}`, kind: "image" });
const video = (subtype: string): FileType => ({ mimeType: `video/${subtype}`, kind: "video" });
const audio = (subtype: string): FileType => ({ mimeType: `audio/${subtype}`, kind: "audio" });
const archive = (mimeType: string): FileType => ({ mimeType, kind: "archive" });
const other = (mimeType: string): FileType => ({ mimeType, kind: "other" });
/** Source and configuration files are shown as text, whatever their language. */
const code = (mimeType = "text/plain"): FileType => ({ mimeType, kind: "code" });
/** Word, Excel, PowerPoint and Apple's iWork files: a client that can read them shows what is in them. */
const office = (mimeType: string): FileType => ({ mimeType, kind: "office" });
const openXml = (subtype: string) =>
  office(`application/vnd.openxmlformats-officedocument.${subtype}`);

/** What each known extension is. Source files are sent as plain text so a browser never runs them. */
const types: Readonly<Record<string, FileType>> = {
  ".png": image("png"),
  ".jpg": image("jpeg"),
  ".jpeg": image("jpeg"),
  ".gif": image("gif"),
  ".webp": image("webp"),
  ".avif": image("avif"),
  ".bmp": image("bmp"),
  ".ico": image("x-icon"),
  ".svg": image("svg+xml"),
  ".pdf": { mimeType: "application/pdf", kind: "pdf" },
  ".mp4": video("mp4"),
  ".m4v": video("x-m4v"),
  ".webm": video("webm"),
  ".mov": video("quicktime"),
  ".mp3": audio("mpeg"),
  ".wav": audio("wav"),
  ".m4a": audio("mp4"),
  ".aac": audio("aac"),
  ".ogg": audio("ogg"),
  ".oga": audio("ogg"),
  ".flac": audio("flac"),
  ".md": { mimeType: "text/markdown", kind: "markdown" },
  ".markdown": { mimeType: "text/markdown", kind: "markdown" },
  ".html": { mimeType: "text/html", kind: "html" },
  ".htm": { mimeType: "text/html", kind: "html" },
  ".csv": { mimeType: "text/csv", kind: "csv" },
  ".tsv": { mimeType: "text/tab-separated-values", kind: "csv" },
  ".json": { mimeType: "application/json", kind: "json" },
  ".map": { mimeType: "application/json", kind: "code" },
  ".txt": { mimeType: "text/plain", kind: "text" },
  ".text": { mimeType: "text/plain", kind: "text" },
  ".log": { mimeType: "text/plain", kind: "text" },
  // A page and the scripts and styles beside it must keep their own types, or a browser refuses them.
  ".js": code("text/javascript"),
  ".mjs": code("text/javascript"),
  ".cjs": code("text/javascript"),
  ".css": code("text/css"),
  ".ts": code(),
  ".tsx": code(),
  ".jsx": code(),
  ".py": code(),
  ".rb": code(),
  ".go": code(),
  ".rs": code(),
  ".java": code(),
  ".kt": code(),
  ".swift": code(),
  ".c": code(),
  ".h": code(),
  ".cpp": code(),
  ".hpp": code(),
  ".cs": code(),
  ".php": code(),
  ".sh": code(),
  ".bash": code(),
  ".zsh": code(),
  ".sql": code(),
  ".yml": code(),
  ".yaml": code(),
  ".toml": code(),
  ".ini": code(),
  ".xml": code(),
  ".scss": code(),
  ".less": code(),
  ".vue": code(),
  ".svelte": code(),
  ".graphql": code(),
  ".lua": code(),
  ".r": code(),
  ".dart": code(),
  ".zip": archive("application/zip"),
  ".gz": archive("application/gzip"),
  ".tgz": archive("application/gzip"),
  ".tar": archive("application/x-tar"),
  ".7z": archive("application/x-7z-compressed"),
  ".rar": archive("application/vnd.rar"),
  ".docx": openXml("wordprocessingml.document"),
  ".xlsx": openXml("spreadsheetml.sheet"),
  ".pptx": openXml("presentationml.presentation"),
  ".xlsm": office("application/vnd.ms-excel.sheet.macroEnabled.12"),
  ".xls": office("application/vnd.ms-excel"),
  ".ods": office("application/vnd.oasis.opendocument.spreadsheet"),
  ".pages": office("application/vnd.apple.pages"),
  ".numbers": office("application/vnd.apple.numbers"),
  ".key": office("application/vnd.apple.keynote"),
  ".doc": other("application/msword"),
  ".ppt": other("application/vnd.ms-powerpoint"),
  ".woff": other("font/woff"),
  ".woff2": other("font/woff2"),
  ".ttf": other("font/ttf"),
  ".otf": other("font/otf"),
  ".wasm": other("application/wasm"),
  ".webmanifest": other("application/manifest+json"),
};

const unknown: FileType = other("application/octet-stream");

/** The type of a file, from its name alone. Anything unrecognised is a download. */
export function describeFile(name: string): FileType {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? types[name.slice(dot).toLowerCase()] : undefined) ?? unknown;
}

/** Kinds that show their text. A client can read them from a link, so a card can excerpt them. */
export const textKinds: ReadonlySet<FileKind> = new Set([
  "markdown",
  "html",
  "csv",
  "json",
  "code",
  "text",
]);

/** A file or folder in a channel's workspace. */
export interface ChannelFile {
  name: string;
  /** Relative to the channel's workspace, `/`-separated, no leading slash. */
  path: string;
  type: "file" | "folder";
  /** Bytes; 0 for a folder. */
  size: number;
  modifiedAt: string;
  /** Files only. */
  mimeType?: string;
  /** Files only. */
  kind?: FileKind;
  /** A time-limited link to the file's bytes, for the person's browser. Files only. */
  url?: string;
  /** The start of a text file, so a card can show something without downloading it. */
  excerpt?: string;
}

/** One folder of a channel's workspace, or its most recently changed files. */
export interface ChannelFolder {
  channelId: string;
  /** The folder listed; empty is the top of the channel's workspace. */
  path: string;
  entries: ChannelFile[];
  /** True when the folder holds more than `channelFileLimits.listEntries`. */
  truncated: boolean;
}

export const channelFileLimits = {
  /** The largest file a person can add. */
  uploadBytes: 10 * 1024 * 1024,
  /** The largest text file an agent can write while sharing it. */
  writeBytes: 1024 * 1024,
  /** Entries in one folder listing. */
  listEntries: 500,
  /** Files in the recent list unless asked for fewer. */
  recentFiles: 30,
  /** Characters of a text file kept as its excerpt. */
  excerptChars: 1200,
  /** How much of a text file a viewer reads before it says the rest is cut off. */
  textViewBytes: 256 * 1024,
} as const;

/** Where a person's uploads go in a channel's workspace unless they pick a folder. */
export const uploadsFolder = "uploads";

/**
 * What the agent's `send_file` returns, and what a chat card is drawn from. It names the file but
 * carries no link: links expire in minutes and a chat lasts, so a card asks for a fresh one.
 */
export const sentFileSchema = z.object({
  sent: z.literal(true),
  channelId: z.string(),
  file: z.object({
    name: z.string(),
    path: z.string(),
    size: z.number(),
    modifiedAt: z.string(),
    mimeType: z.string().optional(),
    kind: z.enum(fileKinds).optional(),
  }),
  caption: z.string().optional(),
});
/** `send_file` could not share the file, and says why, in words the agent can act on. */
export const unsentFileSchema = z.object({ sent: z.literal(false), error: z.string() });
export type SentFile = z.infer<typeof sentFileSchema>;

/** How much an agent may ask a person for in one request, and how long it may take to say so. */
export const uploadRequestLimits = { prompt: 500, files: 20, accept: 12 } as const;

/**
 * What `request_upload` returns: the agent has asked a person for files. It comes back at once
 * (the agent cannot wait on a person), the chat shows an upload button for it, and what they
 * upload is saved in `folder` and reaches the agent as their next message.
 */
export const uploadRequestSchema = z.object({
  requested: z.literal(true),
  channelId: z.string(),
  requestId: z.string(),
  prompt: z.string(),
  /** Extensions the agent expects, such as `pdf`. Guidance for the picker, not a rule. */
  accept: z.array(z.string()).optional(),
  multiple: z.boolean(),
  /** Where the files are saved, relative to the channel's workspace. */
  folder: z.string(),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;
/** `request_upload` could not ask, and says why, in words the agent can act on. */
export const unrequestedUploadSchema = z.object({ requested: z.literal(false), error: z.string() });

/** A file a person added in answer to a request. */
export interface UploadedFile {
  path: string;
  name: string;
  size: number;
  kind?: FileKind;
  uploadedAt: string;
  uploadedBy?: string;
  /** Who added it, for display; filled in when the request is sent to a client. */
  uploadedByName?: string;
  /** True when the person it is sent to added it. Filled in when the request is sent to a client. */
  mine?: boolean;
}

/** A request as a client sees it: what was asked, and what has been uploaded for it so far. */
export interface UploadRequestState extends Omit<UploadRequest, "requested"> {
  files: UploadedFile[];
  createdAt: string;
}
