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
