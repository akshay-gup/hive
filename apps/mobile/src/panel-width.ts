/**
 * The thread panel beside a channel on a wide window: how wide it may be, how a person makes it
 * wider or narrower, and how that choice is remembered.
 */

export const PANEL_DEFAULT = 390;
export const PANEL_MIN = 340;
/** The room the channel keeps beside the panel. */
export const CHANNEL_MIN = 420;
/** How far an arrow key moves the edge. */
export const PANEL_STEP = 24;

const STORAGE_KEY = "hive.threadPanelWidth";

/** The widest the panel may be: what leaves the channel its room, but never less than the minimum. */
export function largestPanelWidth(container: number): number {
  return Math.max(PANEL_MIN, container - CHANNEL_MIN);
}

/** The panel's width kept between its smallest size and its largest. */
export function clampPanelWidth(width: number, container: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT;
  return Math.min(largestPanelWidth(container), Math.max(PANEL_MIN, wanted));
}

/** The wide setting: about three fifths of the space, as much as the channel can spare. */
export function expandedPanelWidth(container: number): number {
  return clampPanelWidth(container * 0.6, container);
}

/** Whether the panel is at its wide setting, give or take the pixel a drag can miss by. */
export function isExpandedPanel(width: number, container: number): boolean {
  return width >= expandedPanelWidth(container) - 4;
}

/** What a window with a panel this wide, or this narrow, is told about the edge. */
export interface PanelResizerProps {
  width: number;
  min: number;
  max: number;
  /** The edge moved, by a drag or a key. */
  onChange: (width: number) => void;
  /** The move is over (the pointer was let go, or a key was pressed): remember the width. */
  onCommit: (width: number) => void;
  /** A double click: back to the usual width. */
  onReset: () => void;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Storage can be blocked (private windows, site settings); the width is then simply not kept.
    return undefined;
  }
}

/** The width this device last used, if it kept one. */
export function readPanelWidth(storage: Store | undefined = browserStorage()): number | undefined {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writePanelWidth(
  width: number,
  storage: Store | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Not kept; the panel still has the width it was given.
  }
}
