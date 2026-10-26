import { RULE_TEXT, type WatchRecord } from "../../../packages/domain/src/agent-watch";

/** A finding as the chat service lists it for an owner or admin: with the names it could put to it. */
export type FlagRow = WatchRecord & { askerName?: string; channelName?: string };

/** Who asked and where, in a few words. */
export function flagWhere(flag: FlagRow): string {
  if (flag.scope === "channel")
    return `${flag.askerName ? `${flag.askerName}'s` : "A"} request in ${
      flag.channelName ? `#${flag.channelName}` : "a channel"
    }`;
  if (flag.scope === "task") return "A task the agent was working on";
  if (flag.scope === "machine") return "Something on the machine";
  return "A private chat with the agent";
}

/** What was done, in plain words. */
export function flagWhat(flag: FlagRow): string {
  const what = RULE_TEXT[flag.rule] ?? "something kept apart";
  if (flag.rule === "obfuscation") return "The agent ran a command that hides what it opens";
  return flag.action === "blocked" ? `The agent was refused ${what}` : `The agent opened ${what}`;
}

/** What to show underneath: the command, or the path. */
export function flagDetail(flag: FlagRow): string {
  return flag.command && flag.command !== flag.target ? flag.command : flag.target;
}

export const SEVERITY_WORD: Record<WatchRecord["severity"], string> = {
  high: "Serious",
  medium: "Look at",
  low: "Minor",
};

/** Not yet looked at first, then the more serious, then the newer. */
export function flagOrder(a: FlagRow, b: FlagRow): number {
  const open = Number(Boolean(a.reviewedAt)) - Number(Boolean(b.reviewedAt));
  if (open) return open;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at);
}

/** How many there are to look at, in a line. */
export function flagCount(unreviewed: number): string {
  if (unreviewed === 0) return "Nothing to look at.";
  return `${unreviewed} to look at.`;
}
