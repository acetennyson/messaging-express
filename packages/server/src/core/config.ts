import { readUploadConfig, type UploadConfig } from '../storage/config';

/**
 * Typed configuration for the core. The core reads configuration only through `ctx.config`; nothing below the
 * HTTP edge touches `process.env`.
 *
 * `createConfig(read)` takes a reader and returns accessors:
 *   - hosted server:   read = (name) => process.env[name]     (see lib/hosted/context.ts)
 *   - embedded module: read = values derived from init() options
 * Parsing, defaults and "bad value falls back and warns once, never throws" live here, once.
 *
 * Two kinds of value, deliberately kept as they were in the hosted server:
 *   - LIVE: a function, re-read on every call (flags, body limit, cron secret...), so an env change takes effect
 *     without a restart.
 *   - FIXED: a property, captured when the config is created (JWT secret/expiry, CORS origins, the webhook sender's
 *     secret and timeout). Today these are read once at module load.
 */

export type ConfigReader = (name: string) => string | undefined;

export interface ConfigOptions {
  /** Called once per distinct bad value. Defaults to silent. */
  warn?: (event: string, data: Record<string, unknown>) => void;
}

const RATE_LIMIT_MODES = ['off', 'dry-run', 'enforce'] as const;
export type RateLimitMode = (typeof RATE_LIMIT_MODES)[number];
const ON_OFF = ['off', 'on'] as const;
export type WebhookDispatch = (typeof ON_OFF)[number];
export type WebhookRetry = (typeof ON_OFF)[number];
export type E2eeEnabled = (typeof ON_OFF)[number];
const PARTICIPANT_ACCESS_MODES = ['off', 'dry-run', 'enforce'] as const;
export type ParticipantAccessMode = (typeof PARTICIPANT_ACCESS_MODES)[number];

/** Capped so a deactivated project cannot keep working for long. */
export const MAX_PROJECT_CACHE_TTL_SECONDS = 3600;
export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;

/** One rate-limit rule: at most `limit` requests per `windowMs`. */
export interface LimitRule {
  limit: number;
  windowMs: number;
}

function isRule(v: unknown): v is LimitRule {
  if (!v || typeof v !== 'object') return false;
  const { limit, windowMs } = v as Record<string, unknown>;
  return Number.isInteger(limit) && (limit as number) > 0 && Number.isInteger(windowMs) && (windowMs as number) > 0;
}

export interface ServerConfig {
  // ---- LIVE flags
  rateLimitMode(): RateLimitMode;
  participantAccessMode(): ParticipantAccessMode;
  webhookDispatch(): WebhookDispatch;
  webhookRetry(): WebhookRetry;
  e2eeEnabled(): E2eeEnabled;
  /** Most active devices one user may have, primary included. 1..50, default 10. */
  maxDevicesPerUser(): number;
  /** Most wrapped-key entries in one request. 1..1000, default 200. */
  e2eeKeysMaxBatch(): number;
  /** Seconds a primary device's approval of a new device stays valid. 30..300, default 60. */
  pairingTtlSeconds(): number;
  /** Seconds a project lookup may be reused. 0 = cache disabled. */
  projectCacheTtlSeconds(): number;
  maxJsonBodyBytes(): number;
  /** Bearer secret for the internal cron routes; undefined when not configured. */
  cronSecret(): string | undefined;
  /** Upload limits and allowed MIME types (live). */
  uploads(): UploadConfig;
  /** Per-group rate-limit overrides (RATE_LIMITS_JSON). Re-read each call, parsed only when the raw value changes. */
  rateLimitOverrides(): Record<string, LimitRule>;
  /** Retry worker: rows claimed per run (1..100, default 25). */
  webhookRetryBatchSize(): number;
  /** Retry worker: fallback signing secret when a project has none (live read). */
  webhookRetrySecret(): string;

  // ---- FIXED at creation
  jwt: { secret: string; expiration: string };
  corsAllowedOrigins: string;
  /** First-attempt sender: signing fallback secret and request timeout (captured once, as before). */
  webhookSender: { secret: string | undefined; timeoutMs: number };

  /** Tests: forget which bad values were already warned about. */
  resetWarnings(): void;
}

