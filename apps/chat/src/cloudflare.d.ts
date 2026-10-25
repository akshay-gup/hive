// The part of Cloudflare's Workers runtime that apps/chat uses, declared here so the Node build can
// check the files without Cloudflare's type package. Cloudflare provides the module at run time.
declare module "cloudflare:workers" {
  export interface SqlStorageCursor<T> {
    toArray(): T[];
    one(): T;
    readonly rowsRead: number;
    readonly rowsWritten: number;
  }
  export interface SqlStorage {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  }
  export interface DurableObjectStorage {
    sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  }
  export interface DurableObjectState {
    readonly id: { toString(): string; name?: string };
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
    acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
    setWebSocketAutoResponse(pair?: unknown): void;
    waitUntil(promise: Promise<unknown>): void;
  }
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}
