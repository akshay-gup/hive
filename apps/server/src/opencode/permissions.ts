/**
 * Permission rulesets for OpenCode sessions.
 *
 * OpenCode evaluates rulesets last-wins (findLast over merged agent +
 * session rules), so session rules always beat the agent's native defaults.
 * The native default is permissive (`"*": "allow"`); Akshay's call is
 * default-ask, user-configurable per channel/thread (opencode-style rules).
 */
import type { PermissionRuleset } from "@opencode-ai/sdk/v2/client";

export type { PermissionRuleset };

/**
 * Permission mode, mirroring the OpenCode TUI's auto-approve toggle
 * (command palette: "Enable/Disable auto-approve permissions").
 * - "ask": every tool asks unless a rule says otherwise (default)
 * - "auto": run without asking; explicit "deny" rules are still enforced
 */
export type PermissionMode = "ask" | "auto";

/**
 * The session base ruleset. In "ask" mode every tool asks unless a later
 * rule says otherwise; in "auto" mode (TUI auto-approve) everything is
 * allowed unless explicitly denied. The agent's own ways of stopping to plan
 * (plan_enter/plan_exit) are denied in both modes — without that the
 * wildcard would resurrect them as ask-then-TTL-reject instead of an
 * immediate deny. Its `question` tool is left on: a chat has a person to
 * answer it, and Hive shows the question as a card (see approvals.ts).
 */
export function defaultSessionRuleset(mode: PermissionMode = "ask"): PermissionRuleset {
  return [
    { permission: "*", pattern: "*", action: mode === "auto" ? "allow" : "ask" },
    ...nonInteractiveTools(["plan_enter", "plan_exit"]),
  ];
}

/**
 * The agent's own ways of stopping to ask the person something that Hive has no screen for. A run
 * that calls one waits for an answer that can never be given, so they are denied outright, which
 * also keeps the tools from being offered to the model at all, so it asks in its reply instead.
 */
function nonInteractiveTools(
  tools: string[] = ["question", "plan_enter", "plan_exit"],
): PermissionRuleset {
  return tools.map((permission) => ({
    permission,
    pattern: "*",
    action: "deny" as const,
  }));
}

/**
 * Full session ruleset: mode base first, user rules last so they win
 * via findLast. Directory ALLOWs never go here — they belong in the server
 * config so a project opencode.json can still deny/ask specific folders.
 */
export function buildSessionRuleset(
  userRules: PermissionRuleset,
  mode: PermissionMode = "ask",
  /** Last, so that it wins: what the agent is not to open at all (see agent-watch/watch.ts `denyRules`). */
  protect: PermissionRuleset = [],
): PermissionRuleset {
  return [...defaultSessionRuleset(mode), ...userRules, ...protect];
}

/**
 * Unattended task-worker sessions: default-ask would stall on TTL
 * auto-reject with no user present to answer, so task sessions run
 * allow-all. The scoping boundary is the channel workspace directory
 * (session cwd) plus the server config's directory rules — not these rules.
 * Interactive chat threads still get the default-ask base.
 *
 * The tools that stop to ask the person are still denied: with allow-all alone the agent is
 * offered `question`, calls it, and waits for good (a task that needs an answer says so with
 * TASK_BLOCKED instead). A chat, which has a person to answer, keeps `question`.
 */
export function taskSessionRuleset(protect: PermissionRuleset = []): PermissionRuleset {
  return [{ permission: "*", pattern: "*", action: "allow" }, ...nonInteractiveTools(), ...protect];
}
