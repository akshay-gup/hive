/**
 * How long the agent worked on a reply, kept by the app because a reply carries no time of its own.
 * Remembered per conversation where the browser can (the same device sees "Worked for 3 minutes"
 * again after a reload); a reply from before, or from another device, just says how many steps.
 */
const KEY = "hive-run-durations:";
const KEEP = 200;

export type RunDurations = Record<string, number>;

function store(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadRunDurations(threadId: string): RunDurations {
  try {
    const parsed: unknown = JSON.parse(store()?.getItem(KEY + threadId) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

export function saveRunDurations(threadId: string, durations: RunDurations): void {
  try {
    const recent = Object.fromEntries(Object.entries(durations).slice(-KEEP));
    store()?.setItem(KEY + threadId, JSON.stringify(recent));
  } catch {
    // Not remembering it is fine: the reply then says how many steps instead.
  }
}
