/** Whether a visitor is within what sign-ins allow. Several copies of the control plane need one that is shared. */
export interface SignInLimiter {
  allow(key: string): boolean | Promise<boolean>;
}

/**
 * Counts attempts per key in fixed windows, so one noisy visitor cannot use up what everyone
 * else is allowed. It remembers a bounded number of keys: past that, the oldest are forgotten.
 */
export class RateLimiter implements SignInLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Count an attempt by `key`, and say whether it is within the allowance. */
  allow(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (window && now - window.start < this.windowMs) return ++window.count <= this.max;
    if (this.windows.size >= this.maxKeys) this.forget(now);
    this.windows.set(key, { start: now, count: 1 });
    return true;
  }

  private forget(now: number) {
    for (const [key, window] of this.windows)
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    // Still full of live windows: drop the oldest, which are first in line.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}
