import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { colors, glass, glassTextRoles, haze, textPairs } from "../src/theme.ts";

type Rgb = [number, number, number];

/** A hex or rgb()/rgba() colour as red, green, blue and alpha. */
function parse(color: string): { rgb: Rgb; alpha: number } {
  if (color.startsWith("#")) {
    const n = Number.parseInt(color.slice(1), 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const match = color.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (!match) throw new Error(`Unreadable colour: ${color}`);
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}
/** What `top` looks like laid over an opaque `bottom`. */
function over(top: string, bottom: Rgb): Rgb {
  const { rgb, alpha } = parse(top);
  return [0, 1, 2].map((i) => rgb[i] * alpha + bottom[i] * (1 - alpha)) as Rgb;
}
function luminance(rgb: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const canvas = parse(colors.canvas).rgb;

test("every text and background pair in the theme stays readable (WCAG AA, 4.5:1)", () => {
  for (const [foreground, background] of textPairs) {
    const behind = over(colors[background], canvas);
    const ratio = contrast(over(colors[foreground], behind), behind);
    assert.ok(
      ratio >= 4.5,
      `${foreground} on ${background} is ${ratio.toFixed(2)}:1 (${colors[foreground]} on ${colors[background]})`,
    );
  }
});

test("text drawn on a panel stays readable (4.5:1)", () => {
  const lightest = parse(haze.lightest).rgb;
  for (const fill of ["panel", "bar", "raised", "sheet"] as const) {
    const surface = over(glass[fill], lightest);
    for (const role of glassTextRoles) {
      const ratio = contrast(over(colors[role], surface), surface);
      assert.ok(ratio >= 4.5, `${role} on glass.${fill} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the surfaces are flat: every fill is solid, and each is lighter than the one beneath", () => {
  const order = ["panel", "bar", "raised"] as const;
  for (const kind of [...order, "sheet"] as const) {
    assert.equal(parse(glass[kind]).alpha, 1, `glass.${kind} is not solid`);
  }
  let below = luminance(parse(haze.base).rgb);
  for (const kind of order) {
    const now = luminance(parse(glass[kind]).rgb);
    assert.ok(now > below, `glass.${kind} is not lighter than what is beneath it`);
    below = now;
  }
});

test("colours are written only in src/theme.ts", () => {
  const root = new URL("..", import.meta.url).pathname;
  const sources = [
    join(root, "App.tsx"),
    ...["src", "src/hosted"].flatMap((folder) =>
      readdirSync(join(root, folder))
        .filter((name) => /\.tsx?$/.test(name) && name !== "theme.ts")
        .map((name) => join(root, folder, name)),
    ),
  ];
  const offenders: string[] = [];
  for (const file of sources) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const code = line.replace(/\s\/\/.*$/, "");
        if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(code))
          offenders.push(`${file.replace(root, "")}:${index + 1}  ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `Use a token from src/theme.ts instead of a colour value:\n${offenders.join("\n")}`,
  );
});
