import type { RateLimiter, RateLimitResult } from '../types';

export interface MemoryRateLimiterOptions {
  /** Injected for tests. */
  now?: () => number;
  /** Upper bound on tracked keys (memory is bounded). Default 100000. */
  maxKeys?: number;
}

interface Entry {
  count: number;
  expiresAt: number;
}

/**
 * Fixed-window counter in this process's memory: the same semantics as the Postgres provider (a key's first check opens a
 * window, later checks inside it count up, the first check after it expires starts a new one), with NO shared state.
 * Limits are therefore per instance: run N instances and a user can make up to N times the limit. Use the Postgres store
 * when instances must share counters.
 */
export function createMemoryRateLimiter(options: MemoryRateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 100_000;
  const entries = new Map<string, Entry>();

  function sweep(t: number): void {
    for (const [key, e] of entries) if (e.expiresAt <= t) entries.delete(key);
    if (entries.size >= maxKeys) {
      // Still full of live windows: drop the oldest tenth (Map keeps insertion order) rather than grow without bound.
      let drop = Math.ceil(maxKeys / 10);
      for (const key of entries.keys()) {
        if (drop-- <= 0) break;
        entries.delete(key);
      }
    }
  }

  return {
    async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
      const t = now();
      let e = entries.get(key);
      if (!e || e.expiresAt <= t) {
        if (!e && entries.size >= maxKeys) sweep(t);
        e = { count: 1, expiresAt: t + Math.max(1, Math.floor(windowMs)) };
        entries.delete(key); // re-insert so insertion order follows window start
        entries.set(key, e);
      } else {
        e.count += 1;
      }
      return { allowed: e.count <= limit, remaining: Math.max(0, limit - e.count), resetAt: new Date(e.expiresAt) };
    },
  };
}
