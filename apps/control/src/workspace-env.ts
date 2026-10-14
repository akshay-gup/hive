import type { WorkspaceSpec } from "./provisioner.ts";

/** Where the workspace server listens inside whatever it runs on, and where it keeps its data. */
export const WORKSPACE_PORT = 8787;
export const WORKSPACE_DATA_DIR = "/data/hive";

/**
 * HIVE_WORKSPACE_ENV: what every workspace of a deployment is given besides what Hive sets, such as
 * its model and provider keys, as a JSON object of strings.
 */
export function workspaceEnvFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!env.HIVE_WORKSPACE_ENV?.trim()) return {};
  try {
    const parsed = JSON.parse(env.HIVE_WORKSPACE_ENV);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.values(parsed).some((value) => typeof value !== "string")
    )
      throw new Error("not an object of strings");
    return parsed;
  } catch {
    throw new Error("HIVE_WORKSPACE_ENV must be a JSON object of strings");
  }
}

/**
 * What a workspace is told about itself: which workspace it is, who may vouch for people, and where
 * it is reached. The server makes its own secrets on its disk at first start, so none of them pass
 * through here.
 */
export function workspaceSettings(
  spec: WorkspaceSpec,
  publicUrl: string,
  shared: Record<string, string>,
  /** `host` is the address the server listens on: all of them (the default), or 127.0.0.1 when only the machine itself connects to it. */
  options: { host?: string } = {},
): Record<string, string> {
  return {
    ...shared,
    WORKSPACE_MODE: "live",
    WORKSPACE_ID: spec.workspaceId,
    CONTROL_PLANE_PUBLIC_KEY: spec.controlPublicKey,
    PUBLIC_API_URL: publicUrl,
    ALLOWED_ORIGINS: spec.allowedOrigins.join(","),
    HOST: options.host ?? "0.0.0.0",
    PORT: String(WORKSPACE_PORT),
    DATA_DIR: WORKSPACE_DATA_DIR,
    TASK_WORKER_ENABLED: "true",
  };
}
