import type {
  PromptChoice,
  PromptState,
  RunPrompt,
  RunReason,
} from "../../domain/src/chat-agent.ts";
import { first, type Sql } from "./sql.ts";

export type RunState = "queued" | "sent" | "running" | "done" | "failed" | "stopped";
const ACTIVE = "('queued', 'sent', 'running')";

/** What keeps the agent from being used up: by one person, by a workspace, and in time. */
export const RUN_LIMITS = {
  perPerson: { count: 8, windowMs: 10 * 60_000 },
  perWorkspace: { count: 60, windowMs: 60 * 60_000 },
  concurrentPerChannel: 2,
  /** What the machine says it can run at once, unless it says. */
  defaultMaxRuns: 2,
  queueDepth: 8,
  maxRunMs: 45 * 60_000,
  promptWaitMs: 30 * 60_000,
  /** How long a run may wait for a machine to take it (waking one takes a while). */
  wakeMs: 120_000,
  /** A running run that has not been heard of for this long is thought lost. */
  beatStaleMs: 90_000,
  /** A lost run is failed if it has not shown up again after this. */
  lostGraceMs: 180_000,
  /** The least between two snapshots of a reply that are kept; the others are only shown. */
  saveEveryMs: 1_000,
  maxUpdates: 4_000,
} as const;

export interface Run {
  id: string;
  channelId: string;
  rootId: string;
  triggerId: string;
  replyId: string;
  askedBy: string;
  askerRole: string;
  state: RunState;
  reason: RunReason | null;
  prompts: PromptState[];
  lastN: number;
  attempt: number;
  createdMs: number;
  sentMs: number | null;
  beatMs: number | null;
  endedMs: number | null;
  updates: number;
  savedMs: number;
}

interface Row {
  id: string;
  channel_id: string;
  root_id: string;
  trigger_id: string;
  reply_id: string;
  asked_by: string;
  asker_role: string;
  state: RunState;
  reason: RunReason | null;
  prompts: string;
  last_n: number;
  attempt: number;
  created_ms: number;
  sent_ms: number | null;
  beat_ms: number | null;
  ended_ms: number | null;
  updates: number;
  saved_ms: number;
}

const toRun = (row: Row): Run => ({
  id: row.id,
  channelId: row.channel_id,
  rootId: row.root_id,
  triggerId: row.trigger_id,
  replyId: row.reply_id,
  askedBy: row.asked_by,
  askerRole: row.asker_role,
  state: row.state,
  reason: row.reason,
  prompts: JSON.parse(row.prompts) as PromptState[],
  lastN: row.last_n,
  attempt: row.attempt,
  createdMs: row.created_ms,
  sentMs: row.sent_ms,
  beatMs: row.beat_ms,
  endedMs: row.ended_ms,
  updates: row.updates,
  savedMs: row.saved_ms,
});

export const isActive = (run: Pick<Run, "state">) =>
  run.state === "queued" || run.state === "sent" || run.state === "running";

/**
 * The agent's runs, as rows, and what may become of one. A run only moves forward (queued, sent, running,
 * then one of the three ends) and an ended run is never touched again: whatever a machine says about it
 * after that is dropped. Who may ask, and what the machine may say, is decided before these are called.
 */
export class Runs {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  get(id: string): Run | null {
    const row = first<Row>(this.sql, "SELECT * FROM runs WHERE id = ?", id);
    return row ? toRun(row) : null;
  }

  byReply(replyId: string): Run | null {
    const row = first<Row>(this.sql, "SELECT * FROM runs WHERE reply_id = ?", replyId);
    return row ? toRun(row) : null;
  }

