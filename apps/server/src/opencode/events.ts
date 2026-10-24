/**
 * Global OpenCode event pipeline.
 *
 * ONE SSE stream to `/global/event` for the whole process (reconnecting with
 * backoff, after Kimaki's global-event-listener — MIT). Events are fanned out
 * per thread, filtered by sessionId:
 * - busy/idle is derived from `session.status` / `session.idle` events ONLY
 *   (message.part.delta and friends never touch the state buffer);
 * - events for a superseded sessionId are dropped (session rotation);
 * - each thread has a serialized action queue so promptAsync dispatches and
 *   permission replies for the same session never run concurrently.
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { type OpencodeConnection, opencodeAuthHeaders } from "./server.ts";

export interface OpenCodeEvent {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

interface ThreadTrack {
  /** Current session id; events for older ids are stale and dropped. */
  sessionId?: string;
  handlers: Set<(event: OpenCodeEvent) => void>;
  /** Serialized action queue (prompt dispatch, permission replies). */
  queue: Promise<void>;
  busy: boolean;
}

/**
 * What a `session.error` event says went wrong. OpenCode names the error and keeps its message under
 * `data` (`{ name: "APIError", data: { message: "Forbidden: …", statusCode: 403 } }`), so a provider
 * failure such as a bad key, an unknown model or a rate limit reads as itself and not as "an error".
 */
export function sessionErrorMessage(error: unknown, fallback: string): string {
  const failure = error as
    | { name?: unknown; message?: unknown; data?: { message?: unknown } }
    | undefined;
  for (const text of [failure?.data?.message, failure?.message])
    if (typeof text === "string" && text.trim()) return text;
  return typeof failure?.name === "string" && failure.name
    ? `${fallback} (${failure.name})`
    : fallback;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export class OpencodeEventBus {
  private readonly tracks = new Map<string, ThreadTrack>();
  private readonly client: ReturnType<typeof createOpencodeClient>;
  private aborter?: AbortController;
  private loop?: Promise<void>;
  private connected = false;
  private connectionWaiters: Array<() => void> = [];

  constructor(connection: OpencodeConnection) {
    this.client = createOpencodeClient({
      baseUrl: connection.url,
      headers: opencodeAuthHeaders(connection),
    });
  }

  /** Start the global SSE loop. Idempotent. */
  start(): void {
    if (this.loop) return;
    const aborter = new AbortController();
    this.aborter = aborter;
    this.loop = this.runLoop(aborter.signal).catch(() => undefined);
  }

  /** Stop the loop and drop all tracks. */
  async stop(): Promise<void> {
    this.aborter?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    this.tracks.clear();
    this.connected = false;
  }

  /** Resolve once the global stream is connected (prompt dispatch waits on this). */
  waitForConnection(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.connectionWaiters.push(resolve);
    });
  }

  /** Register (or re-register after rotation) a thread's current session. */
  track(threadId: string, sessionId: string): void {
    this.getOrCreateTrack(threadId).sessionId = sessionId;
  }

  /** Forget a thread entirely (thread dispose rejects pending permissions first). */
  untrack(threadId: string): void {
    this.tracks.delete(threadId);
  }

  /** Subscribe to a thread's OpenCode events. Returns an unsubscribe fn. */
  onEvent(threadId: string, handler: (event: OpenCodeEvent) => void): () => void {
    const track = this.getOrCreateTrack(threadId);
    track.handlers.add(handler);
    return () => {
      track.handlers.delete(handler);
    };
  }

  /** Busy iff the last `session.status` for the thread's session said busy. */
  isBusy(threadId: string): boolean {
    return this.tracks.get(threadId)?.busy ?? false;
  }

  /** Run an action serialized with the thread's other actions. */
  enqueue<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const track = this.getOrCreateTrack(threadId);
    const previous = track.queue;
    let release!: () => void;
    track.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    })();
  }

  private getOrCreateTrack(threadId: string): ThreadTrack {
    let track = this.tracks.get(threadId);
    if (!track) {
      track = { handlers: new Set(), queue: Promise.resolve(), busy: false };
      this.tracks.set(threadId, track);
    }
    return track;
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      const waiters = this.connectionWaiters;
      this.connectionWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private dispatch(raw: unknown): void {
    const payload = (raw as { payload?: unknown })?.payload as OpenCodeEvent | undefined;
    if (!payload || typeof payload.type !== "string") return;
    // `sync` envelopes duplicate the raw events with versioned types; ignore.
    if (payload.type === "sync") return;
    const sessionID = payload.properties?.sessionID;
    if (typeof sessionID !== "string") return;
    for (const track of this.tracks.values()) {
      // Drop stale events from a rotated-out session.
      if (track.sessionId !== sessionID) continue;
      if (payload.type === "session.status") {
        const status = payload.properties.status as { type?: string } | undefined;
        track.busy = status?.type !== "idle";
      } else if (payload.type === "session.idle") {
        track.busy = false;
      }
      for (const handler of track.handlers) {
        try {
          handler(payload);
        } catch {
          // A throwing handler must not break fan-out to other threads.
        }
      }
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = RECONNECT_BASE_MS;
    while (!signal.aborted) {
      let stream: AsyncIterable<unknown> | undefined;
      try {
        const result = await this.client.global.event({ signal });
        stream = result.stream;
      } catch {
        if (signal.aborted) return;
        await this.delay(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        continue;
      }
      this.setConnected(true);
      let receivedAnyEvent = false;
      try {
        for await (const event of stream ?? []) {
          receivedAnyEvent = true;
          this.dispatch(event);
        }
      } catch {
        // Stream broke mid-flight; reconnect below. A run that finished
        // during the gap is bounded by the shim's run timeout.
      }
      this.setConnected(false);
      if (signal.aborted) return;
      backoffMs = receivedAnyEvent ? RECONNECT_BASE_MS : Math.min(backoffMs * 2, RECONNECT_MAX_MS);
      await this.delay(backoffMs, signal);
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
