import { logger } from '../logger';

/**
 * Request-time feature flags (Implementation Plan, Stage P.2).
 *
 * RULE: flags are read from `process.env` on EVERY call. Never do
 *   const MODE = process.env.RATE_LIMIT_MODE;   // module scope: frozen at boot
 * because then rolling a flag back needs a restart instead of an env change.
 * Call `getEnumFlag(...)` (or a typed wrapper below) where the value is used.
 *
 * Unset, empty, or unrecognized values return `fallback` (the safe/old behavior)
 * and never throw, so a typo in an env var cannot take a request path down.
 * An unrecognized value is logged once per (name, value) per process.
 */

const warned = new Set<string>();

export function getEnumFlag<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;

  if ((allowed as readonly string[]).includes(value)) return value as T;

  const memo = `${name}=${value}`;
  if (!warned.has(memo)) {
    warned.add(memo);
    logger.warn('invalid_flag_value', {
      flag: name,
      value,
      allowed: [...allowed],
      using: fallback,
    });
  }
  return fallback;
}

/** Test helper: forget which invalid values were already warned about. */
export function resetFlagWarnings(): void {
  warned.clear();
}

// Typed wrappers are added by the stage that introduces each flag
// (3.2 getRateLimitMode, 4.1 getWebhookDispatch, ...). P.2 ships only the generic reader.

const RATE_LIMIT_MODES = ['off', 'dry-run', 'enforce'] as const;
export type RateLimitMode = (typeof RATE_LIMIT_MODES)[number];

/** Implementation Plan Stage 3.2. Default `off`: no query, no row written, no behavior change. */
export function getRateLimitMode(): RateLimitMode {
  return getEnumFlag('RATE_LIMIT_MODE', RATE_LIMIT_MODES, 'off');
}

const WEBHOOK_DISPATCH_VALUES = ['off', 'on'] as const;
export type WebhookDispatch = (typeof WEBHOOK_DISPATCH_VALUES)[number];

/** Implementation Plan Stage 4.1. Default `off`: emitEvent() skips sendWebhook() entirely. */
export function getWebhookDispatch(): WebhookDispatch {
  return getEnumFlag('WEBHOOK_DISPATCH', WEBHOOK_DISPATCH_VALUES, 'off');
}

const WEBHOOK_RETRY_VALUES = ['off', 'on'] as const;
export type WebhookRetry = (typeof WEBHOOK_RETRY_VALUES)[number];

/**
 * Implementation Plan Stage 4.4. Default `off`: sender.ts behaves exactly as before
 * (no retry for non-2xx; a 5-minute next_retry_at on network errors that nothing consumes)
 * and the retry route is a no-op.
 */
export function getWebhookRetry(): WebhookRetry {
  return getEnumFlag('WEBHOOK_RETRY', WEBHOOK_RETRY_VALUES, 'off');
}

const E2EE_VALUES = ['off', 'on'] as const;
export type E2eeEnabled = (typeof E2EE_VALUES)[number];

/**
 * E2EE Stage 7.1. Default `off`: every E2EE route answers 404 as if it did not exist, and the existing routes
 * (messages, conversations, uploads) run exactly their pre-E2EE code. Read per request, never cached.
 */
export function getE2eeEnabled(): E2eeEnabled {
  return getEnumFlag('E2EE_ENABLED', E2EE_VALUES, 'off');
}

/**
 * Bounded integer flag. Unset, empty, non-numeric or out-of-range values fall back (warned once), never throw.
 * Read per call like every other flag.
 */
function getBoundedIntFlag(name: string, min: number, max: number, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  const memo = `${name}=${raw.trim()}`;
  if (!warned.has(memo)) {
    warned.add(memo);
    logger.warn('invalid_flag_value', { flag: name, value: raw.trim(), allowed: `an integer from ${min} to ${max}`, using: fallback });
  }
  return fallback;
}

/** E2EE Stage 7.3: most active devices one user may have (primary included). Integer 1..50, default 10. */
export function getMaxDevicesPerUser(): number {
  return getBoundedIntFlag('MAX_DEVICES_PER_USER', 1, 50, 10);
}

/** E2EE Stage 7.4: most wrapped-key entries accepted in one request (create-with-keys, key upload). 1..1000, default 200. */
export function getE2eeKeysMaxBatch(): number {
  return getBoundedIntFlag('E2EE_KEYS_MAX_BATCH', 1, 1000, 200);
}

/** E2EE Stage 7.3: how long (seconds) a primary device's approval of a new device stays valid. 30..300, default 60. */
export function getPairingTtlSeconds(): number {
  return getBoundedIntFlag('PAIRING_TTL_SECONDS', 30, 300, 60);
}

/**
 * Track H4: how long (seconds) a successful project/organization lookup may be reused instead of querying
 * Postgres on every request. Read on every call, like the flags above, so it can be changed with an env change.
 * Unset, empty, non-numeric, negative or fractional-below-1 values mean 0 = cache disabled (the old behaviour).
 * Capped at MAX_PROJECT_CACHE_TTL_SECONDS: a deactivated project must not keep working for long.
 */
export const MAX_PROJECT_CACHE_TTL_SECONDS = 3600;

export function getProjectCacheTtlSeconds(): number {
  const raw = process.env.PROJECT_CACHE_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') return 0;

  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 1) {
    const memo = `PROJECT_CACHE_TTL_SECONDS=${raw.trim()}`;
    if (!warned.has(memo)) {
      warned.add(memo);
      logger.warn('invalid_flag_value', {
        flag: 'PROJECT_CACHE_TTL_SECONDS',
        value: raw.trim(),
        allowed: `a number from 1 to ${MAX_PROJECT_CACHE_TTL_SECONDS}`,
        using: 0,
      });
    }
    return 0;
  }
  return Math.min(Math.floor(n), MAX_PROJECT_CACHE_TTL_SECONDS);
}