  create(input: {
    id: string;
    channelId: string;
    rootId: string;
    triggerId: string;
    replyId: string;
    askedBy: string;
    askerRole: string;
    state?: RunState;
    reason?: RunReason;
  }): Run {
    const now = this.clock();
    this.sql.run(
      `INSERT INTO runs (id, channel_id, root_id, trigger_id, reply_id, asked_by, asker_role, state, reason, created_ms, ended_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.channelId,
      input.rootId,
      input.triggerId,
      input.replyId,
      input.askedBy,
      input.askerRole,
      input.state ?? "queued",
      input.reason ?? null,
      now,
      input.state && input.state !== "queued" ? now : null,
    );
    return this.get(input.id) as Run;
  }

  /** Whether another run may be made now for this person and channel; the reason if not. */
  check(askedBy: string, channelId: string): RunReason | null {
    const now = this.clock();
    const count = (query: string, ...bindings: unknown[]) =>
      first<{ n: number }>(this.sql, query, ...bindings)?.n ?? 0;
    if (
      count(
        "SELECT COUNT(*) AS n FROM runs WHERE asked_by = ? AND created_ms > ?",
        askedBy,
        now - RUN_LIMITS.perPerson.windowMs,
      ) >= RUN_LIMITS.perPerson.count
    )
      return "limit";
    if (
      count(
        "SELECT COUNT(*) AS n FROM runs WHERE created_ms > ?",
        now - RUN_LIMITS.perWorkspace.windowMs,
      ) >= RUN_LIMITS.perWorkspace.count
    )
      return "limit";
    if (
      count(
        `SELECT COUNT(*) AS n FROM runs WHERE channel_id = ? AND state IN ${ACTIVE}`,
        channelId,
      ) >=
      RUN_LIMITS.concurrentPerChannel + RUN_LIMITS.queueDepth
    )
      return "busy";
    if (count("SELECT COUNT(*) AS n FROM runs WHERE state = 'queued'") >= RUN_LIMITS.queueDepth)
      return "busy";
    return null;
  }

  active(): Run[] {
    return this.sql
      .all<Row>(`SELECT * FROM runs WHERE state IN ${ACTIVE} ORDER BY created_ms, id`)
      .map(toRun);
  }

  /** How many runs the machine has in hand (sent to it, or running). */
  inHand(): number {
    return (
      first<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM runs WHERE state IN ('sent', 'running')",
      )?.n ?? 0
    );
  }

  /**
   * The oldest queued run that may go to the machine now: one at a time in a thread, in order, and only
   * as many at once as the machine can take or the channel is allowed.
   */
  nextToSend(maxRuns: number): Run | null {
    if (this.inHand() >= maxRuns) return null;
    const row = first<Row>(
      this.sql,
      `SELECT q.* FROM runs q WHERE q.state = 'queued'
       AND NOT EXISTS (SELECT 1 FROM runs b WHERE b.channel_id = q.channel_id AND b.root_id = q.root_id AND b.state IN ('sent', 'running'))
       AND (SELECT COUNT(*) FROM runs c WHERE c.channel_id = q.channel_id AND c.state IN ('sent', 'running')) < ?
       ORDER BY q.created_ms, q.id LIMIT 1`,
      RUN_LIMITS.concurrentPerChannel,
    );
    return row ? toRun(row) : null;
  }

  /** Sent to the machine. */
  markSent(id: string): Run | null {
    const now = this.clock();
    this.sql.run(
      "UPDATE runs SET state = 'sent', sent_ms = ?, beat_ms = ?, attempt = attempt + 1 WHERE id = ? AND state IN ('queued', 'sent')",
      now,
      now,
      id,
    );
    return this.get(id);
  }

  /** The machine has taken it. False if it is not one it may take (ended, or not sent). */
  markRunning(id: string): boolean {
    return (
      this.sql.run(
        "UPDATE runs SET state = 'running', beat_ms = ? WHERE id = ? AND state IN ('sent', 'running')",
        this.clock(),
        id,
      ) > 0
    );
  }

  /** Put a sent run back in the queue (the machine it was sent to went away before taking it). */
  requeue(id: string): void {
    this.sql.run("UPDATE runs SET state = 'queued' WHERE id = ? AND state = 'sent'", id);
  }

  beat(ids: string[]): void {
    const now = this.clock();
    for (const id of ids)
      this.sql.run(
        "UPDATE runs SET beat_ms = ? WHERE id = ? AND state IN ('sent', 'running')",
        now,
        id,
      );
  }

  /**
   * Take a snapshot of the reply if it is newer than the last and the run is running, and not too soon after
   * the last one. Returns whether it was taken, and whether it is one to keep (not just to show).
   */
  say(id: string, n: number): { taken: boolean; keep: boolean } {
    const now = this.clock();
    const run = this.get(id);
    if (!run || (run.state !== "running" && run.state !== "sent"))
      return { taken: false, keep: false };
    if (n <= run.lastN || run.updates >= RUN_LIMITS.maxUpdates)
      return { taken: false, keep: false };
    const keep = now - run.savedMs >= RUN_LIMITS.saveEveryMs;
    this.sql.run(
      `UPDATE runs SET state = 'running', last_n = ?, updates = updates + 1, beat_ms = ?, saved_ms = CASE WHEN ? THEN ? ELSE saved_ms END WHERE id = ?`,
      n,
      now,
      keep ? 1 : 0,
      now,
      id,
    );
    return { taken: true, keep };
  }

  /** End a run, once. Returns it as it now is, or null if it had already ended (or there is none). */
  end(id: string, state: "done" | "failed" | "stopped", reason: RunReason): Run | null {
    const changed = this.sql.run(
      `UPDATE runs SET state = ?, reason = ?, ended_ms = ? WHERE id = ? AND state IN ${ACTIVE}`,
      state,
      reason,
      this.clock(),
      id,
    );
    return changed > 0 ? this.get(id) : null;
  }

  /** The agent asks something of the people. */
  addPrompt(id: string, prompt: RunPrompt, requestId: string): Run | null {
    const run = this.get(id);
    if (!run || (run.state !== "running" && run.state !== "sent")) return null;
    if (run.prompts.length >= 40 || run.prompts.some((p) => p.prompt.id === prompt.id)) return run;
    this.sql.run(
      "UPDATE runs SET prompts = ? WHERE id = ?",
      JSON.stringify([
        ...run.prompts,
        { prompt, requestId, askedAt: new Date(this.clock()).toISOString() },
      ]),
      id,
    );
    return this.get(id);
  }

  /** Someone answers; only the first answer is taken. Returns the prompt answered, or null. */
  answer(
    id: string,
    promptId: string,
    by: { id: string; name: string },
    choice: PromptChoice,
  ): PromptState | null {
    return this.sql.transaction(() => {
      const run = this.get(id);
      if (!run || !isActive(run)) return null;
      const at = run.prompts.findIndex((p) => p.prompt.id === promptId);
      const found = run.prompts[at];
      if (at === -1 || !found || found.answered) return null;
      const prompts = [...run.prompts];
      prompts[at] = {
        ...found,
        answered: { by: by.id, byName: by.name, at: new Date(this.clock()).toISOString(), choice },
      };
      this.sql.run("UPDATE runs SET prompts = ? WHERE id = ?", JSON.stringify(prompts), id);
      return prompts[at] ?? null;
    });
  }

  /** The agent has gone on without waiting (the question was dropped on its side): nothing is left to answer. */
  closePrompt(id: string, promptId: string): void {
    const run = this.get(id);
    if (!run) return;
    const prompts = run.prompts.map((p) =>
      p.prompt.id === promptId && !p.answered
        ? {
            ...p,
            answered: {
              by: "agent",
              byName: "",
              at: new Date(this.clock()).toISOString(),
              choice: { dismiss: true as const },
            },
          }
        : p,
    );
    this.sql.run("UPDATE runs SET prompts = ? WHERE id = ?", JSON.stringify(prompts), id);
  }

  /** What no longer should go on: too long waiting for a machine, too long running, too long unanswered, gone quiet. */
  expired(): { run: Run; reason: RunReason }[] {
    const now = this.clock();
    const out: { run: Run; reason: RunReason }[] = [];
    for (const run of this.active()) {
      if (run.state === "queued" && now - run.createdMs > RUN_LIMITS.wakeMs)
        out.push({ run, reason: "no-runner" });
      else if (run.state === "sent" && now - (run.sentMs ?? run.createdMs) > RUN_LIMITS.wakeMs)
        out.push({ run, reason: "no-runner" });
      else if (run.state === "running" && now - run.createdMs > RUN_LIMITS.maxRunMs)
        out.push({ run, reason: "timeout" });
      else if (
        run.prompts.some(
          (p) => !p.answered && now - Date.parse(p.askedAt ?? "") > RUN_LIMITS.promptWaitMs,
        )
      )
        out.push({ run, reason: "timeout" });
    }
    return out;
  }

  /** Running runs not heard of for a while: lost unless they show up again. */
  quiet(): Run[] {
    const now = this.clock();
    return this.active().filter(
      (run) =>
        run.state === "running" && now - (run.beatMs ?? run.createdMs) > RUN_LIMITS.beatStaleMs,
    );
  }

  hasActive(): boolean {
    return first(this.sql, `SELECT 1 FROM runs WHERE state IN ${ACTIVE} LIMIT 1`) !== undefined;
  }

  /** Old ended runs are let go of. */
  prune(keepMs = 30 * 24 * 3600_000): number {
    return this.sql.run(
      `DELETE FROM runs WHERE state NOT IN ${ACTIVE} AND ended_ms < ?`,
      this.clock() - keepMs,
    );
  }

  removeOfChannel(channelId: string): number {
    return this.sql.run("DELETE FROM runs WHERE channel_id = ?", channelId);
  }
}
