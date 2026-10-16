/**
 * Design tokens: the one place that knows a hex value, a font size or a corner radius.
 *
 * Everything else in the app asks for a role ("colors.primary", "fontSize.ui", "radius.lg")
 * rather than a value, so a style guide is applied by editing this file. A test
 * (test/theme.test.ts) fails if a raw colour appears anywhere else, and checks that the
 * text/background pairs below keep a readable contrast (WCAG AA).
 *
 * The look is Graphite: quiet dark glass. Panels are faint white over a neutral charcoal backdrop,
 * with a hairline and a soft shadow, and nothing glows. The web blurs what is behind a sheet; native
 * has no blur here, so its fills are a little more opaque. Hairlines and quiet fills
 * are tints of white, so they sit equally well on the backdrop, on a panel and on a card. The brand
 * teal is calm, used for actions and for the row you are on; amber, green and red keep to what
 * they mean.
 */

/**
 * The brand swatches. Decorative use only (fills, charts, art): text and icons take their colour
 * from the roles in `colors`, which are checked for contrast.
 */
export const palette = {
  navy: "#031D44",
  mediumBlue: "#1C4768",
  brightBlue: "#22B1E0",
  tealGreen: "#1CCC80",
  lightCyan: "#91E4E7",
  lightGray: "#EEF2F5",
  amber: "#FBBF24",
} as const;

/** Semantic colours. Pick by role, never by hue. */
export const colors = {
  // Surfaces
  /** App and page background. */
  canvas: "#111214",
  /** The page behind a web page or a document shown in a frame, which assume a white page. */
  paper: "#FFFFFF",
  /** Cards, inputs and anything raised off a panel: a faint white over whatever it sits on. */
  surface: "rgba(255,255,255,0.05)",
  /** Quiet fills: secondary buttons, chips, code. */
  surfaceMuted: "rgba(255,255,255,0.05)",
  /** Hover and pressed state on quiet fills and rows. */
  surfaceHover: "rgba(255,255,255,0.09)",
  /** A tab in a row of tabs: `surfaceMuted` as an opaque colour, so tabs can touch with no seam. */
  tile: "#2B2D30",

  // Lines
  /** Hairlines and default borders. */
  line: "rgba(255,255,255,0.08)",
  /** Borders that must be seen: inputs, hovered cards. */
  lineStrong: "rgba(255,255,255,0.18)",

  // Text
  /** Body and heading ink. */
  text: "#ECEEF0",
  /** Secondary text. */
  muted: "#A4A9AF",
  /** Icons and decoration only. Too dim for text. */
  subtle: "#767B82",
  /** Text and icons on `primary` and other solid fills. */
  onPrimary: "#FFFFFF",

  // Brand
  /** Main actions, active states, focus: fills, borders and icons. White text on it is AA. */
  primary: "#298097",
  /** `primary` while pressed or hovered. */
  primaryPressed: "#216F83",
  /** Links and other teal text. */
  primaryText: "#6DB8C9",
  /** Tint behind selected rows, info cards, icon tiles. */
  primarySoft: "rgba(41,128,151,0.20)",
  /** `primarySoft` while hovered or pressed. */
  primarySoftStrong: "rgba(41,128,151,0.32)",
  /** Keyboard focus ring. */
  focusRing: "rgba(109,184,201,0.40)",
  /** Fill of a selected card or option. */
  selected: "#1B2D33",
  /** Border of a selected card or option. */
  selectedLine: "#3B93A8",
  /** Amber: the "new" accent. Dashed create tiles, never body text. */
  accent: palette.amber,
  /** Tint behind amber elements. */
  accentSoft: "rgba(251,191,36,0.12)",
  /** Text and icons on amber tints. */
  accentText: "#EBC96F",

  // Status
  danger: "#F4949B",
  dangerBg: "rgba(244,100,112,0.12)",
  dangerLine: "rgba(244,100,112,0.26)",
  warning: "#E39A55",
  warningText: "#EBBE8A",
  warningBg: "rgba(217,122,43,0.16)",
  warningLine: "rgba(217,122,43,0.30)",
  success: "#3DB27E",
  successText: "#82D3AA",
  successBg: "rgba(61,178,126,0.14)",
  /** Queued, paused, scheduled. */
  neutral: "#838A92",

  // Overlays
  /** Behind sheets and drawers. */
  scrim: "rgba(0,0,0,0.55)",
  /** Light toast. */
  inverse: "#ECEEF0",
  onInverse: "#111214",
} as const;

