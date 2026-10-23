import type { RateLimiter, RateLimitResult } from '../types';
import { logger } from '../../logger';

/**
 * Fixed-window counter on the existing `rate_limits` table (no migration needed).
 *
 * One atomic statement per check. If the row for `key` has expired it is reset to
 * count=1 with a fresh window; otherwise the count is incremented. (A plain
 * `ON CONFLICT ... DO UPDATE ... WHERE expires_at > NOW()` would skip expired rows
 * instead of resetting them, which is the bug this CASE form avoids.)
 */
export const CHECK_SQL = `
INSERT INTO mx_rate_limits (key, count, window_start, expires_at)
VALUES ($1, 1, NOW(), NOW() + ($2::int * INTERVAL '1 millisecond'))
ON CONFLICT (key) DO UPDATE SET
  count        = CASE WHEN mx_rate_limits.expires_at <= NOW() THEN 1 ELSE mx_rate_limits.count + 1 END,
  window_start = CASE WHEN mx_rate_limits.expires_at <= NOW() THEN NOW() ELSE mx_rate_limits.window_start END,
  expires_at   = CASE WHEN mx_rate_limits.expires_at <= NOW()
                      THEN NOW() + ($2::int * INTERVAL '1 millisecond')
                      ELSE mx_rate_limits.expires_at END
RETURNING count, expires_at
`;

/**
 * Implementation Plan Stage 3.5: housekeeping so mx_rate_limits doesn't grow
 * forever. Bounded (LIMIT 500) so it can never turn into a long-running
 * statement, and fired on ~1% of checks rather than every one so the common
 * case stays a single INSERT. Never awaited by check() and never throws past
 * its own .catch — a failed cleanup must not affect the caller's rate-limit
 * decision.
 */
export const CLEANUP_SQL = `
DELETE FROM mx_rate_limits
WHERE id IN (
  SELECT id FROM mx_rate_limits
  WHERE expires_at < NOW() - INTERVAL '1 hour'
  LIMIT 500
)
`;
const CLEANUP_PROBABILITY = 0.01;

export type RunQuery = (
  sql: string,
  params: unknown[]
) => Promise<{ rows: Array<{ count: number | string; expires_at: Date | string }> }>;

export interface PostgresRateLimiterOptions {
  /** Injected for tests. Default lazily uses lib/db/pool so importing this file never needs DATABASE_URL. */
  run?: RunQuery;
  /** Give up and ALLOW the request if the database takes longer than this. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 250;
const FAIL_LOG_INTERVAL_MS = 10_000;

const defaultRun: RunQuery = async (sql, params) => {
  const { query } = await import('../../db/pool');
  return query(sql, params);
};

export function createPostgresRateLimiter(options: PostgresRateLimiterOptions = {}): RateLimiter {
  const run = options.run ?? defaultRun;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastFailLog = 0;

  return {
    async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          run(CHECK_SQL, [key, Math.max(1, Math.floor(windowMs))]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`rate limit check timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        const row = result.rows[0];
        const count = Number(row.count);

        // Stage 3.5 opportunistic cleanup: fire-and-forget, never awaited,
        // so it can't add latency to the request that triggered it.
        if (Math.random() < CLEANUP_PROBABILITY) {
          run(CLEANUP_SQL, []).catch((err) => logger.error('rate_limit_cleanup_failed', err));
        }

        return {
          allowed: count <= limit,
          remaining: Math.max(0, limit - count),
          resetAt: new Date(row.expires_at),
        };
      } catch (err) {
        // FAIL OPEN: the limiter must never turn a good request into an error.
        const now = Date.now();
        if (now - lastFailLog >= FAIL_LOG_INTERVAL_MS) {
          lastFailLog = now;
          logger.error('rate_limit_check_failed', err);
        }
        return { allowed: true, remaining: limit, resetAt: new Date(now + windowMs) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
