import { strFromU8, unzipSync } from "fflate";
import type { Table } from "./file-format";
import { colors } from "./theme";

/**
 * What is inside a Word, Excel or PowerPoint file, or an Apple iWork one, read in the person's own
 * browser: the file is not sent anywhere, and nothing runs on the workspace. It is a preview, not a
 * copy of the page: text, tables and pictures come through, but not exact layout, charts or macros.
 */

export const officeLimits = {
  /** A bigger file is offered as a download; reading it here would stall the page. */
  bytes: 15 * 1024 * 1024,
  rows: 100,
  columns: 12,
  slides: 60,
};

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export type OfficeView = "document" | "sheets" | "slides" | "picture";

/** Which reader a file needs, or nothing when it cannot be previewed. */
export function officeView(name: string): OfficeView | undefined {
  switch (extensionOf(name)) {
    case "docx":
      return "document";
    case "xlsx":
    case "xlsm":
    case "xls":
    case "ods":
    case "numbers":
      return "sheets";
    case "pptx":
      return "slides";
    case "pages":
    case "key":
      return "picture";
    default:
      return undefined;
  }
}

const lightStyle =
  `body{font:15px/1.55 system-ui,sans-serif;color:${colors.text};margin:16px;max-width:760px}` +
  `img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid ${colors.line};padding:4px 8px}` +
  `h1,h2,h3{line-height:1.25}`;

/**
 * A Word document as a page to show in a frame that runs nothing: the page carries a policy with no
 * scripts, and the frame is sandboxed again by whoever shows it.
 */
export async function readDocument(bytes: Uint8Array): Promise<string> {
  // The browser build reads from an ArrayBuffer and has no Node-only parts, so it is the same everywhere.
  const mammoth = (await import("mammoth/mammoth.browser")).default;
  const { value } = await mammoth.convertToHtml({
    arrayBuffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  });
  return (
    "<!doctype html><meta charset=utf-8>" +
    "<meta http-equiv=Content-Security-Policy content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">" +
    `<style>${lightStyle}</style>${value}`
  );
}

export interface Sheet {
  name: string;
  table: Table;
}

/** Each sheet's first rows, as the grid the CSV preview draws. */
export async function readSheets(bytes: Uint8Array): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(bytes, {
    type: "array",
    sheetRows: officeLimits.rows + 2,
    cellDates: true,
  });
  return book.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    const moreRows = rows.length > officeLimits.rows;
    const moreColumns = rows.some((row) => row.length > officeLimits.columns);
    return {
      name,
      table: {
        rows: rows
          .slice(0, officeLimits.rows)
          .map((row) => row.slice(0, officeLimits.columns).map((cell) => String(cell ?? ""))),
        moreRows,
        moreColumns,
      },
    };
  });
}

export interface Slide {
  number: number;
  /** The text on the slide, a line for each paragraph, in the order it was written. */
  lines: string[];
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point =
        code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point < 0x110000
        ? String.fromCodePoint(point)
        : whole;
    }
    return entities[code.toLowerCase()] ?? whole;
  });

/** The text of each slide of a PowerPoint file. Pictures, shapes and animations are not drawn. */
export function readSlides(bytes: Uint8Array): Slide[] {
  const files = unzipSync(bytes, {
    filter: (file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name),
  });
  return Object.keys(files)
    .map((name) => ({ name, number: Number(/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .sort((a, b) => a.number - b.number)
    .slice(0, officeLimits.slides)
    .map(({ name, number }) => {
      const xml = strFromU8(files[name]);
      const lines = [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)]
        .map((paragraph) =>
          [...paragraph[0].matchAll(/<a:t(?: [^>]*)?>([\s\S]*?)<\/a:t>/g)]
            .map((run) => decode(run[1]))
            .join("")
            .trim(),
        )
        .filter(Boolean);
      return { number, lines };
    });
}

/** The picture Apple stores inside a Pages or Keynote file for the Finder to show: its first page. */
export function readPicture(bytes: Uint8Array): { bytes: Uint8Array; type: string } | undefined {
  const names = [
    "preview.jpg",
    "QuickLook/Thumbnail.jpg",
    "preview.png",
    "QuickLook/Thumbnail.png",
  ];
  const files = unzipSync(bytes, { filter: (file) => names.includes(file.name) });
  const found = names.find((name) => files[name]?.length);
  if (!found) return undefined;
  return { bytes: files[found], type: found.endsWith(".png") ? "image/png" : "image/jpeg" };
}