export function createConfig(read: ConfigReader, options: ConfigOptions = {}): ServerConfig {
  const warned = new Set<string>();
  const warnOnce = (memo: string, event: string, data: Record<string, unknown>) => {
    if (warned.has(memo)) return;
    warned.add(memo);
    options.warn?.(event, data);
  };

  function enumFlag<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = raw.trim().toLowerCase();
    if (value === '') return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    warnOnce(`${name}=${value}`, 'invalid_flag_value', { flag: name, value, allowed: [...allowed], using: fallback });
    return fallback;
  }

  function boundedInt(name: string, min: number, max: number, fallback: number): number {
    const raw = read(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw.trim());
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    warnOnce(`${name}=${raw.trim()}`, 'invalid_flag_value', {
      flag: name,
      value: raw.trim(),
      allowed: `an integer from ${min} to ${max}`,
      using: fallback,
    });
    return fallback;
  }

  // Parsed overrides are cached by the raw string (per instance), so an env change still takes effect on the next call.
  let cachedRaw: string | undefined;
  let cachedOverrides: Record<string, LimitRule> = {};
  let warnedRaw: string | undefined;

  const jwtSecret = read('JWT_SECRET');
  if (!jwtSecret) throw new Error('JWT_SECRET environment variable is not set');

  return {
    rateLimitMode: () => enumFlag('RATE_LIMIT_MODE', RATE_LIMIT_MODES, 'off'),
    participantAccessMode: () => enumFlag('PARTICIPANT_ACCESS_MODE', PARTICIPANT_ACCESS_MODES, 'off'),
    webhookDispatch: () => enumFlag('WEBHOOK_DISPATCH', ON_OFF, 'off'),
    webhookRetry: () => enumFlag('WEBHOOK_RETRY', ON_OFF, 'off'),
    e2eeEnabled: () => enumFlag('E2EE_ENABLED', ON_OFF, 'off'),
    maxDevicesPerUser: () => boundedInt('MAX_DEVICES_PER_USER', 1, 50, 10),
    e2eeKeysMaxBatch: () => boundedInt('E2EE_KEYS_MAX_BATCH', 1, 1000, 200),
    pairingTtlSeconds: () => boundedInt('PAIRING_TTL_SECONDS', 30, 300, 60),

    projectCacheTtlSeconds() {
      const raw = read('PROJECT_CACHE_TTL_SECONDS');
      if (raw === undefined || raw.trim() === '') return 0;
      const n = Number(raw.trim());
      if (!Number.isFinite(n) || n < 1) {
        warnOnce(`PROJECT_CACHE_TTL_SECONDS=${raw.trim()}`, 'invalid_flag_value', {
          flag: 'PROJECT_CACHE_TTL_SECONDS',
          value: raw.trim(),
          allowed: `a number from 1 to ${MAX_PROJECT_CACHE_TTL_SECONDS}`,
          using: 0,
        });
        return 0;
      }
      return Math.min(Math.floor(n), MAX_PROJECT_CACHE_TTL_SECONDS);
    },

    maxJsonBodyBytes() {
      const raw = read('MAX_JSON_BODY_BYTES');
      if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_JSON_BODY_BYTES;
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_JSON_BODY_BYTES;
    },

    rateLimitOverrides() {
      const raw = read('RATE_LIMITS_JSON');
      if (raw === cachedRaw) return cachedOverrides;
      cachedRaw = raw;
      cachedOverrides = {};
      if (!raw || !raw.trim()) return cachedOverrides;
      try {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          if (isRule(v)) cachedOverrides[k] = v;
          else if (warnedRaw !== raw) options.warn?.('invalid_rate_limit_override', { rule: k });
        }
      } catch {
        if (warnedRaw !== raw) options.warn?.('invalid_rate_limits_json', {});
      }
      warnedRaw = raw;
      return cachedOverrides;
    },

    uploads: () => readUploadConfig(read),
    cronSecret: () => read('CRON_SECRET'),

    webhookRetryBatchSize() {
      const n = parseInt(read('WEBHOOK_RETRY_BATCH') || '25', 10);
      return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 25;
    },
    webhookRetrySecret: () => read('WEBHOOK_SECRET') || '',

    jwt: { secret: jwtSecret, expiration: read('JWT_EXPIRATION') || '7d' },
    corsAllowedOrigins: read('CORS_ALLOWED_ORIGINS') || '*',
    webhookSender: { secret: read('WEBHOOK_SECRET'), timeoutMs: parseInt(read('WEBHOOK_TIMEOUT_MS') || '5000') },

    resetWarnings: () => warned.clear(),
  };
}
