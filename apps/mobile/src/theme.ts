/**
 * Design tokens: the one place that knows a hex value, a font size or a corner radius.
 *
 * Everything else in the app asks for a role ("colors.primary", "fontSize.ui", "radius.lg")
 * rather than a value, so a style guide is applied by editing this file. A test
 * (test/theme.test.ts) fails if a raw colour appears anywhere else, and checks that the
 * text/background pairs below keep a readable contrast (WCAG AA).
 *
 * The look is light and flat. The rail, the sidebar and the main area are solid regions that meet
 * edge to edge, divided by a vertical hairline; there is no blur, no gradient, no glow and no shadow
 * except under a menu or a drawer. Hairlines and quiet fills are tints of the ink, so they sit
 * equally well on a panel and on a card. Sage green marks where you are (the row you are on, links,
 * progress); honey is the main action and whatever needs a person; red keeps to failure.
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
  /** App and page background: the strip of icons and what shows behind the panels. */
  canvas: "#F4F6F5",
  /** A web page or a document shown in a frame, which assume a white page. */
  paper: "#FFFFFF",
  /** Cards, inputs and anything raised off a panel: a faint ink tint over whatever it sits on. */
  surface: "rgba(21,26,23,0.04)",
  /** Quiet fills: secondary buttons, chips, code. */
  surfaceMuted: "rgba(21,26,23,0.05)",
  /** Hover and pressed state on quiet fills and rows. */
  surfaceHover: "rgba(21,26,23,0.08)",
  /** A tab in a row of tabs: `surfaceMuted` as an opaque colour, so tabs can touch with no seam. */
  tile: "#ECEFED",

  // Lines
  /** Hairlines and default borders. */
  line: "rgba(21,26,23,0.10)",
  /** Borders that must be seen: inputs, hovered cards. */
  lineStrong: "rgba(21,26,23,0.24)",

  // Text
  /** Body and heading ink. */
  text: "#151A17",
  /** Secondary text. */
  muted: "#58615C",
  /** Icons and decoration only. Too light for text. */
  subtle: "#8A918D",
  /** Text and icons on `primary` and other solid fills. */
  onPrimary: "#FFFFFF",

  // Brand
  /**
   * Sage green: where you are and what is selected. Fills, borders and icons; white text on it is AA.
   * The main action is honey (`action`), not this.
   */
  primary: "#2F7350",
  /** `primary` while pressed or hovered. */
  primaryPressed: "#265F42",
  /** Links and other green text. */
  primaryText: "#2A6B49",
  /** Tint behind selected rows, info cards, icon tiles. */
  primarySoft: "rgba(47,115,80,0.17)",
  /** `primarySoft` while hovered or pressed. */
  primarySoftStrong: "rgba(47,115,80,0.20)",
  /** Keyboard focus ring. */
  focusRing: "rgba(47,115,80,0.35)",
  /** Fill of a selected card or option. */
  selected: "#E6F0EA",
  /** Border of a selected card or option. */
  selectedLine: "#5E9B7A",
  /** Honey: the main action (Send, Mark done, a primary button) and what needs a person. Dark text on it. */
  action: "#F2B632",
  /** `action` while pressed or hovered. */
  actionPressed: "#E2A21C",
  /** Text and icons on `action`. */
  onAction: "#241A00",
  /** Amber: the "new" accent. Dashed create tiles, never body text. */
  accent: palette.amber,
  /** Tint behind amber elements. */
  accentSoft: "rgba(242,182,50,0.18)",
  /** Text and icons on amber tints. */
  accentText: "#7A5200",

  // Status
  danger: "#B3261E",
  dangerBg: "rgba(179,38,30,0.08)",
  dangerLine: "rgba(179,38,30,0.28)",
  warning: "#C98A0B",
  warningText: "#7A4A00",
  warningBg: "rgba(242,182,50,0.16)",
  warningLine: "rgba(201,138,11,0.55)",
  success: "#2F8A5B",
  successText: "#1E6A44",
  successBg: "rgba(47,138,91,0.11)",
  /** Queued, paused, scheduled. */
  neutral: "#6B736F",

  // Overlays
  /** Behind sheets and drawers. */
  scrim: "rgba(21,26,23,0.45)",
  /** Dark toast. */
  inverse: "#1F2421",
  onInverse: "#F4F6F5",
} as const;

export type Colors = typeof colors;

/**
 * The backdrop behind the panels: flat off-white with a trace of green, with no light pool and no
 * gradient. `lightest` is the brightest tone it reaches, which text on a panel is checked against
 * (test/theme.test.ts).
 */
export const haze = {
  base: "#F4F6F5",
  lightest: "#F4F6F5",
} as const;

/**
 * Panel fills, all solid. The main area is white; the strip of icons and the channel list are a shade
 * off it, so regions read apart without a shadow.
 */
export const glass = {
  /** A panel: a channel, a thread, the main area. */
  panel: "#FFFFFF",
  /** The channel list beside the strip of icons: a shade off the main area. */
  sidebar: "#F7F8F7",
  /** A bar: the phone's header. */
  bar: "#F7F8F7",
  /** Raised off a panel: the composer and the phone's tab bar. */
  raised: "#F4F6F5",
  /** A sheet over the dimmed page. */
  sheet: "#FFFFFF",
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
  ["onAction", "action"],
  ["onAction", "actionPressed"],
];

/** Tints for people's initials, so a busy channel is easier to scan. */
export const avatarTints = [
  colors.primarySoft,
  colors.successBg,
  colors.warningBg,
  "rgba(90,120,170,0.16)",
  "rgba(100,150,155,0.16)",
] as const;

/** Background discs behind the bee, one per avatar the person can choose. */
export const mascotTints = {
  sky: "rgba(110,145,190,0.22)",
  sand: "rgba(200,170,120,0.24)",
  lilac: "rgba(150,135,195,0.22)",
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
  micro: 10.5,
  caption: 11,
  small: 12,
  ui: 13,
  body: 14,
  heading: 15,
  title: 18,
  display: 24,
  /**
   * What text typed into a box is set in. Not smaller than 16: a phone's browser zooms the page in
   * when a box with smaller text is tapped, and does not zoom back.
   */
  input: 16,
} as const;

/** Sizes with their line heights and weights, for spreading into a style. */
export const type = {
  display: { fontSize: fontSize.display, lineHeight: 30, fontWeight: "600", letterSpacing: -0.4 },
  title: { fontSize: fontSize.title, lineHeight: 24, fontWeight: "600", letterSpacing: -0.2 },
  heading: { fontSize: fontSize.heading, lineHeight: 21, fontWeight: "600", letterSpacing: -0.1 },
  body: { fontSize: fontSize.body, lineHeight: 20 },
  ui: { fontSize: fontSize.ui, lineHeight: 18 },
  small: { fontSize: fontSize.small, lineHeight: 17 },
  caption: { fontSize: fontSize.caption, lineHeight: 15 },
  micro: { fontSize: fontSize.micro, lineHeight: 14 },
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
  popover: "0 8px 24px rgba(21,26,23,0.14), 0 0 0 1px rgba(21,26,23,0.06)",
  /** The row you are on in the sidebar: a faint ring. */
  active: "inset 0 0 0 1px rgba(21,26,23,0.10)",
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
export const layout = { headerHeight: 48, phoneHeaderHeight: 50 } as const;
