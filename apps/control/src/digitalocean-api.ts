import { retryingFetch } from "./http.ts";

/** A call to DigitalOcean that did not go through, with its own words, for the logs and not for people. */
export class DigitalOceanError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DigitalOceanError";
  }
}

export interface DigitalOceanApiOptions {
  token: string;
  /** `https://api.digitalocean.com/v2`, or a stand-in for it. */
  apiUrl: string;
  /** The first pause before trying a refused call again, doubled each time (milliseconds; 500 when unset). */
  retryMs?: number;
}

/** DigitalOcean's API: JSON in and out, a busy or failing call tried again, and an error that says what was refused. */
export class DigitalOceanApi {
  constructor(private readonly options: DigitalOceanApiOptions) {}

  /** Every item of a paged list. */
  async all<T>(path: string, key: string): Promise<T[]> {
    const found: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.call<
        Record<string, unknown> & { links?: { pages?: { next?: string } } }
      >("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=200&page=${page}`);
      found.push(...(((result as Record<string, unknown>)[key] as T[] | undefined) ?? []));
      if (!result?.links?.pages?.next) break;
    }
    return found;
  }

  /** A call to the API. Statuses in `accept` come back as `null`; anything else not ok is an error. */
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    accept: number[] = [],
  ): Promise<T | null> {
    const response = await retryingFetch(
      `${this.options.apiUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.options.retryMs,
    );
    if (accept.includes(response.status)) return null;
    const text = await response.text();
    if (!response.ok) {
      let said = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (typeof parsed.message === "string") said = parsed.message.slice(0, 300);
      } catch {}
      throw new DigitalOceanError(
        `${method} ${path.split("?")[0]} answered ${response.status}: ${said}`,
        response.status,
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }
}
