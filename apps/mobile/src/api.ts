import { Platform } from "react-native";
import { storage } from "./storage";

/**
 * Where the workspace is, for a build that opens one workspace server directly (a hosted build
 * is told by its control plane and does not use this). A web page that a workspace serves uses
 * its own origin; an app or a page hosted elsewhere is told by `EXPO_PUBLIC_API_URL` or, when run
 * from a dev build, finds the local server. Failing those, the person is asked (see
 * `connect-workspace.tsx`) and the answer is kept.
 */
const trimmed = (url: string) => url.replace(/\/$/, "");

/** Set at build time, or the dev server on this machine when running a dev build. */
export function configuredWorkspaceUrl(): string | undefined {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return trimmed(configured);
  if (__DEV__ && Platform.OS !== "web")
    return Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787";
  return undefined;
}

/** The page's own origin, on the web, which is the workspace when the workspace serves the page. */
export function sameOriginWorkspaceUrl(): string | undefined {
  return Platform.OS === "web" && typeof window !== "undefined" && window.location?.origin
    ? trimmed(window.location.origin)
    : undefined;
}

let workspaceUrl = configuredWorkspaceUrl() ?? sameOriginWorkspaceUrl() ?? "";
/** The workspace every direct request goes to. */
export function apiUrl(): string {
  return workspaceUrl;
}
export function setApiUrl(url: string) {
  workspaceUrl = trimmed(url);
}

const workspaceKey = "hive:workspace";
/** The workspace this device last opened, if the person chose one. */
export async function savedWorkspaceUrl(): Promise<string> {
  return (await storage.get(workspaceKey)) ?? "";
}
export async function saveWorkspaceUrl(url: string): Promise<void> {
  if (url) await storage.set(workspaceKey, url);
  else await storage.remove(workspaceKey);
}

/** Is there a Hive workspace at this address? Every workspace answers /api/health without signing in. */
export async function probeWorkspace(url: string): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${trimmed(url)}/api/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { ok?: unknown; mode?: unknown } | null;
    return { ok: body?.ok === true && typeof body.mode === "string" };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export { ApiError, MuseApi } from "./api-client";

/** One session per workspace, so changing workspace does not sign anyone out of another. */
const sessionKey = () => `hive:session:${workspaceUrl}`;
/** The session this device kept for the workspace server it signs in to directly. */
export async function savedSession(): Promise<string> {
  return (await storage.get(sessionKey())) ?? "";
}
export async function saveSession(token: string) {
  if (token) await storage.set(sessionKey(), token);
  else await storage.remove(sessionKey());
}

export async function createSession(): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${apiUrl()}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not open your workspace.");
  return payload;
}

/**
 * Start Google sign-in: returns the OAuth URL to open in a browser. A web page names its origin
 * (the popup answers it); an app sends the challenge for the proof it holds back.
 */
export async function googleLoginUrl(
  options: { origin?: string; challenge?: string } = {},
): Promise<{ url: string }> {
  const query = [
    options.origin ? `origin=${encodeURIComponent(options.origin)}` : "",
    options.challenge ? `challenge=${encodeURIComponent(options.challenge)}` : "",
  ].filter(Boolean);
  const response = await fetch(
    `${apiUrl()}/api/auth/google/url${query.length ? `?${query.join("&")}` : ""}`,
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Google sign-in is not available.");
  return payload;
}

/** Exchange a single-use login code (deep link / popup), with the proof it was started with, for the session. */
export async function exchangeLoginCode(
  code: string,
  proof: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${apiUrl()}/api/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, proof }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Sign-in expired. Try again.");
  return payload;
}
