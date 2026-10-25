import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { parseWorkspacePublicKey } from "../../../packages/integrations/src/workspace-token.ts";
import { normalizeMention } from "./opencode/agui.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[Hive] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

/**
 * One-time move off the old cwd-relative default: when DATA_DIR points
 * somewhere fresh but a legacy ./.hive from an earlier install exists,
 * adopt it so the database, files, and channel folders survive the move.
 * Best-effort; a failed move never fails boot (data stays where it was).
 */
function adoptLegacyDataDir(dataDir: string) {
  const legacy = resolve(".hive");
  if (legacy === dataDir || !existsSync(legacy)) return;
  try {
    const fresh = !existsSync(dataDir) || readdirSync(dataDir).length === 0;
    if (!fresh) return;
    renameSync(legacy, dataDir);
    console.log(`[Hive] Moved legacy data dir ${legacy} -> ${dataDir}`);
  } catch (error) {
    console.warn(
      `[Hive] Could not move legacy data dir: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * A workspace run by the Hive control plane. People do not sign in here: the control plane signs
 * them in and vouches for them with a token for this workspace (`workspaceId`), which it signs
 * with the key `controlPublicKey` verifies.
 */
export interface ManagedWorkspace {
  workspaceId: string;
  /** Base64url DER (SPKI) of the control plane's Ed25519 public key. */
  controlPublicKey: string;
}

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  /** Override for the served web UI directory; defaults to apps/mobile/dist/web. */
  webDir?: string;
  encryptionKey?: string;
  /** The `provider/model-id` OpenCode runs the agent on (MODEL). */
  model?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  /** Base URL of the systemd-managed `opencode serve`. */
  opencodeServerUrl?: string;
  /** OPENCODE_SERVER_PASSWORD; enables Basic auth against `opencode serve`. */
  opencodeServerPassword?: string;
  /** Mention token that summons the agent in chat (AGENT_MENTION, default `@hive`). */
  agentMention?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  /** Restrict this process's task worker to one channel. Unset = claim all (legacy). */
  workerChannelId?: string;
  /** When true, the main process manages per-channel worker processes. */
  manageChannels?: boolean;
  /** Idle minutes after which an unused channel worker is reaped. */
  channelWorkerIdleMinutes?: number;
  allowedOrigins: string[];
  /**
   * Where this machine gets the token it connects to the chat service with, and the key that asks for it:
   * set on a workspace the control plane runs, where the agent answers mentions in chat channels.
   */
  chatRunner?: { tokenUrl: string; key: string };
  /** Set when the Hive control plane runs this workspace (WORKSPACE_ID, CONTROL_PLANE_PUBLIC_KEY). */
  managed?: ManagedWorkspace;
}

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const dataDir = resolve(process.env.DATA_DIR ?? ".hive");
  adoptLegacyDataDir(dataDir);
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir,
    databaseUrl: process.env.DATABASE_URL,
    webDir: process.env.WEB_DIR?.trim() || undefined,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    opencodeServerUrl: process.env.OPENCODE_SERVER_URL?.trim() || undefined,
    opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    agentMention: normalizeMention(process.env.AGENT_MENTION),
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    workerChannelId: process.env.HIVE_CHANNEL?.trim() || undefined,
    manageChannels: process.env.HIVE_MANAGE_CHANNELS === "true",
    channelWorkerIdleMinutes: Number(process.env.HIVE_CHANNEL_IDLE_MINUTES ?? 30),
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
  };
  const chatTokenUrl = process.env.CHAT_RUNNER_TOKEN_URL?.trim();
  const chatKey = process.env.CHAT_RUNNER_KEY?.trim();
  if (chatTokenUrl && chatKey) config.chatRunner = { tokenUrl: chatTokenUrl, key: chatKey };
  const workspaceId = process.env.WORKSPACE_ID?.trim();
  const controlPublicKey = process.env.CONTROL_PLANE_PUBLIC_KEY?.trim();
  if (workspaceId || controlPublicKey) {
    if (!workspaceId || !controlPublicKey)
      throw new Error("A managed workspace needs both WORKSPACE_ID and CONTROL_PLANE_PUBLIC_KEY");
    if (mode !== "live") throw new Error("A managed workspace runs in live mode");
    parseWorkspacePublicKey(controlPublicKey);
    config.managed = { workspaceId, controlPublicKey };
  }
  if (mode === "live" && !config.encryptionKey)
    throw new Error("Live mode requires TOKEN_ENCRYPTION_KEY (32-byte base64)");
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
