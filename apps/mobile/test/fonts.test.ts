import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  fallbackFamily,
  fontCss,
  fontFiles,
  fontSubsets,
  fontWeights,
  preloadedFonts,
} from "../src/font-files.ts";
import { fontFamily } from "../src/theme.ts";

const publicDir = new URL("../public", import.meta.url).pathname;

test("every Poppins file the stylesheet asks for ships in public/fonts", () => {
  const missing = fontFiles.filter((url) => !existsSync(join(publicDir, url)));
  assert.deepEqual(missing, [], `Missing from apps/mobile/public: ${missing.join(", ")}`);
});

test("public/fonts holds only the files the app uses, and the licence", () => {
  const shipped = readdirSync(join(publicDir, "fonts")).sort();
  const expected = [...fontFiles.map((url) => url.replace("/fonts/", "")), "OFL.txt"].sort();
  assert.deepEqual(shipped, expected);
});

test("the stylesheet registers each weight and subset once", () => {
  const faces = fontCss().match(/@font-face\{font-family:"Poppins";/g) ?? [];
  assert.equal(faces.length, fontWeights.length * Object.keys(fontSubsets).length);
});

test("a stand-in the size of Poppins is drawn for each weight until the font arrives", () => {
  const css = fontCss();
  const standIns =
    css.match(new RegExp(`@font-face\\{font-family:"${fallbackFamily}";[^}]*\\}`, "g")) ?? [];
  assert.equal(standIns.length, fontWeights.length);
  for (const weight of fontWeights)
    assert.ok(
      standIns.some((face) => face.includes(`font-weight:${weight};`)),
      `weight ${weight}`,
    );
  for (const face of standIns) {
    assert.match(face, /size-adjust:1\d\d(\.\d+)?%/);
    // Poppins's own line: 1.05 above the baseline, 0.35 below and 0.1 of gap, at its own size.
    const share = (name: string) =>
      Number(face.match(new RegExp(`${name}:([\\d.]+)%`))?.[1]) *
      (Number(face.match(/size-adjust:([\d.]+)%/)?.[1]) / 100);
    assert.ok(Math.abs(share("ascent-override") - 105) < 0.2, face);
    assert.ok(Math.abs(share("descent-override") - 35) < 0.2, face);
    assert.ok(Math.abs(share("line-gap-override") - 10) < 0.2, face);
  }
  // It comes straight after Poppins in the font stack, ahead of every system font.
  assert.ok(fontFamily.web.startsWith(`"Poppins", "${fallbackFamily}", `));
});

test("Poppins is the font of every Text except code", () => {
  assert.ok(fontFamily.web.startsWith('"Poppins"'));
  assert.ok(
    fontCss().includes(`html [dir="auto"]:not([data-mono]){font-family:${fontFamily.web}}`),
  );
});

test("the faces preloaded on first paint are real files", () => {
  for (const url of preloadedFonts) assert.ok(fontFiles.includes(url), url);
});
