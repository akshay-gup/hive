import type { RoomFrame, RunnerFrame } from "../../../../packages/domain/src/chat-agent.ts";

/** The part of a WebSocket this uses, so a test can stand in for one. */
export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface LinkOptions {
  /** Where the control plane gives out the token to connect with, and the key that asks for it. */
  tokenUrl: string;
  key: string;
  onFrame: (frame: RoomFrame) => void;
  /** The connection is open: say hello. */
  onOpen: () => void;
  onClose?: (code: number) => void;
  fetcher?: typeof fetch;
  socket?: SocketFactory;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}

interface TokenAnswer {
  token: string;
  url: string;
  expiresAt: number;
}

const PROTOCOL = "hive.runner.v1";
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** After this long open, the last failure is forgotten and the next wait starts short again. */
const STABLE_MS = 15_000;
const PING_EVERY_MS = 25_000;
const PONG_WITHIN_MS = 12_000;
/** The token is renewed at this part of its life. */
const RENEW_AT = 0.7;
/** The room closes a connection with this when another one took its place. */
const CLOSE_REPLACED = 4409;

/**
 * The agent's machine's one connection to the chat service. It asks the control plane for a token (with the
 * workspace's own key), connects outward with it, renews it in-band before it runs out, and when the
 * connection drops goes back with a growing, jittered wait. It carries frames and decides nothing: what
 * the runs are is the host's business (see host.ts).
 */
export class RunnerLink {
  private socket: SocketLike | null = null;
  private stopped = true;
  private failures = 0;
  private openedAt = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private url: string | null = null;

  constructor(private readonly options: LinkOptions) {}

  private get fetcher() {
    return this.options.fetcher ?? fetch;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private log(line: string) {
    this.options.log?.(`[chat-runner] ${line}`);
  }

  get open(): boolean {
    return this.opened;
  }

  /** The chat service's address (https://...) as the last token said, which the addresses of a message's files are on. */
  get origin(): string | null {
    if (!this.url) return null;
    try {
      return new URL(this.url).origin.replace(/^ws/, "http");
    } catch {
      return null;
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.opened = false;
    try {
      socket?.close(1000, "Stopping");
    } catch {
      // Already closed.
    }
  }

  /** Send a frame; false if the connection is not open (the caller keeps what must not be lost). */
  send(frame: RunnerFrame): boolean {
    if (!this.socket || !this.opened) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private later(ms: number, work: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) work();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.add(timer);
  }

  private async token(): Promise<TokenAnswer> {
    const response = await this.fetcher(this.options.tokenUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the control plane answered ${response.status}`);
    const answer = (await response.json()) as Partial<TokenAnswer>;
    if (
      typeof answer.token !== "string" ||
      typeof answer.url !== "string" ||
      typeof answer.expiresAt !== "number"
    )
      throw new Error("the control plane's answer was not a token");
    return answer as TokenAnswer;
  }

  private async connect() {
    if (this.stopped || this.socket) return;
    let answer: TokenAnswer;
    try {
      answer = await this.token();
    } catch (error) {
      this.log(`could not get a token: ${error instanceof Error ? error.message : String(error)}`);
      return this.retry();
    }
    if (this.stopped) return;
    this.url = answer.url;
    const make: SocketFactory =
      this.options.socket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
    let socket: SocketLike;
    try {
      socket = make(answer.url, [PROTOCOL, answer.token]);
    } catch (error) {
      this.log(`could not connect: ${error instanceof Error ? error.message : String(error)}`);
      return this.retry();
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.openedAt = this.now();
      this.log("connected");
      this.watch();
      this.renewLater(answer.expiresAt);
      this.options.onOpen();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      if (event.data === "pong") {
        this.heard();
        return;
      }
      this.heard();
      let frame: RoomFrame;
      try {
        frame = JSON.parse(event.data) as RoomFrame;
      } catch {
        return;
      }
      if (frame && typeof frame === "object" && typeof frame.t === "string")
        this.options.onFrame(frame);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasOpen = this.opened;
      this.opened = false;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      if (wasOpen && this.now() - this.openedAt >= STABLE_MS) this.failures = 0;
      this.log(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
      this.options.onClose?.(event.code);
      if (this.stopped) return;
      // Another connection took this one's place: it will come back only if that one goes.
      if (event.code === CLOSE_REPLACED) this.failures = Math.max(this.failures, 4);
      this.retry();
    };
  }

  private retry() {
    if (this.stopped) return;
    this.failures++;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.failures - 1, 6));
    const jitter = base * (0.5 + (this.options.random ?? Math.random)() * 0.5);
    this.later(jitter, () => void this.connect());
  }

  /** Ask the room for a sign of life now and then: it answers "ping" with "pong" without waking, and a connection that does not is ended. */
  private watch() {
    this.later(PING_EVERY_MS, () => {
      const socket = this.socket;
      if (!socket || !this.opened) return;
      try {
        socket.send("ping");
      } catch {
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.log("no answer from the chat service; reconnecting");
        try {
          socket.close(4000, "No answer");
        } catch {
          // Already closed.
        }
        // A socket that never reports its closing is let go of.
        if (this.socket === socket) {
          socket.onclose?.({ code: 4000, reason: "No answer" });
        }
      }, PONG_WITHIN_MS);
      (this.pongTimer as unknown as { unref?: () => void }).unref?.();
    });
  }

  private heard() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.watch();
    }
  }

  private renewLater(expiresAt: number) {
    const life = Math.max(expiresAt - this.now(), 30_000);
    this.later(life * RENEW_AT, async () => {
      try {
        const answer = await this.token();
        if (this.send({ t: "renew", token: answer.token })) this.renewLater(answer.expiresAt);
      } catch (error) {
        this.log(`could not renew: ${error instanceof Error ? error.message : String(error)}`);
        // Try again soon; if the token runs out first the room closes the connection and it reconnects.
        this.later(15_000, () => this.renewLater(this.now() + 60_000));
      }
    });
  }
}
