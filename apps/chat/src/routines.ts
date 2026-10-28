import { z } from "zod";
import type { Entries, Entry, EntryScope } from "../../../packages/chat-core/src/entries.ts";
import type { EntryRules } from "../../../packages/chat-core/src/entry-rules.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { Run } from "../../../packages/chat-core/src/runs.ts";
import {
  checkSchedule,
  describeSchedule,
  nextFire,
  type Schedule,
} from "../../../packages/chat-core/src/schedule.ts";
import { goalScopeSchema } from "../../../packages/domain/src/agent.ts";

export const ROUTINE = "routine";

export const ROUTINE_LIMITS = {
  /** Routines one person may have. */
  perPerson: 20,
  /** Fires in a row that may fail before the routine is paused and its person told. */
  failuresToPause: 3,
  /** Routines fired in one pass of the room's upkeep. */
  perPass: 5,
  noteChars: 4000,
  memoChars: 4000,
} as const;

const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().min(1).max(40) }),
  z.object({
    kind: z.literal("every"),
    minutes: z
      .number()
      .min(1)
      .max(60 * 24 * 30),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string().min(1).max(100),
    tz: z.string().max(60).optional(),
  }),
]);

export const routineInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  /** What the agent is to do when it wakes: a note to itself, written so that it makes sense without anything else. */
  note: z.string().trim().min(1).max(ROUTINE_LIMITS.noteChars),
  schedule: scheduleSchema,
  /** Whose it is: who may see and change it. Left out, the channel it was made in, or the person's own. */
  scope: goalScopeSchema.optional(),
});

export const routinePatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  note: z.string().trim().min(1).max(ROUTINE_LIMITS.noteChars).optional(),
  schedule: scheduleSchema.optional(),
  paused: z.boolean().optional(),
});

interface RoutineData {
  title: string;
  note: string;
  schedule: Schedule;
  /** Where it wakes the agent: a channel (and the thread in it), or the person's own chat. */
  where: { channelId?: string; rootId?: string; own?: boolean };
  /** What the agent kept for itself to read next time. */
  memo: string;
  failures: number;
  fires: number;
  lastRunAt?: string;
  /** The message the last fire posted, which is how the run it made is found. */
  lastTriggerId?: string;
  lastResult?: string;
}

export interface RoutineView {
  id: string;
  title: string;
  note: string;
  schedule: Schedule;
  scheduleText: string;
  where: RoutineData["where"];
  memo: string;
  status: "active" | "paused" | "done";
  nextRunAt?: string;
  lastRunAt?: string;
  /** How the last fire went: running, done, failed or stopped, or why it could not start. */
  lastResult?: string;
  failures: number;
  fires: number;
  scope: EntryScope;
  createdBy: string;
  createdAt: string;
}

export interface RoutinesDeps {
  rules: EntryRules;
  entries: Entries;
  /** Whether a channel is there, for a routine to wake the agent in. */
  channelExists: (id: string) => Promise<boolean>;
  /** Write a message as this person, in a channel, which wakes the agent as it would if they wrote it. Returns its id. */
  post: (
    owner: string,
    channelId: string,
    input: { body: string; threadRoot?: string; clientId: string },
  ) => Promise<{ id: string }>;
  runOf: (triggerId: string) => Run | null;
  isActive: (run: Run) => boolean;
  /** Wake the agent in the person's own chat (the machine does it); false when it cannot. */
  fireOwn?: (owner: string, routine: RoutineView) => Promise<boolean>;
  tell: (userId: string, notice: { key: string; title: string; body: string }) => void;
  /** Ask the room to look at the clock soon. */
  soon: () => void;
  clock: () => number;
}

/** When a new or changed routine first fires: a "once" that is a moment late goes at once, the others from now. */
const firstFire = (schedule: Schedule, now: number): number | null =>
  schedule.kind === "once" ? Math.max(Date.parse(schedule.at), now) : nextFire(schedule, now);

