/**
 * How many rows a list had the last time, so that while it loads there is room for about as many
 * (as placeholders), and the screen below it does not jump when the real ones arrive. Kept per list
 * in the browser's storage where there is one, and in memory otherwise.
 */
type Store = Pick<Storage, "getItem" | "setItem">;

const PREFIX = "hive.lastCount.";
/** More than this is not worth holding room for: the list scrolls. */
export const MAX_PLACEHOLDERS = 6;
const memory = new Map<string, number>();

function browserStorage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Storage can be blocked; the count is then only kept while the app is open.
    return undefined;
  }
}

/** How many placeholder rows to show for the list called `key`: what it last had, up to the most worth holding room for. */
export function readLastCount(key: string, storage: Store | undefined = browserStorage()): number {
  let count = memory.get(key);
  if (count === undefined) {
    try {
      const raw = storage?.getItem(PREFIX + key);
      const stored = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
      count = Number.isFinite(stored) ? stored : 0;
    } catch {
      count = 0;
    }
  }
  return Math.min(MAX_PLACEHOLDERS, Math.max(0, Math.floor(count)));
}

/** Remember that the list called `key` has `count` rows. */
export function writeLastCount(
  key: string,
  count: number,
  storage: Store | undefined = browserStorage(),
): void {
  memory.set(key, count);
  try {
    storage?.setItem(PREFIX + key, String(count));
  } catch {
    // Not kept beyond this session; nothing else depends on it.
  }
}

/** Forget what is held in memory (for tests). */
export function forgetLastCounts(): void {
  memory.clear();
}
