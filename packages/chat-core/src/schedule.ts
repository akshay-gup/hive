import { AppError } from "./errors.ts";

/** When a routine fires: once, every few minutes, or at the times a cron line names. */
export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "cron"; expr: string; tz?: string };

/** The shortest time between two fires of an "every" routine. */
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 60 * 24 * 30;

interface Fields {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

/** What each part of a cron line allows: a set of numbers. */
interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** Day of month and day of week both named: either one matches, as cron has always done. */
  both: boolean;
}

const RANGES = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day", 1, 31],
  ["month", 1, 12],
  ["weekday", 0, 7],
] as const;

function part(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const piece of text.split(",")) {
    const [rangeText, stepText] = piece.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new AppError(`Not a step in ${name}: ${piece}`, 422);
    let from = min;
    let to = max;
    if (rangeText !== "*") {
      const [a, b] = (rangeText ?? "").split("-");
      from = Number(a);
      to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to)
      throw new AppError(`Not a value for ${name}: ${piece}`, 422);
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

/** Read a five-field cron line: minute hour day-of-month month day-of-week. */
export function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new AppError("A cron line has five parts: minute hour day month weekday", 422);
  const sets = fields.map((text, i) => {
    const [name, min, max] = RANGES[i] as (typeof RANGES)[number];
    return part(text, min, max, name);
  });
  const weekday = new Set([...(sets[4] as Set<number>)].map((n) => n % 7));
  return {
    minute: sets[0] as Set<number>,
    hour: sets[1] as Set<number>,
    day: sets[2] as Set<number>,
    month: sets[3] as Set<number>,
    weekday,
    both: fields[2] !== "*" && fields[4] !== "*",
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fieldsAt(ms: number, tz: string): Fields {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
    formatters.set(tz, format);
  }
  const got: Record<string, string> = {};
  for (const p of format.formatToParts(ms)) got[p.type] = p.value;
  return {
    minute: Number(got.minute),
    hour: Number(got.hour) % 24,
    day: Number(got.day),
    month: Number(got.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(got.weekday ?? ""),
  };
}

/** Whether a time zone name is one this runtime knows. */
export function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The first minute after `from` that a cron line names, in its time zone (UTC without one); null if none in the next years. */
export function nextCron(expr: string, from: number, tz = "UTC"): number | null {
  const cron = parseCron(expr);
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 20_000; i++) {
    const f = fieldsAt(t, tz);
    const dayOk = cron.both
      ? cron.day.has(f.day) || cron.weekday.has(f.weekday)
      : cron.day.has(f.day) && cron.weekday.has(f.weekday);
    if (!cron.month.has(f.month) || !dayOk) {
      // Not this day: on to the start of the next.
      t += ((23 - f.hour) * 60 + (60 - f.minute)) * 60_000;
    } else if (!cron.hour.has(f.hour)) {
      t += (60 - f.minute) * 60_000;
    } else if (!cron.minute.has(f.minute)) {
      t += 60_000;
    } else return t;
  }
  return null;
}

/** Check a schedule a person or the agent wrote, and say it plainly if it is not one. */
export function checkSchedule(schedule: Schedule, now: number): Schedule {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (!Number.isFinite(at)) throw new AppError("That is not a time", 422);
    if (at < now - 60_000) throw new AppError("That time has passed", 422);
    return { kind: "once", at: new Date(at).toISOString() };
  }
  if (schedule.kind === "every") {
    const minutes = Math.round(schedule.minutes);
    if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES)
      throw new AppError(
        `A routine can repeat every ${MIN_EVERY_MINUTES} minute to every ${MAX_EVERY_MINUTES / 60 / 24} days`,
        422,
      );
    return { kind: "every", minutes };
  }
  parseCron(schedule.expr);
  const tz = schedule.tz?.trim() || undefined;
  if (tz && !knownZone(tz)) throw new AppError(`Not a time zone: ${tz}`, 422);
  if (nextCron(schedule.expr, now, tz) === null)
    throw new AppError("That cron line never comes round", 422);
  return { kind: "cron", expr: schedule.expr.trim().replace(/\s+/g, " "), ...(tz ? { tz } : {}) };
}

/** When the routine fires next after `from`; null when it will not (a once that has gone). */
export function nextFire(schedule: Schedule, from: number): number | null {
  switch (schedule.kind) {
    case "once": {
      const at = Date.parse(schedule.at);
      return at > from ? at : null;
    }
    case "every":
      return from + schedule.minutes * 60_000;
    case "cron":
      return nextCron(schedule.expr, from, schedule.tz);
  }
}

/** The routine's schedule in words, for a list. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "once":
      return `Once, ${new Date(schedule.at).toISOString().replace("T", " ").slice(0, 16)} UTC`;
    case "every":
      return schedule.minutes % 1440 === 0
        ? `Every ${schedule.minutes / 1440 === 1 ? "day" : `${schedule.minutes / 1440} days`}`
        : schedule.minutes % 60 === 0
          ? `Every ${schedule.minutes / 60 === 1 ? "hour" : `${schedule.minutes / 60} hours`}`
          : `Every ${schedule.minutes === 1 ? "minute" : `${schedule.minutes} minutes`}`;
    case "cron":
      return `Cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : " (UTC)"}`;
  }
}
