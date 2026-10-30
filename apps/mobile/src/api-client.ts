import { chatPathOf } from "./chat-routes";

/** The chat service, as the app reaches it: its address for this workspace and the token it takes. */
export interface ChatConnection {
  /** `https://chat.example.com/w/<workspace>`, with no trailing slash. */
  url: string;
  /** The live connection's address. */
  wsUrl: string;
  token: string;
  /** When the token runs out, in milliseconds. */
  expiresAt?: number;
  /** Asked for a new chat token when the chat service refuses this one; resolves with it, or null. */
  renew?: () => Promise<string | null>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A workspace's API, called with a session. A hosted workspace's session lasts an hour, so the
 * owner of this object can give it `renew`: when the workspace refuses the session the request
 * is made again, once, with the new one. Everyone who holds this object sees the new token.
 */
export class MuseApi {
  /** Asked for a new session when the workspace refuses this one; resolves with its token, or null if there is none. */
  renew?: () => Promise<string | null>;
  private renewing: Promise<string | null> | null = null;
  private renewingChat: Promise<string | null> | null = null;
  /** The chat service, where the workspace has one: channels and what people say in them go there. */
  chat?: ChatConnection;
  /**
   * What the chat service gave for the machine to change the board for this person (approving a review, seeing
   * which tasks they may): sent with what goes to the workspace's machine (never to the chat service).
   */
  boardTicket?: string;
  constructor(
    public token: string,
    readonly baseUrl: string,
  ) {}

  /** Where a call goes, with the token to make it with: the chat service for what it answers, the workspace for the rest. */
  private target(path: string) {
    const chatPath = this.chat ? chatPathOf(path) : null;
    return this.chat && chatPath
      ? { url: `${this.chat.url}${chatPath}`, token: this.chat.token, chat: true }
      : { url: `${this.baseUrl}${path}`, token: this.token, chat: false };
  }

  private send(path: string, body: unknown, method?: string) {
    const target = this.target(path);
    return fetch(target.url, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${target.token}`,
        ...(!target.chat && this.boardTicket ? { "X-Hive-Board": this.boardTicket } : {}),
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  }

  /** One renewal at a time, however many requests were refused together. */
  private renewToken(): Promise<string | null> {
    if (!this.renewing) {
      const renewal = this.renew ? this.renew() : Promise.resolve(null);
      this.renewing = renewal
        .then((token) => {
          if (token) this.token = token;
          return token;
        })
        .catch(() => null)
        .finally(() => {
          this.renewing = null;
        });
    }
    return this.renewing;
  }

  /** One renewal of the chat token at a time. */
  private renewChatToken(): Promise<string | null> {
    const chat = this.chat;
    if (!chat) return Promise.resolve(null);
    if (!this.renewingChat) {
      const renewal = chat.renew ? chat.renew() : Promise.resolve(null);
      this.renewingChat = renewal
        .then((token) => {
          if (token) chat.token = token;
          return token;
        })
        .catch(() => null)
        .finally(() => {
          this.renewingChat = null;
        });
    }
    return this.renewingChat;
  }

  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    let response = await this.send(path, body, method);
    // The request was turned away before anything was done, so making it again is safe.
    if (response.status === 401) {
      const renewed = this.target(path).chat
        ? await this.renewChatToken()
        : this.renew
          ? await this.renewToken()
          : null;
      if (renewed) response = await this.send(path, body, method);
    }
    const payload = await response.json();
    if (!response.ok)
      throw new ApiError(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
        response.status,
      );
    return payload;
  }

  url(path: string) {
    return path.startsWith("http") ? path : `${this.baseUrl}${path}`;
  }

  /** An address on the chat service (a file's link, which it gives as a path), made whole. */
  chatUrl(path: string) {
    if (!this.chat) throw new Error("This workspace has no chat service");
    return path.startsWith("http") ? path : `${this.chat.url}${path}`;
  }
}