const toView = (entry: Entry, run: Run | null): RoutineView => {
  const data = entry.data as unknown as RoutineData;
  return {
    id: entry.id,
    title: data.title,
    note: data.note,
    schedule: data.schedule,
    scheduleText: describeSchedule(data.schedule),
    where: data.where,
    memo: data.memo,
    status: (entry.status as RoutineView["status"]) ?? "active",
    ...(entry.dueAt && entry.status === "active" ? { nextRunAt: entry.dueAt } : {}),
    ...(data.lastRunAt ? { lastRunAt: data.lastRunAt } : {}),
    ...(run
      ? { lastResult: run.state === "queued" || run.state === "sent" ? "running" : run.state }
      : {}),
    ...(!run && data.lastResult ? { lastResult: data.lastResult } : {}),
    failures: data.failures,
    fires: data.fires,
    scope: entry.scope,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
  };
};

/**
 * Routines: a note the agent writes to itself and a time. When it comes, the room wakes the agent as the person
 * who set it up, where it was set up, as if they had written the note there. The agent can monitor, remind or do
 * anything it could be asked to; the room is what holds the schedule, so it runs whether or not the machine is on
 * (the machine is woken for it).
 */
export class Routines {
  constructor(private readonly deps: RoutinesDeps) {}

  private view(entry: Entry): RoutineView {
    const data = entry.data as unknown as RoutineData;
    return toView(entry, data.lastTriggerId ? this.deps.runOf(data.lastTriggerId) : null);
  }

