import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  type VerifiedWorkspaceToken,
  verifyChatPeople,
  verifyChatPurge,
  verifyChatRevocation,
  verifyChatToken,
  WorkspaceTokenError,
} from "../../../packages/integrations/src/workspace-token.ts";
import type { ChatIdentity } from "./core.ts";
import { IDENTITY_HEADER, INTERNAL_HEADER } from "./headers.ts";

/** The part of a Durable Object namespace this uses. */
export interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface Env {
  ROOMS: RoomNamespace;
  /** The control plane's public key, as the workspaces have it: the Worker knows tokens are the control plane's by it. */
  CONTROL_PUBLIC_KEY: string;
  /** The origins of the app, separated by commas. */
  CHAT_ALLOWED_ORIGINS?: string;
  /** A Cloudflare rate limit binding for each person's requests to a workspace. */
  CHAT_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) => {
  const allowed = (c.env.CHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

const bearer = (header: string | undefined) =>
  header?.startsWith("Bearer ") ? header.slice(7).trim() : "";

/** The room of a workspace, asked for something with the headers the Worker chooses and nothing the caller sent. */
function toRoom(env: Env, workspaceId: string, request: Request, path: string, headers: Headers) {
  const url = new URL(request.url);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(workspaceId));
  const forwarded = new Headers(headers);
  const type = request.headers.get("content-type");
  if (type) forwarded.set("content-type", type);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return stub.fetch(
    new Request(`https://room${path}${url.search}`, {
      method: request.method,
      headers: forwarded,
      body: hasBody ? request.body : undefined,
      // A body that is streamed on needs this.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit),
  );
}

/** What the control plane asks, after the token proves it is the control plane. */
app.post("/w/:ws/internal/:action", async (c) => {
  const workspaceId = c.req.param("ws");
  const action = c.req.param("action");
  const token = bearer(c.req.header("authorization"));
  try {
    if (action === "revoke") {
      const { sub } = verifyChatRevocation(c.env.CONTROL_PUBLIC_KEY, token, { workspaceId });
      return toRoom(
        c.env,
        workspaceId,
        new Request(c.req.url, { method: "POST", body: JSON.stringify({ sub }) }),
        "/internal",
        new Headers({ [INTERNAL_HEADER]: "revoke" }),
      );
    }
    if (action === "people") {
      verifyChatPeople(c.env.CONTROL_PUBLIC_KEY, token, { workspaceId });
      return toRoom(
        c.env,
        workspaceId,
        c.req.raw,
        "/internal",
        new Headers({ [INTERNAL_HEADER]: "people" }),
      );
    }
    if (action === "purge") {
      verifyChatPurge(c.env.CONTROL_PUBLIC_KEY, token, { workspaceId });
      return toRoom(
        c.env,
        workspaceId,
        c.req.raw,
        "/internal",
        new Headers({ [INTERNAL_HEADER]: "purge" }),
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceTokenError) return c.json({ error: "Not allowed" }, 401);
    throw error;
  }
  return c.json({ error: "Not found" }, 404);
});

const identityOf = (verified: VerifiedWorkspaceToken): ChatIdentity => ({
  sub: verified.sub,
  email: verified.email,
  name: verified.name,
  role: verified.role,
  issuedAt: verified.issuedAt,
  expiresAt: verified.expiresAt,
  limits: verified.limits,
});

/** Who a request's token says is asking, or the answer to give when it says no one. */
function whoIs(env: Env, workspaceId: string, token: string): ChatIdentity | null {
  try {
    return identityOf(verifyChatToken(env.CONTROL_PUBLIC_KEY, token, { workspaceId }));
  } catch (error) {
    if (error instanceof WorkspaceTokenError) return null;
    throw error;
  }
}

const slow = async (env: Env, workspaceId: string, identity: ChatIdentity) =>
  env.CHAT_LIMITER
    ? !(await env.CHAT_LIMITER.limit({ key: `${workspaceId}:${identity.sub}` })).success
    : false;

/**
 * The app's live connection. The token travels in the WebSocket's subprotocol list (`hive.v1, <token>`),
 * not in the address, so it stays out of logs.
 */
app.get("/w/:ws/v1/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return c.json({ error: "Connect with a WebSocket" }, 426);
  const workspaceId = c.req.param("ws");
  const [version, token] = (c.req.header("sec-websocket-protocol") ?? "")
    .split(",")
    .map((part) => part.trim());
  if (version !== "hive.v1" || !token) return c.json({ error: "Not signed in" }, 401);
  const identity = whoIs(c.env, workspaceId, token);
  if (!identity) return c.json({ error: "Sign in again to use chat" }, 401);
  if (await slow(c.env, workspaceId, identity))
    return c.json({ error: "Too many requests. Slow down." }, 429);
  // What the caller sent is not passed on, but what this has checked.
  const headers = new Headers();
  for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set("sec-websocket-protocol", "hive.v1");
  headers.set(IDENTITY_HEADER, JSON.stringify(identity));
  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(workspaceId));
  return stub.fetch(new Request("https://room/v1/ws", { method: "GET", headers }));
});

/** What the app asks. */
app.all("/w/:ws/v1/*", async (c) => {
  const workspaceId = c.req.param("ws");
  const identity = whoIs(c.env, workspaceId, bearer(c.req.header("authorization")));
  if (!identity) return c.json({ error: "Sign in again to use chat" }, 401);
  if (await slow(c.env, workspaceId, identity))
    return c.json({ error: "Too many requests. Slow down." }, 429);
  const path = new URL(c.req.url).pathname.slice(`/w/${workspaceId}`.length);
  return toRoom(
    c.env,
    workspaceId,
    c.req.raw,
    path,
    new Headers({ [IDENTITY_HEADER]: JSON.stringify(identity) }),
  );
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
