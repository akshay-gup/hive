import { retryingFetch } from "./http.ts";

/** A call to Cloudflare that did not go through, with its own words, for the logs and not for people. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Cloudflare's own error codes, which say more than the status does. */
    readonly codes: number[] = [],
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

export interface CloudflareApiOptions {
  /** An API token. It is never put in an error. */
  token: string;
  /** `https://api.cloudflare.com/client/v4`, or a stand-in for it. */
  apiUrl: string;
  /** The first pause before trying a refused call again, doubled each time (milliseconds; 500 when unset). */
  retryMs?: number;
}

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
  result_info?: { page?: number; total_pages?: number };
}

/**
 * Cloudflare's API: JSON in and out inside an envelope, a busy or failing call tried again, and an
 * error that says what was refused.
 */
export class CloudflareApi {
  constructor(private readonly options: CloudflareApiOptions) {}

  /**
   * A call to the API, giving back the envelope's `result`. Statuses in `accept` come back as
   * `null`; anything else not ok, or an envelope that says it failed, is an error.
   */
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
    const envelope = await this.envelope<T>(response);
    if (!response.ok || envelope.success === false)
      throw this.failure(method, path, response, envelope);
    return (envelope.result ?? null) as T | null;
  }

  /** Every item of a paged list. */
  async all<T>(path: string): Promise<T[]> {
    const found: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await retryingFetch(
        `${this.options.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${this.options.token}` } },
        this.options.retryMs,
      );
      const envelope = await this.envelope<T[]>(response);
      if (!response.ok || envelope.success === false)
        throw this.failure("GET", path, response, envelope);
      found.push(...(envelope.result ?? []));
      if (page >= (envelope.result_info?.total_pages ?? 1)) break;
    }
    return found;
  }

  private async envelope<T>(response: Response): Promise<Envelope<T>> {
    const text = await response.text();
    try {
      return JSON.parse(text) as Envelope<T>;
    } catch {
      // Not Cloudflare's envelope (a proxy's error page, say): keep a little of it to say what came.
      return { success: response.ok, errors: [{ message: text.slice(0, 200) }] };
    }
  }

  private failure(method: string, path: string, response: Response, envelope: Envelope<unknown>) {
    const errors = envelope.errors ?? [];
    const said = errors
      .map((error) => error.message ?? "")
      .filter(Boolean)
      .join("; ")
      .slice(0, 300);
    return new CloudflareError(
      `${method} ${path.split("?")[0]} answered ${response.status}${said ? `: ${said}` : ""}`,
      response.status,
      errors.flatMap((error) => (typeof error.code === "number" ? [error.code] : [])),
    );
  }
}
