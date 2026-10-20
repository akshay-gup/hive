import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { describeFile } from "../../../packages/domain/src/workspace-files.ts";
import { fileType } from "../src/file-format.ts";
import {
  officeView,
  readDocument,
  readPicture,
  readSheets,
  readSlides,
} from "../src/office-read.ts";

/** A Word file as small as Word will open: one heading and one paragraph with markup in it. */
const docx = () =>
  zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly plan</w:t></w:r></w:p><w:p><w:r><w:t>Revenue &lt;script&gt;alert(1)&lt;/script&gt; grew.</w:t></w:r></w:p></w:body></w:document>',
    ),
  });

const slide = (text: string[]) =>
  strToU8(
    `<p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>${text
      .map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join("")}</p:spTree></p:cSld></p:sld>`,
  );

test("the common Microsoft and Apple files are told apart from the ones with no preview", () => {
  for (const name of [
    "a.docx",
    "a.xlsx",
    "a.xlsm",
    "a.xls",
    "a.ods",
    "a.pptx",
    "a.pages",
    "a.numbers",
    "a.key",
  ])
    assert.equal(describeFile(name).kind, "office", name);
  assert.equal(officeView("Plan.DOCX"), "document");
  assert.equal(officeView("a.xlsx"), "sheets");
  assert.equal(officeView("a.pptx"), "slides");
  assert.equal(officeView("a.key"), "picture");
  assert.equal(officeView("a.doc"), undefined, "the old Word format cannot be read here");
  assert.equal(fileType({ name: "Budget.xlsx", kind: "office" }), "XLSX");
});

test("a Word document comes out as a page that runs nothing", async () => {
  const html = await readDocument(docx());
  assert.match(html, /<h1>Quarterly plan<\/h1>/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script>/, "text that looks like a script stays text");
  assert.match(html, /&lt;script&gt;/);
});

test("a workbook gives each sheet's first rows, with limits on rows and columns", async () => {
  const book = XLSX.utils.book_new();
  const wide = [Array.from({ length: 20 }, (_, i) => `c${i}`)];
  for (let i = 0; i < 150; i++) wide.push(Array.from({ length: 20 }, (_, j) => `${i}:${j}`));
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(wide), "Big");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Qty"],
      ["Bolt", 4],
    ]),
    "Small",
  );
  const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

  const sheets = await readSheets(new Uint8Array(bytes));
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["Big", "Small"],
  );
  assert.equal(sheets[0].table.rows.length, 100);
  assert.equal(sheets[0].table.rows[0].length, 12);
  assert.equal(sheets[0].table.moreRows, true);
  assert.equal(sheets[0].table.moreColumns, true);
  assert.deepEqual(sheets[1].table.rows, [
    ["Name", "Qty"],
    ["Bolt", "4"],
  ]);
  assert.equal(sheets[1].table.moreRows, false);
});

test("a presentation gives each slide's text in order, with what XML escapes put back", () => {
  const bytes = zipSync({
    "ppt/slides/slide10.xml": slide(["Ten"]),
    "ppt/slides/slide2.xml": slide(["Two &amp; more", "Second line"]),
    "ppt/slides/slide1.xml": slide(["One"]),
    "ppt/media/image1.png": new Uint8Array([1]),
  });
  const slides = readSlides(bytes);
  assert.deepEqual(
    slides.map((s) => s.number),
    [1, 2, 10],
  );
  assert.deepEqual(slides[1].lines, ["Two & more", "Second line"]);
});

test("Pages and Keynote files show the picture Apple keeps inside them", () => {
  const picture = new Uint8Array([0xff, 0xd8, 0xff]);
  const bytes = zipSync({ "preview.jpg": picture, "Index/Document.iwa": new Uint8Array([1]) });
  const found = readPicture(bytes);
  assert.equal(found?.type, "image/jpeg");
  assert.deepEqual([...(found?.bytes ?? [])], [...picture]);
  assert.equal(readPicture(zipSync({ "a.txt": new Uint8Array([1]) })), undefined);
});
