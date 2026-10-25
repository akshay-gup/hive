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
import { readSignedLink, serveHeaders, type Variant } from "./uploads.ts";

/** The part of a Durable Object namespace this uses. */
export interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** The part of an R2 bucket this uses. */
export interface Bucket {
  put(
    key: string,
    value: ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ size: number }>;
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } | { suffix: number } },
  ): Promise<{
    body: ReadableStream;
    size: number;
    range?: { offset: number; length: number };
  } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Env {
  ROOMS: RoomNamespace;
  /** Where people's files are kept, under `w/<workspace>/`. */
  FILES?: Bucket;
  /** What addresses for sending and fetching files are signed with. */
  FILE_LINK_KEY?: string;
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
  workspaceId: verified.workspaceId,
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

/** What the Worker asks of a workspace's room once it has checked an address: the room says whether it still stands. */
async function askRoom(env: Env, workspaceId: string, action: string, body: unknown) {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(workspaceId));
  return stub.fetch(
    new Request("https://room/internal", {
      method: "POST",
      headers: { [INTERNAL_HEADER]: action, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** A `Range` header as the bucket takes it, or nothing for one it cannot make sense of (the whole file is sent). */
function rangeOf(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) return { suffix: Math.min(Number(match[2]), size) };
  const offset = Number(match[1]);
  if (offset >= size) return "unsatisfiable" as const;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return end < offset ? undefined : { offset, length: end - offset + 1 };
}

/**
 * A file is sent here, to the address the room gave its sender: good for that file and that many
 * bytes, once. The bytes go straight to the bucket; the room is told how many arrived, and throws the
 * file away if that is not what was said.
 */
app.put("/w/:ws/f/up/:id", async (c) => {
  const workspaceId = c.req.param("ws");
  const fileId = c.req.param("id");
  const bucket = c.env.FILES;
  const secret = c.env.FILE_LINK_KEY;
  if (!bucket || !secret) return c.json({ error: "Sending files is not set up here" }, 503);
  const claims = readSignedLink(secret, workspaceId, "up", fileId, new URL(c.req.url).searchParams);
  if (!claims || claims.bytes === undefined)
    return c.json({ error: "This upload address is not good any more" }, 403);
  const declared = Number(c.req.header("content-length"));
  if (!Number.isInteger(declared) || declared !== claims.bytes || !c.req.raw.body)
    return c.json({ error: `Send exactly ${claims.bytes} bytes` }, 400);
  const open = await askRoom(c.env, workspaceId, "file-state", { fileId, variant: claims.variant });
  if (!open.ok) return c.json({ error: "This upload is not open" }, 409);
  const state = (await open.json()) as { mime: string; bytes: number; key: string };
  if (state.bytes !== claims.bytes) return c.json({ error: "This upload is not open" }, 409);
  const key = `w/${workspaceId}/${state.key}`;
  let size: number;
  try {
    const { readable, writable } =
      typeof FixedLengthStream === "undefined"
        ? new TransformStream<Uint8Array, Uint8Array>()
        : new FixedLengthStream(claims.bytes);
    const piped = c.req.raw.body.pipeTo(writable);
    const stored = await bucket.put(key, readable, { httpMetadata: { contentType: state.mime } });
    await piped;
    size = stored.size;
  } catch {
    await bucket.delete(key).catch(() => undefined);
    return c.json({ error: "The file did not arrive whole. Try again." }, 400);
  }
  const done = await askRoom(c.env, workspaceId, "file-done", {
    fileId,
    variant: claims.variant,
    bytes: size,
  });
  if (!done.ok) {
    // The room refused it (it was not what was said): what was stored is not kept.
    await bucket.delete(key).catch(() => undefined);
    const error = ((await done.json().catch(() => ({}))) as { error?: string }).error;
    return c.json({ error: error ?? "That file could not be kept" }, done.status as 409);
  }
  return c.json({ ok: true, bytes: size });
});

/** A file is fetched from the address the room gave someone who may open its channel, for a few minutes. */
app.get("/w/:ws/f/dl/:id", async (c) => {
  const workspaceId = c.req.param("ws");
  const fileId = c.req.param("id");
  const bucket = c.env.FILES;
  const secret = c.env.FILE_LINK_KEY;
  if (!bucket || !secret) return c.json({ error: "Files are not set up here" }, 503);
  const claims = readSignedLink(secret, workspaceId, "dl", fileId, new URL(c.req.url).searchParams);
  if (!claims) return c.json({ error: "This link is not good any more" }, 403);
  const found = await askRoom(c.env, workspaceId, "file-download", {
    fileId,
    variant: claims.variant as Variant,
  });
  if (!found.ok) return c.json({ error: "File not found" }, 404);
  const file = (await found.json()) as { key: string; mime: string; name: string; bytes: number };
  const range = rangeOf(c.req.header("range"), file.bytes);
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${file.bytes}` },
    });
  const object = await bucket.get(`w/${workspaceId}/${file.key}`, range ? { range } : undefined);
  if (!object) return c.json({ error: "File not found" }, 404);
  const headers = serveHeaders(file.mime, file.name, object.range?.length ?? object.size);
  if (range && object.range)
    return new Response(object.body, {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
      },
    });
  return new Response(object.body, { headers });
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