  async list(owner: string): Promise<RoutineView[]> {
    return (await this.deps.rules.visible(owner, ROUTINE))
      .map((entry) => this.view(entry))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(
    owner: string,
    raw: unknown,
    home: { channelId?: string; rootId?: string } = {},
  ): Promise<RoutineView> {
    const input = routineInputSchema.parse(raw);
    if (this.deps.entries.countBy(ROUTINE, owner) >= ROUTINE_LIMITS.perPerson)
      throw new AppError(
        `You can have ${ROUTINE_LIMITS.perPerson} routines. Remove one first.`,
        409,
      );
    const now = this.deps.clock();
    const schedule = checkSchedule(input.schedule as Schedule, now);
    const where: RoutineData["where"] = home.channelId
      ? { channelId: home.channelId, ...(home.rootId ? { rootId: home.rootId } : {}) }
      : { own: true };
    if (where.own && !this.deps.fireOwn)
      throw new AppError("A routine in your own chat is not ready yet; set it in a channel.", 422);
    if (where.channelId && !(await this.deps.channelExists(where.channelId)))
      throw new AppError("That channel is not there, or you cannot see it.", 404);
    const scope: EntryScope =
      input.scope ??
      (where.channelId ? { type: "channel", id: where.channelId } : { type: "person" });
    const next = firstFire(schedule, now);
    const entry = await this.deps.rules.create(owner, {
      kind: ROUTINE,
      scope,
      status: "active",
      dueAt: next ? new Date(next).toISOString() : undefined,
      data: {
        title: input.title,
        note: input.note,
        schedule,
        where,
        memo: "",
        failures: 0,
        fires: 0,
      } satisfies RoutineData as never,
    });
    this.deps.soon();
    return this.view(entry);
  }

  async update(owner: string, id: string, raw: unknown): Promise<RoutineView> {
    const patch = routinePatchSchema.parse(raw);
    const entry = await this.open(owner, id, "write");
    const data = entry.data as unknown as RoutineData;
    const now = this.deps.clock();
    const schedule = patch.schedule
      ? checkSchedule(patch.schedule as Schedule, now)
      : data.schedule;
    let status = entry.status ?? "active";
    if (patch.paused === true) status = "paused";
    if (patch.paused === false || (patch.schedule && status === "done")) status = "active";
    const next = status === "active" ? firstFire(schedule, now) : null;
    if (status === "active" && next === null) throw new AppError("That time has passed", 422);
    const saved = await this.deps.rules.update(owner, id, {
      status,
      dueAt: next ? new Date(next).toISOString() : undefined,
      data: {
        ...data,
        title: patch.title ?? data.title,
        note: patch.note ?? data.note,
        schedule,
        failures: patch.paused === false ? 0 : data.failures,
      } as never,
    });
    this.deps.soon();
    return this.view(saved);
  }

  async remove(owner: string, id: string): Promise<{ ok: true }> {
    await this.open(owner, id);
    return this.deps.rules.remove(owner, id);
  }

  /** Wake the agent now, besides its schedule. */
  async runNow(owner: string, id: string): Promise<RoutineView> {
    const entry = await this.open(owner, id, "write");
    return this.view(await this.fire(entry, false));
  }

  /** What the agent kept for itself, set by the run a routine woke. */
  async setMemo(runId: string, runTriggerId: string, memo: string): Promise<RoutineView> {
    const entry = this.byTrigger(runTriggerId);
    if (!entry) throw new AppError("This run was not started by a routine", 409);
    void runId;
    const data = entry.data as unknown as RoutineData;
    const saved = this.deps.rules.keep({
      ...entry,
      data: { ...data, memo: memo.slice(0, ROUTINE_LIMITS.memoChars) } as never,
    });
    return this.view(saved);
  }

  /** The routine that a message woke the agent for, if it was one. */
  byTrigger(triggerId: string): Entry | null {
    return (
      this.deps.entries
        .list(ROUTINE)
        .find((entry) => (entry.data as unknown as RoutineData).lastTriggerId === triggerId) ?? null
    );
  }

  nextDueMs(): number | null {
    return this.deps.entries.nextDueMs(ROUTINE);
  }

  /** Wake the agent for each routine whose time has come. */
  async fireDue(): Promise<number> {
    const due = this.deps.entries.due(ROUTINE, this.deps.clock(), ROUTINE_LIMITS.perPass);
    for (const entry of due) await this.fire(entry, true);
    return due.length;
  }

  private async fire(entry: Entry, scheduled: boolean): Promise<Entry> {
    const data = entry.data as unknown as RoutineData;
    const owner = entry.createdBy;
    const now = this.deps.clock();
    const prev = data.lastTriggerId ? this.deps.runOf(data.lastTriggerId) : null;
    let status = entry.status ?? "active";
    let next: number | null = scheduled
      ? nextFire(data.schedule, now)
      : entry.dueAt
        ? Date.parse(entry.dueAt)
        : null;
    let failures = data.failures;
    let lastResult = data.lastResult;
    let lastTriggerId = data.lastTriggerId;
    let fires = data.fires;
    let lastRunAt = data.lastRunAt;
    // The last time is still being worked on: this one waits for the next.
    if (prev && this.deps.isActive(prev) && scheduled) {
      lastResult = "skipped: the last run was still going";
    } else {
      try {
        if (data.where.own) {
          const ok = this.deps.fireOwn
            ? await this.deps.fireOwn(owner, toView(entry, null))
            : false;
          if (!ok) throw new AppError("The agent's machine could not be reached", 503);
        } else {
          const posted = await this.deps.post(owner, data.where.channelId ?? "", {
            body: `⏰ Routine “${data.title}” — @hive ${data.note}`.slice(0, 39_000),
            ...(data.where.rootId ? { threadRoot: data.where.rootId } : {}),
            clientId: `routine:${entry.id}:${now}`,
          });
          lastTriggerId = posted.id;
          const run = this.deps.runOf(posted.id);
          if (run?.state === "failed")
            throw new AppError(`The agent could not start (${run.reason ?? "refused"})`, 409);
        }
        failures = 0;
        fires += 1;
        lastRunAt = new Date(now).toISOString();
        lastResult = undefined;
      } catch (error) {
        failures += 1;
        lastResult = error instanceof Error ? error.message : "Could not start";
        if (failures >= ROUTINE_LIMITS.failuresToPause) {
          status = "paused";
          next = null;
          this.deps.tell(owner, {
            key: `routine-paused:${entry.id}:${now}`,
            title: "A routine was paused",
            body: `“${data.title}” stopped after ${failures} tries in a row: ${lastResult}`,
          });
        }
      }
    }
    if (status === "active" && data.schedule.kind === "once" && scheduled) {
      status = "done";
      next = null;
    }
    return this.deps.rules.keep({
      ...entry,
      status,
      dueAt: next ? new Date(next).toISOString() : undefined,
      data: {
        ...data,
        failures,
        fires,
        ...(lastRunAt ? { lastRunAt } : {}),
        ...(lastTriggerId ? { lastTriggerId } : {}),
        ...(lastResult ? { lastResult } : {}),
      } as never,
    });
  }

  private async open(owner: string, id: string, right: "see" | "write" = "see"): Promise<Entry> {
    const entry = this.deps.entries.get(id);
    if (!entry || entry.kind !== ROUTINE)
      throw new AppError("That routine is not there, or you cannot see it.", 404);
    return this.deps.rules.open(owner, id, right);
  }
}
