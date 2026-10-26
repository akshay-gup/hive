import { z } from "zod";

/**
 * What the machine tells the chat service when the agent touches something of the machine's own: the
 * workspace's database, its keys, other channels' folders. The agent has the machine, so this is a
 * watch and not a lock: it marks what it can see, and the owner and admins read the marks. The
 * service fills in who asked and where from the run, so the machine cannot name them.
 */

export const WATCH_MODES = ["audit", "enforce"] as const;
/** `audit` marks and lets it be; `enforce` also refuses what the agent's file tools are asked to open. */
export type WatchMode = (typeof WATCH_MODES)[number];

export const WATCH_SOURCES = ["command", "file-tool", "kernel", "watch"] as const;
export const WATCH_SCOPES = ["channel", "own-chat", "task", "machine"] as const;
export const WATCH_SEVERITIES = ["low", "medium", "high"] as const;
export const WATCH_ACTIONS = ["marked", "blocked"] as const;

/** What a person is told when the agent's run is stopped for reaching the machine's own data. */
export const WATCH_STOP_TEXT = "Stopped, because the agent tried to open the workspace's own data.";

/** What a person is told when the agent is paused because the machine's kernel watch is not working. */
export const WATCH_DOWN_TEXT =
  "The watch on this machine is not working, so the agent is paused until it is back.";

const text = (max: number) => z.string().max(max);

/** One thing the machine saw. */
export const watchFindingSchema = z.object({
  /** How it was seen: the words of a shell command, an agent file tool's path, the kernel, or the watch itself. */
  source: z.enum(WATCH_SOURCES),
  scope: z.enum(WATCH_SCOPES),
  /** The run it happened in, when it was one a channel started. */
  runId: text(100).optional(),
  tool: text(100),
  /** What was touched, as a full path with `..` and `~` worked out. */
  target: text(500),
  /** The shell command, cut short. */
  command: text(500).optional(),
  /** Which rule matched, in a word. */
  rule: text(100),
  severity: z.enum(WATCH_SEVERITIES),
  action: z.enum(WATCH_ACTIONS),
  mode: z.enum(WATCH_MODES),
});
export type WatchFinding = z.infer<typeof watchFindingSchema>;

/** A finding as the service keeps it and the app lists it. */
export interface WatchRecord extends Omit<WatchFinding, "runId"> {
  id: string;
  at: string;
  runId?: string;
  /** Who asked (their id) and the channel, from the run; absent for the person's own chat and for tasks. */
  askerId?: string;
  channelId?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** Words for a rule, for the list an admin reads. */
export const RULE_TEXT: Record<string, string> = {
  database: "the workspace's database",
  keys: "the workspace's keys and settings",
  files: "files kept for the whole workspace",
  "other-channel": "another channel's folder",
  environment: "the machine's environment",
  obfuscation: "a command that hides what it opens",
  watch: "the watch itself",
};
