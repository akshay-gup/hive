import type { ChatFrame } from "../../../packages/domain/src/chat";

type Frame = ChatFrame;

/** What opens a connection: the address, and the token to open it with (asked for afresh each time). */
export interface SocketSource {
  url: () => string;
  token: () => string;
  /** Called before a new connection is made, to get a fresh token when the last one has run out. */
  refresh?: () => Promise<unknown>;
}

interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(): void;
}
export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** How often the app says it is there, so the connection is not let go as idle. */
const HEARTBEAT_MS = 25_000;
/** The connection ends with this when the token it was opened with ran out. */
export const CLOSE_EXPIRED = 4401;

/**
 * The app's live connection to the chat service. It keeps the number of the last event seen, so when it
 * has to connect again (the network went, the token ran out) it asks only for what it missed, and says
 * so with `resync` when that is too much to send. Everything goes to `onFrame`; `onState` says whether
 * there is a connection.
 */
export class ChatSocket {
  private socket: SocketLike | null = null;
  private cursor = 0;
  private attempt = 0;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private connected = false;

  constructor(
    private readonly source: SocketSource,
    private readonly onFrame: (frame: Frame) => void,
    private readonly onState: (connected: boolean) => void = () => undefined,
    private readonly factory: SocketFactory = (url, protocols) =>
      new WebSocket(url, protocols) as unknown as SocketLike,
    private readonly schedule: (work: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      work,
      ms,
    ) => setTimeout(work, ms),
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.beat);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setConnected(false);
  }

  /** The app came back to the front, or the network came back: connect now if there is no connection. */
  nudge() {
    if (this.stopped || this.connected || this.socket) return;
    clearTimeout(this.timer);
    this.attempt = 0;
    void this.open();
  }

  /** Say something to the service (a person typing). Nothing is sent while there is no connection. */
  send(frame: { t: "typing"; channelId: string }) {
    if (this.connected) this.socket?.send(JSON.stringify(frame));
  }

  get isConnected() {
    return this.connected;
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.onState(value);
  }

  private async open() {
    if (this.stopped || this.socket) return;
    try {
      await this.source.refresh?.();
    } catch {
      // The token is tried as it is; if it is no good the connection says so.
    }
    if (this.stopped || this.socket) return;
    let socket: SocketLike;
    try {
      socket = this.factory(this.source.url(), ["hive.v1", this.source.token()]);
    } catch {
      this.again();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      socket.send(JSON.stringify({ t: "hello", cursor: this.cursor }));
      clearInterval(this.beat);
      this.beat = setInterval(() => {
        try {
          socket.send("ping");
        } catch {
          // The close handler takes it from here.
        }
      }, HEARTBEAT_MS);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let frame: Frame;
      try {
        frame = JSON.parse(event.data) as Frame;
      } catch {
        return;
      }
      if (frame.t === "ready") {
        this.cursor = frame.cursor;
        this.setConnected(true);
      } else if (frame.t === "resync") {
        this.cursor = frame.cursor;
        this.setConnected(true);
      } else if (frame.t === "event") this.cursor = Math.max(this.cursor, frame.id);
      this.onFrame(frame);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.beat);
      this.setConnected(false);
      if (this.stopped) return;
      // A token that ran out is made again at once; anything else waits a little, longer each time.
      if (event.code === CLOSE_EXPIRED) void this.open();
      else this.again();
    };
  }

  private again() {
    if (this.stopped) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    this.attempt++;
    this.timer = this.schedule(() => void this.open(), wait);
  }
}
