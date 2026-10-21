/**
 * OpenCode agent layer: session runtime for channel threads.
 *
 * Owns the connection to `opencode serve` (systemd-managed, never spawned),
 * per-directory SDK clients, thread ↔ session bindings, and (Phase 2+)
 * the global event pipeline and AG-UI shim.
 */

export {
  lastUserText,
  type OpencodeShimDeps,
  opencodeShimRoutes,
  parseModelRef,
  RunTranslator,
} from "./agui.ts";
export {
  type AskedPermissionProps,
  type PendingPermissionRequest,
  type PermissionReply,
  PermissionTracker,
  type TrackerReplyDeps,
} from "./approvals.ts";
export { type OpencodeClient, OpencodeClientPool } from "./client.ts";
export { type OpenCodeEvent, OpencodeEventBus, sessionErrorMessage } from "./events.ts";
export {
  buildSessionRuleset,
  defaultSessionRuleset,
  invalidRuleLines,
  isPermissionMode,
  type PermissionMode,
  type PermissionRuleset,
  parsePermissionRules,
  taskSessionRuleset,
} from "./permissions.ts";
export { opencodePermissionRoutes } from "./routes.ts";
export { PermissionRulesStore } from "./rules.ts";
export {
  assertCompatibleServerVersion,
  connectionFromConfig,
  DEFAULT_OPENCODE_SERVER_URL,
  ensureOpencodeServerReachable,
  OPENCODE_SDK_MAJOR,
  type OpencodeConnection,
  opencodeAuthHeaders,
} from "./server.ts";
export {
  ensureThreadSession,
  type OpencodeSessionRef,
  rotateThreadSession,
  type SessionContext,
  sessionDirectory,
} from "./sessions.ts";
export {
  type OpencodeTaskRuntime,
  parseTaskOutcome,
  planFromTodos,
  runOpencodeTask,
  TaskTextCollector,
} from "./tasks.ts";
