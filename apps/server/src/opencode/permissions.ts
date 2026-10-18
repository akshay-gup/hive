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

export function isPermissionMode(raw: unknown): raw is PermissionMode {
  return raw === "ask" || raw === "auto";
}

/**
 * Parse opencode-style rule strings into a PermissionRuleset.
 * Accepted formats: "tool:action" or "tool:pattern:action".
 * Lifted from Kimaki's parsePermissionRules (MIT).
 */
export function parsePermissionRules(raw: unknown): PermissionRuleset {
  if (!Array.isArray(raw)) return [];
  const validActions = new Set(["allow", "deny", "ask"]);
  return raw.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const parts = entry.split(":").map((s) => s.trim());
    if (parts.length === 2) {
      const [permission, rawAction] = parts as [string | undefined, string | undefined];
      const action = rawAction?.toLowerCase() ?? "";
      if (!permission || !validActions.has(action)) return [];
      return [{ permission, pattern: "*", action: action as "allow" | "deny" | "ask" }];
    }
    if (parts.length >= 3) {
      // Last segment is the action, first is the permission, everything in
      // between is the pattern (may contain colons, e.g. URL patterns).
      const permission = parts[0];
      const rawAction = parts[parts.length - 1];
      const action = rawAction?.toLowerCase() ?? "";
      const pattern = parts.slice(1, -1).join(":");
      if (!permission || !pattern || !validActions.has(action)) return [];
      return [{ permission, pattern, action: action as "allow" | "deny" | "ask" }];
    }
    return [];
  });
}

/**
 * The session base ruleset. In "ask" mode every tool asks unless a later
 * rule says otherwise; in "auto" mode (TUI auto-approve) everything is
 * allowed unless explicitly denied. The native `deny` rules for
 * non-interactive tools (question/plan_*) are preserved in both modes —
 * without them the wildcard would resurrect them as ask-then-TTL-reject
 * instead of an immediate deny.
 */
export function defaultSessionRuleset(mode: PermissionMode = "ask"): PermissionRuleset {
  return [
    { permission: "*", pattern: "*", action: mode === "auto" ? "allow" : "ask" },
    ...nonInteractiveTools(),
  ];
}

/**
 * The agent's own ways of stopping to ask the person something. Hive has no screen for them, so a
 * run that calls one waits for an answer that can never be given. They are denied outright, which
 * also keeps the tools from being offered to the model at all, so it asks in its reply instead.
 */
function nonInteractiveTools(): PermissionRuleset {
  return ["question", "plan_enter", "plan_exit"].map((permission) => ({
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
): PermissionRuleset {
  return [...defaultSessionRuleset(mode), ...userRules];
}

/**
 * Lines that don't parse to any rule (empty lines are skipped, not invalid).
 * Used to 422 bad rule submissions with the offending line named.
 */
export function invalidRuleLines(rules: string[]): string[] {
  return rules
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && parsePermissionRules([line]).length === 0);
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
 * TASK_BLOCKED instead).
 */
export function taskSessionRuleset(): PermissionRuleset {
  return [{ permission: "*", pattern: "*", action: "allow" }, ...nonInteractiveTools()];
}
