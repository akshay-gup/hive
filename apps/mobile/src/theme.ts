/**
 * Design tokens: the one place that knows a hex value, a font size or a corner radius.
 *
 * Everything else in the app asks for a role ("colors.primary", "fontSize.ui", "radius.lg")
 * rather than a value, so a style guide is applied by editing this file. A test
 * (test/theme.test.ts) fails if a raw colour appears anywhere else, and checks that the
 * text/background pairs below keep a readable contrast (WCAG AA).
 *
 * The look is Graphite: quiet and flat. The rail, the sidebar and the main area are solid charcoal
 * regions that meet edge to edge, divided by a vertical hairline; there is no blur, no gradient, no
 * glow and no shadow except under a menu or a drawer. Hairlines and quiet fills are tints of white,
 * so they sit equally well on a panel and on a card. The brand teal is calm, used for actions and
 * for the row you are on; amber, green and red keep to what they mean.
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

/**
 * The backdrop behind the panels: flat near-black charcoal, with no hue, no light pool and no
 * gradient. `lightest` is the brightest tone it reaches, which text on a panel is checked against
 * (test/theme.test.ts).
 */
export const haze = {
  base: "#111214",
  lightest: "#111214",
} as const;

/**
 * Panel fills, all solid. Each step is a shade lighter than the one beneath it, so regions read apart
 * without a shadow: the rail is the backdrop, then the panels, then bars, then what is raised off a
 * panel (the composer and the phone's tab bar), then a sheet over the dimmed page.
 */
export const glass = {
  /** A panel: the sidebar, a channel, a thread, the main area. */
  panel: "#17191B",
  /** A bar: the phone's header. */
  bar: "#1B1D20",
  /** Raised off a panel: the composer and the phone's tab bar. */
  raised: "#202225",
  /** A sheet over the dimmed page. */
  sheet: "#1A1C1F",
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

/** The four colours of Google's "G", which are Google's and stay the same in any theme. */
export const googleBrand = {
  red: "#EA4335",
  blue: "#4285F4",
  yellow: "#FBBC05",
  green: "#34A853",
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
export const radius = { sm: 6, md: 10, lg: 12, xl: 20, xxl: 25, pill: 999 } as const;

/** Spacing scale: multiples of 4. */
export const sp = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

/**
 * Elevation, as CSS box-shadow strings (supported by React Native 0.76+ and the web). The app is flat:
 * a card, a button, a panel and the composer have no shadow and are told apart by their fill and a
 * hairline. Only what floats over the page keeps one.
 */
export const shadow = {
  /** Menus and floating panels. */
  popover: "0 8px 24px rgba(0,0,0,0.35)",
  /** The row you are on in the sidebar: a faint ring. */
  active: "inset 0 0 0 1px rgba(255,255,255,0.10)",
  /** Focus ring drawn around inputs. */
  focus: `0 0 0 2px ${colors.focusRing}`,
} as const;

/**
 * Font families. On web the app font is Poppins, self-hosted and registered in src/fonts.ts, which
 * also makes it the default for every Text. `web` is the stack for raw web <input> elements, which
 * that rule does not reach. Native keeps each platform's system font.
 */
export const fontFamily = {
  web: '"Poppins", "Poppins Fallback", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  monoIos: "Menlo",
  monoAndroid: "monospace",
} as const;

/** Shared chrome sizes, so the sidebar header and the main header always line up. */
export const layout = { headerHeight: 56 } as const;
