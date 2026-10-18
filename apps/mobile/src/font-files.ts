import { fontFamily } from "./theme";

/**
 * Poppins, self-hosted for the web build (SIL Open Font License; the licence text sits next to the
 * files in public/fonts). Nothing is fetched from a font CDN, so no request leaves the deployment.
 *
 * Each weight ships as a Latin and a Latin-extended subset. The browser downloads a subset only
 * when a character in it is drawn, using the unicode ranges below.
 */
export const fontWeights = [400, 500, 600, 700] as const;

export const fontSubsets = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const;

/** Where a font file is served from: the web root, copied from apps/mobile/public. */
export const fontUrl = (subset: keyof typeof fontSubsets, weight: (typeof fontWeights)[number]) =>
  `/fonts/poppins-${subset}-${weight}-normal.woff2`;

/** Every file the app can ask for. The test checks each exists in public/fonts. */
export const fontFiles = fontWeights.flatMap((weight) =>
  (Object.keys(fontSubsets) as (keyof typeof fontSubsets)[]).map((subset) =>
    fontUrl(subset, weight),
  ),
);

/** The two faces nearly every screen draws on first paint; they are preloaded. */
export const preloadedFonts = [fontUrl("latin", 400), fontUrl("latin", 600)];

/** The name of the stand-in drawn until Poppins has arrived. It is in `fontFamily.web`, after Poppins. */
export const fallbackFamily = "Poppins Fallback";

/**
 * Poppins is wider than the system fonts and has taller lines, so text drawn in a system font
 * first and in Poppins a moment later changes size when the font arrives: lines that have no
 * `lineHeight` of their own grow, buttons and chips with them, and everything below moves down.
 * The stand-in is a system font made the size of Poppins, so that nothing does.
 *
 * `adjust` is how much wider Poppins runs than the font it stands in for, measured on a few
 * hundred characters of the app's own text at each weight (Arial for the lighter weights, Arial
 * Bold for the heavier). The three metrics are Poppins's own, as shares of the font size: the line
 * is 1.5 high with them, as it is in Poppins, whichever of the fonts below the device has (Liberation
 * Sans is Arial's twin on Linux; Roboto is close to it and is what Android has). A device with
 * none of them skips the stand-in and shows its own font until Poppins arrives, as it would
 * without any of this.
 */
const poppinsMetrics = { ascent: 1.05, descent: 0.35, lineGap: 0.1 };
const regularFonts = ["Arial", "ArialMT", "Liberation Sans", "Roboto"] as const;
const boldFonts = [
  "Arial Bold",
  "Arial-BoldMT",
  "Liberation Sans Bold",
  "Liberation Sans-Bold",
  "Roboto Bold",
] as const;
const standIns = [
  { weight: 400, local: regularFonts, adjust: 1.121 },
  { weight: 500, local: regularFonts, adjust: 1.131 },
  { weight: 600, local: boldFonts, adjust: 1.056 },
  { weight: 700, local: boldFonts, adjust: 1.069 },
] as const;

function standInCss(): string[] {
  const percent = (share: number) => `${Number((share * 100).toFixed(2))}%`;
  return standIns.map(
    ({ weight, local, adjust }) =>
      `@font-face{font-family:"${fallbackFamily}";font-style:normal;font-weight:${weight};` +
      `src:${local.map((name) => `local("${name}")`).join(",")};size-adjust:${percent(adjust)};` +
      `ascent-override:${percent(poppinsMetrics.ascent / adjust)};` +
      `descent-override:${percent(poppinsMetrics.descent / adjust)};` +
      `line-gap-override:${percent(poppinsMetrics.lineGap / adjust)}}`,
  );
}

/**
 * The stylesheet: one @font-face per file, and the rule that makes Poppins the app font.
 *
 * react-native-web draws every Text with its own system-font stack and does not inherit a font
 * from its parents, so the family has to be set on the elements themselves. It renders text as
 * `dir="auto"` elements, which is what the rule matches. Code opts out with `monoProps` (ui.tsx),
 * which adds `data-mono`, so it keeps its monospace font.
 */
export function fontCss(): string {
  const faces = fontWeights.flatMap((weight) =>
    (Object.keys(fontSubsets) as (keyof typeof fontSubsets)[]).map(
      (subset) =>
        `@font-face{font-family:"Poppins";font-style:normal;font-display:swap;font-weight:${weight};` +
        `src:url(${fontUrl(subset, weight)}) format("woff2");unicode-range:${fontSubsets[subset]}}`,
    ),
  );
  return [
    ...faces,
    ...standInCss(),
    `body{font-family:${fontFamily.web}}`,
    `html [dir="auto"]:not([data-mono]){font-family:${fontFamily.web}}`,
  ].join("\n");
}