export type Colors = typeof colors;

const hazeBase = "#111214";
/**
 * The two light pools in the backdrop. Each sits at `at` and reaches `size`, both as fractions of the
 * screen's width and height. It is white at `alpha` in the middle and fades to nothing at `fade` of
 * its reach. The web draws them as a picture (src/haze-dither.ts), where they can be rounded without
 * steps; native and the CSS fallback draw them as radial gradients.
 */
const hazePools = [
  { at: [0, 0], size: [0.7, 0.9], alpha: 0.1, fade: 0.7 },
  { at: [1, 1], size: [0.75, 0.85], alpha: 0.065, fade: 0.7 },
] as const;
const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;
const hazeLayers = hazePools
  .map(
    ({ at, size, alpha, fade }) =>
      `radial-gradient(${percent(size[0])} ${percent(size[1])} at ${percent(at[0])} ${percent(at[1])}, rgba(255,255,255,${alpha}), rgba(255,255,255,0) ${percent(fade)})`,
  )
  .join(", ");
/**
 * The backdrop behind the glass: near-black charcoal, a shade lighter at the top left and at the
 * bottom right, scaled to the screen. It has no hue and nothing glows. The web draws the `pools` as
 * a picture with the steps dithered away (src/haze-dither.ts), over `css` until that is ready. Native
 * draws `layers` as React Native's own gradient style when the build opts in to the native glass
 * look, and otherwise keeps the flat `base`. `lightest` is the brightest tone the backdrop reaches,
 * and text on glass is checked against it (test/theme.test.ts).
 */
export const haze = {
  base: hazeBase,
  lightest: "#2A2C2E",
  pools: hazePools,
  layers: hazeLayers,
  css: `${hazeLayers}, ${hazeBase}`,
} as const;

/**
 * Glass fills. The web lays them over what is behind; native has no blur here, so its `*Solid`
 * fills are a little more opaque. Only a sheet blurs (`blur`): a panel has nothing but the haze
 * behind it, and a blur would average the haze's dither back into steps.
 */
export const glass = {
  /** A panel: the sidebar, a channel, a thread. */
  panel: "rgba(255,255,255,0.055)",
  /** A bar: the phone's header. */
  bar: "rgba(255,255,255,0.08)",
  /** Raised off a panel: the composer and the phone's tab bar. */
  raised: "rgba(36,38,42,0.92)",
  /** A sheet over the dimmed page. */
  sheet: "rgba(26,28,31,0.95)",
  panelSolid: "rgba(255,255,255,0.07)",
  barSolid: "rgba(255,255,255,0.10)",
  raisedSolid: "rgba(36,38,42,0.97)",
  sheetSolid: "rgba(26,28,31,0.98)",
  /** The blur behind a sheet (web). */
  blur: "blur(30px) saturate(110%)",
} as const;

/** Text roles drawn straight onto glass. The test checks each against a fill over the lightest haze. */
export const glassTextRoles = ["text", "muted", "primaryText", "danger"] as const;

/** Pairs that carry text. test/theme.test.ts checks each against WCAG AA (4.5:1). */
export const textPairs: readonly (readonly [keyof Colors, keyof Colors])[] = [
  ["text", "canvas"],
  ["text", "surfaceMuted"],
  ["text", "primarySoft"],
  ["text", "selected"],
  ["muted", "canvas"],
  ["muted", "surfaceMuted"],
  ["muted", "tile"],
  ["muted", "primarySoft"],
  ["onPrimary", "primary"],
  ["onPrimary", "primaryPressed"],
  ["primaryText", "canvas"],
  ["primaryText", "surfaceMuted"],
  ["primaryText", "primarySoft"],
  ["primaryText", "selected"],
  ["danger", "canvas"],
  ["danger", "dangerBg"],
  ["warningText", "warningBg"],
  ["successText", "successBg"],
  ["accentText", "canvas"],
  ["accentText", "accentSoft"],
  ["onInverse", "inverse"],
];

/** Tints for people's initials, so a busy channel is easier to scan. */
export const avatarTints = [
  colors.primarySoft,
  colors.successBg,
  colors.warningBg,
  "rgba(120,150,205,0.18)",
  "rgba(150,200,205,0.14)",
] as const;

/** Background discs behind the bee, one per avatar the person can choose. */
export const mascotTints = {
  sky: "rgba(150,175,205,0.22)",
  sand: "rgba(215,190,150,0.22)",
  lilac: "rgba(175,165,210,0.22)",
} as const;

