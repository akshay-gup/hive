import type { WatchFinding, WatchRecord } from "../../domain/src/agent-watch.ts";
import { first, type Sql } from "./sql.ts";

/** What keeps the list from filling: a run's own share, a day's, and how long and how many are kept. */
export const FLAG_LIMITS = {
  perRun: 30,
  perDay: 500,
  keepMs: 60 * 24 * 3600_000,
  keepRows: 2000,
} as const;

interface Row {
  id: string;
  at_ms: number;
  run_id: string | null;
  channel_id: string | null;
  asked_by: string | null;
  scope: WatchRecord["scope"];
  source: WatchRecord["source"];
  tool: string;
  target: string;
  command: string | null;
  rule: string;
  severity: WatchRecord["severity"];
  action: WatchRecord["action"];
  mode: WatchRecord["mode"];
  reviewed_by: string | null;
  reviewed_ms: number | null;
}

const toRecord = (row: Row): WatchRecord => ({
  id: row.id,
  at: new Date(row.at_ms).toISOString(),
  source: row.source,
  scope: row.scope,
  tool: row.tool,
  target: row.target,
  rule: row.rule,
  severity: row.severity,
  action: row.action,
  mode: row.mode,
  ...(row.run_id ? { runId: row.run_id } : {}),
  ...(row.command ? { command: row.command } : {}),
  ...(row.asked_by ? { askerId: row.asked_by } : {}),
  ...(row.channel_id ? { channelId: row.channel_id } : {}),
  ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
  ...(row.reviewed_ms ? { reviewedAt: new Date(row.reviewed_ms).toISOString() } : {}),
});

/**
 * What the machine saw the agent open of its own data, kept for the owner and admins. The machine says what
 * it saw; who asked and where come from the run the room holds, never from the machine.
 */
export class AgentFlags {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Keep a finding. False if it is one too many (for its run, or for the day). */
  add(
    id: string,
    finding: WatchFinding,
    run: { id: string; channelId: string; askedBy: string } | null,
  ): boolean {
    const now = this.clock();
    if (
      run &&
      (first<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM agent_flags WHERE run_id = ?",
        run.id,
      )?.n ?? 0) >= FLAG_LIMITS.perRun
    )
      return false;
    if (
      (first<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM agent_flags WHERE at_ms > ?",
        now - 24 * 3600_000,
      )?.n ?? 0) >= FLAG_LIMITS.perDay
    )
      return false;
    return (
      this.sql.run(
        `INSERT OR IGNORE INTO agent_flags
           (id, at_ms, run_id, channel_id, asked_by, scope, source, tool, target, command, rule, severity, action, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        now,
        run?.id ?? null,
        run?.channelId ?? null,
        run?.askedBy ?? null,
        run ? "channel" : finding.scope === "channel" ? "own-chat" : finding.scope,
        finding.source,
        finding.tool,
        finding.target,
        finding.command ?? null,
        finding.rule,
        finding.severity,
        finding.action,
        finding.mode,
      ) > 0
    );
  }

  /** Newest first. */
  list(limit = 200): WatchRecord[] {
    return this.sql
      .all<Row>("SELECT * FROM agent_flags ORDER BY at_ms DESC, id LIMIT ?", limit)
      .map(toRecord);
  }

  /** How many a person with the say has not yet looked at: the ones that matter more than "low". */
  unreviewed(): number {
    return (
      first<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM agent_flags WHERE reviewed_ms IS NULL AND severity != 'low'",
      )?.n ?? 0
    );
  }

  /** One bell item uses the newest significant flag as its read/dismiss revision, even after review. */
  attention(): { count: number; latestId: string; at: string } | null {
    const count = this.unreviewed();
    if (!count) return null;
    const latest = first<{ id: string; at_ms: number }>(
      this.sql,
      "SELECT id, at_ms FROM agent_flags WHERE severity != 'low' ORDER BY rowid DESC LIMIT 1",
    );
    return latest ? { count, latestId: latest.id, at: new Date(latest.at_ms).toISOString() } : null;
  }

  /** Mark one (or, with no id, all) as looked at; how many changed. */
  review(by: string, id?: string): number {
    return this.sql.run(
      `UPDATE agent_flags SET reviewed_by = ?, reviewed_ms = ? WHERE reviewed_ms IS NULL${id ? " AND id = ?" : ""}`,
      ...(id ? [by, this.clock(), id] : [by, this.clock()]),
    );
  }

  /** Old ones, and all but the newest few thousand, are let go of. */
  prune(): number {
    const old = this.sql.run(
      "DELETE FROM agent_flags WHERE at_ms < ?",
      this.clock() - FLAG_LIMITS.keepMs,
    );
    const extra = this.sql.run(
      "DELETE FROM agent_flags WHERE id IN (SELECT id FROM agent_flags ORDER BY at_ms DESC, id LIMIT -1 OFFSET ?)",
      FLAG_LIMITS.keepRows,
    );
    return old + extra;
  }
}
