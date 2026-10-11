/** What the edge knows of a workspace: where it is, or why nothing can be said. */
export type Resolved =
  | { status: "running"; host: string; port: number }
  | { status: "unknown" }
  | { status: "stopped" }
  | { status: "unavailable" };

interface Entry {
  result: Resolved;
  /** Until when it is believed, and until when a workspace that was running is still taken to be. */
  until: number;
  keepUntil: number;
}

export interface ResolverOptions {
  controlUrl: string;
  token: string;
  /** How long where a workspace is stays believed, and how long that it is unknown or stopped does. */
  cacheMs: number;
  negativeMs: number;
  /** How long a workspace that was running is taken to be, when the control plane cannot be asked. */
  staleMs?: number;
  /** How long to ask no one after the control plane could not be reached. */
  coolOffMs?: number;
  maxEntries?: number;
  /** How many questions may be out at once; any more are answered as if the control plane could not be asked. */
  maxLookups?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** An address the control plane gave, as a host and port, or null when it is not a plain http one. */
export function parseUpstream(value: unknown): { host: string; port: number } | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !url.hostname || url.username || url.password) return null;
    return { host: url.hostname, port: Number(url.port || 80) };
  } catch {
    return null;
  }
}

/**
 * Finds the machine a workspace is on by asking the control plane, and remembers the answer, so a
 * busy workspace costs one question a minute and not one a request. Questions about a workspace
 * that arrive together are one question. When the control plane cannot be reached, a workspace
 * that was running a moment ago is taken to still be.
 */
export class Resolver {
  private readonly entries = new Map<string, Entry>();
  private readonly lookups = new Map<string, Promise<Resolved>>();
  private coolUntil = 0;

  constructor(private readonly options: ResolverOptions) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** How many answers are remembered. */
  get size() {
    return this.entries.size;
  }

  async resolve(id: string): Promise<Resolved> {
    const entry = this.entries.get(id);
    if (entry && entry.until > this.now()) return entry.result;
    const running = this.lookups.get(id);
    if (running) return running;
    // Names made up in bulk would otherwise each be a question to the control plane.
    if (this.lookups.size >= (this.options.maxLookups ?? 64)) return this.stale(entry);
    const lookup = this.ask(id, entry).finally(() => this.lookups.delete(id));
    this.lookups.set(id, lookup);
    return lookup;
  }

  /** What was believed of a workspace turned out wrong: ask again next time. */
  forget(id: string) {
    this.entries.delete(id);
  }

  /** What is still taken to be so when the control plane is not asked. */
  private stale(previous: Entry | undefined): Resolved {
    return previous?.result.status === "running" && previous.keepUntil > this.now()
      ? previous.result
      : { status: "unavailable" };
  }

  private async ask(id: string, previous: Entry | undefined): Promise<Resolved> {
    if (this.now() < this.coolUntil) return this.stale(previous);
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.controlUrl}/internal/upstream/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${this.options.token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.status === 200) {
        const address = parseUpstream(((await response.json()) as { upstream?: unknown }).upstream);
        if (!address) throw new Error("it gave an address that is not a plain http one");
        return this.remember(id, { status: "running", ...address }, this.options.cacheMs);
      }
      if (response.status === 404)
        return this.remember(id, { status: "unknown" }, this.options.negativeMs);
      if (response.status === 503)
        return this.remember(id, { status: "stopped" }, this.options.negativeMs);
      throw new Error(`it answered ${response.status}`);
    } catch (error) {
      this.coolUntil = this.now() + (this.options.coolOffMs ?? 2000);
      this.options.log?.(
        `could not ask the control plane about ${id}: ${error instanceof Error ? error.message : error}`,
      );
      return this.stale(previous);
    }
  }

  private remember(id: string, result: Resolved, ms: number): Resolved {
    const now = this.now();
    // Re-inserting keeps the oldest at the front, to be dropped when there are too many.
    this.entries.delete(id);
    this.entries.set(id, {
      result,
      until: now + ms,
      keepUntil: now + (this.options.staleMs ?? 600_000),
    });
    const max = this.options.maxEntries ?? 20_000;
    for (const key of this.entries.keys()) {
      if (this.entries.size <= max) break;
      this.entries.delete(key);
    }
    return result;
  }
}