/** Bars on the task timeline. */
export const chart = {
  agent: colors.primary,
  manual: "#7A8794",
  done: colors.success,
} as const;

/** Third-party brand marks. They stay as the owner draws them. */
export const brand = {
  gmail: "#EA5B4D",
  googleCalendar: "#4285F4",
  googleDrive: "#34A853",
  browser: "#1987CF",
  openbot: "#6866A6",
  /** The red PDF badge on shared files. */
  pdf: "#FC2359",
} as const;

/** Accent bars on calendar events, cycled by calendar. */
export const eventColors = ["#7FC3CC", "#7CC9A5", "#E3C56F"] as const;

/** The dark finance summary card is its own piece of art, not part of the app chrome. */
export const financeArt = {
  card: "#021A3D",
  panel: "#0B2A57",
  gradient: [palette.navy, palette.mediumBlue, palette.brightBlue],
  intro: "#D6ECF7",
  label: "#9DB5D1",
  note: "#8BA4C2",
  positive: "#2FE5A0",
} as const;

/** Text sizes. Use these rather than numbers. */
export const fontSize = {
  micro: 11,
  caption: 12,
  small: 13,
  ui: 14,
  body: 15,
  heading: 16,
  title: 20,
  display: 28,
} as const;

/** Sizes with their line heights and weights, for spreading into a style. */
export const type = {
  display: { fontSize: fontSize.display, lineHeight: 36, fontWeight: "600", letterSpacing: -0.4 },
  title: { fontSize: fontSize.title, lineHeight: 28, fontWeight: "600", letterSpacing: -0.2 },
  heading: { fontSize: fontSize.heading, lineHeight: 24, fontWeight: "600", letterSpacing: -0.1 },
  body: { fontSize: fontSize.body, lineHeight: 23 },
  ui: { fontSize: fontSize.ui, lineHeight: 21 },
  small: { fontSize: fontSize.small, lineHeight: 19 },
  caption: { fontSize: fontSize.caption, lineHeight: 18 },
  micro: { fontSize: fontSize.micro, lineHeight: 16 },
  label: {
    fontSize: fontSize.micro,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
} as const;

/** Corner radii. Circles use half their size and are not in this scale. */
export const radius = { sm: 6, md: 10, lg: 12, xl: 20, xxl: 25, panel: 18, pill: 999 } as const;

/** Spacing scale: multiples of 4. */
export const sp = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

/** Elevation, as CSS box-shadow strings (supported by React Native 0.76+ and the web). */
export const shadow = {
  /** Cards at rest. */
  card: "inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.28)",
  /** Cards under the pointer. */
  raised: "0 6px 18px rgba(0,0,0,0.42)",
  /** Menus and floating panels. */
  popover: "0 10px 30px rgba(0,0,0,0.45)",
  /** A glass panel: a rim that catches more light along its top and left edges, a hairline, and a soft drop. */
  panel:
    "inset 1px 1px 0 rgba(255,255,255,0.10), inset -1px -1px 0 rgba(255,255,255,0.03), 0 0 0 1px rgba(255,255,255,0.06), 0 22px 54px rgba(0,0,0,0.45)",
  /** The selected row in a list on glass: a faint ring. */
  lens: "inset 0 1px 0 rgba(255,255,255,0.07), 0 0 0 1px rgba(255,255,255,0.09)",
  /** The row you are on in the sidebar: a faint ring. */
  active: "inset 0 0 0 1px rgba(255,255,255,0.10)",
  /** Raised off a panel: the composer and the phone's tab bar. */
  float:
    "inset 1px 1px 0 rgba(255,255,255,0.12), inset -1px -1px 0 rgba(255,255,255,0.03), 0 0 0 1px rgba(255,255,255,0.08), 0 12px 30px rgba(0,0,0,0.38)",
  /** Focus ring drawn around inputs. */
  focus: `0 0 0 2px ${colors.focusRing}`,
} as const;

/**
 * Font families. On web the app font is Poppins, self-hosted and registered in src/fonts.ts, which
 * also makes it the default for every Text. `web` is the stack for raw web <input> elements, which
 * that rule does not reach. Native keeps each platform's system font.
 */
export const fontFamily = {
  web: '"Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  monoIos: "Menlo",
  monoAndroid: "monospace",
} as const;

/**
 * Shared chrome sizes, so the sidebar header and the main header always line up. `gap` is the room
 * between panels and the margin round them.
 */
export const layout = { headerHeight: 56, gap: 12 } as const;
