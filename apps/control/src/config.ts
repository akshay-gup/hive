import { resolve } from "node:path";

export interface ControlConfig {
  /** `sample` signs anyone in without Google and is for a laptop; `live` signs in with Google. */
  mode: "sample" | "live";
  port: number;
  host: string;
  /** Where people reach the control plane and its web app: the base of invite links, and the origin workspaces allow. */
  publicUrl: string;
  dataDir: string;
  /** A Postgres to keep accounts and workspaces in; without one, an embedded database in `dataDir`. */
  databaseUrl?: string;
  /** The Expo web export to serve; defaults to apps/mobile/dist/web. */
  webDir?: string;
  /** Web origins besides `publicUrl` that may call the API. */
  allowedOrigins: string[];
  /** How many workspaces one person can have made. */
  maxWorkspacesPerAccount: number;
  /**
   * The header the host's proxy puts the visitor's address in (Fly-Client-IP on Fly). Sign-in
   * limits count per visitor, and without it every visitor looks like the proxy.
   */
  clientIpHeader?: string;
  /**
   * What the edge proxy shows to ask where a workspace is. Without one there is no such route, which
   * is right for a host (Fly) whose own proxy reaches workspaces.
   */
  edgeToken?: string;
  /**
   * What CI and an operator show to say which build of the workspace everyone should run. Without one
   * there is no such route, and machines are told nothing.
   */
  releaseToken?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
}

type Env = Record<string, string | undefined>;

/** The control plane's settings from the environment (CONTROL_*, and Google's client as everywhere else). */
export function readControlConfig(env: Env = process.env): ControlConfig {
  const mode = env.CONTROL_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live") throw new Error("CONTROL_MODE must be sample or live");
  const port = Number(env.CONTROL_PORT ?? 8800);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("CONTROL_PORT must be a port number");
  const host = env.CONTROL_HOST ?? "127.0.0.1";
  const publicUrl = (env.CONTROL_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(
    /\/+$/,
    "",
  );
  const maxWorkspaces = Number(env.CONTROL_MAX_WORKSPACES ?? 3);
  if (!Number.isInteger(maxWorkspaces) || maxWorkspaces < 1)
    throw new Error("CONTROL_MAX_WORKSPACES must be a whole number of at least 1");
  const config: ControlConfig = {
    mode,
    port,
    host,
    publicUrl,
    dataDir: resolve(env.CONTROL_DATA_DIR ?? ".hive-control"),
    databaseUrl: env.CONTROL_DATABASE_URL?.trim() || undefined,
    webDir: env.CONTROL_WEB_DIR?.trim() || undefined,
    // A sample control plane also answers the Expo web dev server, as the workspace server does.
    allowedOrigins: (
      env.CONTROL_ALLOWED_ORIGINS ??
      (mode === "sample" ? "http://localhost:8081,http://127.0.0.1:8081" : "")
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    maxWorkspacesPerAccount: maxWorkspaces,
    clientIpHeader: env.CONTROL_CLIENT_IP_HEADER?.trim() || undefined,
    edgeToken: env.CONTROL_EDGE_TOKEN?.trim() || undefined,
    releaseToken: env.CONTROL_RELEASE_TOKEN?.trim() || undefined,
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    googleRedirectUri: `${publicUrl}/v1/auth/google/callback`,
  };
  if (config.edgeToken && config.edgeToken.length < 32)
    throw new Error("CONTROL_EDGE_TOKEN must be at least 32 characters");
  if (config.releaseToken && config.releaseToken.length < 32)
    throw new Error("CONTROL_RELEASE_TOKEN must be at least 32 characters");
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error(
      "The sample control plane is local-only. CONTROL_HOST must be a loopback address.",
    );
  if (mode === "live") {
    if (!config.googleClientId || !config.googleClientSecret)
      throw new Error(
        "Live mode signs in with Google: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
      );
    if (!publicUrl.startsWith("https://"))
      throw new Error("Live mode needs CONTROL_PUBLIC_URL to be an https address");
  }
  return config;
}
