import app, { type Bucket, type Env } from "../../apps/chat/src/app.ts";
import type { Peer } from "../../apps/chat/src/realtime.ts";
import { RoomLogic } from "../../apps/chat/src/room-logic.ts";
import {
  type ChatLimits,
  generateWorkspaceKeys,
  signChatToken,
  type WorkspaceRole,
} from "../../packages/integrations/src/workspace-token.ts";
import { memorySql } from "./do-shim.ts";

/** An R2 bucket in memory. */
export class FakeBucket implements Bucket {
  readonly objects = new Map<string, Uint8Array>();
  /** What the bucket claims a stored object weighs, for a test that wants it to say more than was sent. */
  lie?: (key: string, real: number) => number;

  async put(key: string, value: ReadableStream) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    return { size: this.lie ? this.lie(key, bytes.length) : bytes.length };
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length?: number } | { suffix: number } },
  ) {
    const all = this.objects.get(key);
    if (!all) return null;
    const range = options?.range;
    let offset = 0;
    let length = all.length;
    if (range && "suffix" in range) {
      length = Math.min(range.suffix, all.length);
      offset = all.length - length;
    } else if (range) {
      offset = range.offset;
      length = Math.min(range.length ?? all.length - offset, all.length - offset);
    }
    const slice = all.slice(offset, offset + length);
    return {
      body: new Response(slice).body as ReadableStream,
      size: all.length,
      ...(range ? { range: { offset, length } } : {}),
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

export interface Identity {
  sub: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

/**
 * The chat Worker with real rooms (Node's SQLite for each workspace) and a bucket in memory, driven by
 * requests as the app would make them.
 */
export function chatStack(
  options: { limits?: ChatLimits; linkKey?: string; peers?: () => Peer[] } = {},
) {
  const keys = generateWorkspaceKeys();
  const bucket = new FakeBucket();
  const rooms = new Map<string, RoomLogic>();
  const clock = { now: Date.now() };
  const woke: number[] = [];
  const env: Env = {
    ROOMS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (request: Request) => {
          const name = String(id);
          let room = rooms.get(name);
          if (!room) {
            room = new RoomLogic(memorySql(), {
              purge: async () => {
                rooms.delete(name);
              },
              clock: () => clock.now,
              linkKey: () => env.FILE_LINK_KEY,
              deleteObjects: (objects) => bucket.delete(objects),
              wakeIn: (ms) => woke.push(ms),
              peers: options.peers,
            });
            rooms.set(name, room);
          }
          return room.fetch(request);
        },
      }),
    },
    CONTROL_PUBLIC_KEY: keys.publicKey,
    CHAT_ALLOWED_ORIGINS: "https://app.test",
    FILES: bucket,
    FILE_LINK_KEY: options.linkKey ?? "test-link-key",
  };
  const token = (who: Identity, workspaceId = "w1", now?: number) =>
    signChatToken(keys.privateKey, { ...who, workspaceId, limits: options.limits, now });
  const ask = (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token: bearer, ...rest } = init;
    return app.request(
      `https://chat.test${path}`,
      {
        ...rest,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...((rest.headers as Record<string, string>) ?? {}),
        },
      },
      env,
    );
  };
  /** One person's calls to a workspace. */
  const as = (who: Identity, workspaceId = "w1") => {
    const call = (method: string, path: string, body?: unknown) =>
      ask(`/w/${workspaceId}${path}`, {
        method,
        token: token(who, workspaceId),
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return {
      call,
      get: (path: string) => call("GET", path),
      post: (path: string, body?: unknown) => call("POST", path, body ?? {}),
      del: (path: string) => call("DELETE", path),
      /** Send bytes to an address the room gave. */
      put: (path: string, bytes: Uint8Array | string, headers: Record<string, string> = {}) =>
        ask(`/w/${workspaceId}${path}`, {
          method: "PUT",
          body: bytes as BodyInit,
          headers: {
            "content-length": String(
              typeof bytes === "string" ? new TextEncoder().encode(bytes).length : bytes.length,
            ),
            ...headers,
          },
        }),
      fetch: (path: string, headers: Record<string, string> = {}) =>
        ask(`/w/${workspaceId}${path}`, { headers }),
    };
  };
  const maintain = (workspaceId = "w1") => rooms.get(workspaceId)?.maintain();
  return { app, env, keys, bucket, rooms, clock, woke, token, ask, as, maintain };
}
