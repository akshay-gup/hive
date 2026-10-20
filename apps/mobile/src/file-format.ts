import {
  type ChannelFile,
  describeFile,
  type FileKind,
} from "../../../packages/domain/src/workspace-files";

/** How big a file is, as a person would say it. */
export const fileSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** A JSON file laid out for reading. Text that is not valid JSON (yet) is left as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export interface Table {
  rows: string[][];
  /** The file has more rows than were read. */
  moreRows: boolean;
  /** Some row has more columns than were kept. */
  moreColumns: boolean;
}

/**
 * The first rows of a CSV or TSV file. A quoted cell can hold the delimiter, line breaks and `""`
 * for a quote, as spreadsheets write them. Reading stops once the limits are passed, so a big file
 * costs no more than a small one.
 */
export function parseTable(
  text: string,
  delimiter = ",",
  limits: { rows: number; columns: number } = { rows: 100, columns: 12 },
): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let moreColumns = false;
  const endCell = () => {
    if (row.length < limits.columns) row.push(cell);
    else moreColumns = true;
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < source.length && rows.length <= limits.rows; i++) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) endCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      endRow();
    } else cell += char;
  }
  // A file that does not end with a line break still has its last row.
  if (rows.length <= limits.rows && (cell !== "" || row.length)) endRow();
  const moreRows = rows.length > limits.rows;
  return { rows: moreRows ? rows.slice(0, limits.rows) : rows, moreRows, moreColumns };
}

const kindLabels: Record<FileKind, string> = {
  image: "Image",
  pdf: "PDF",
  video: "Video",
  audio: "Audio",
  markdown: "Markdown",
  html: "Web page",
  csv: "Spreadsheet",
  json: "JSON",
  code: "Code",
  text: "Text",
  archive: "Archive",
  office: "Document",
  other: "File",
};

/** What a file is, for the line under its name. Source code says its language by extension. */
export function fileType(file: Pick<ChannelFile, "name" | "kind">): string {
  const kind = file.kind ?? "other";
  const dot = file.name.lastIndexOf(".");
  return (kind === "code" || kind === "office") && dot > 0
    ? file.name.slice(dot + 1).toUpperCase()
    : kindLabels[kind];
}

/** The folder a path is in; empty for the top of the workspace. */
export const parentOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/** Each folder on the way to `path`, from the top, for a trail of links. */
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/**
 * What a file picker should offer when asked for these extensions (`pdf`, `.PNG`). Web pickers take
 * extensions and native ones take MIME types, so on native an extension with no known type turns
 * the filter off: a picker that hides a file the person was asked for is worse than one that shows
 * too many.
 */
export function pickerTypes(accept: readonly string[] | undefined, web: boolean): string[] {
  const extensions = (accept ?? []).map((item) => item.trim().replace(/^\./, "").toLowerCase());
  if (!extensions.length || extensions.some((extension) => !/^[a-z0-9]{1,10}$/.test(extension)))
    return ["*/*"];
  if (web) return extensions.map((extension) => `.${extension}`);
  const types = extensions.map((extension) => describeFile(`file.${extension}`).mimeType);
  if (types.includes("application/octet-stream")) return ["*/*"];
  return [...new Set(types.map((type) => (type.startsWith("image/") ? "image/*" : type)))];
}
