import { describe, expect, it, vi } from 'vitest';
import { createConfig, DEFAULT_MAX_JSON_BODY_BYTES, MAX_PROJECT_CACHE_TTL_SECONDS } from './config';

type Env = Record<string, string | undefined>;
const make = (env: Env) => {
  const warn = vi.fn();
  const config = createConfig((name) => env[name], { warn });
  return { config, warn };
};
const base = (extra: Env = {}): Env => ({ JWT_SECRET: 'secret-secret-secret-secret', ...extra });

// Ported from the old getEnumFlag tests; RATE_LIMIT_MODE stands in for the generic reader (off | dry-run | enforce).
describe('enum flags', () => {
  it('returns the fallback when unset', () => {
    expect(make(base()).config.rateLimitMode()).toBe('off');
  });

  it('returns the fallback for an empty or whitespace value', () => {
    const env = base({ RATE_LIMIT_MODE: '' });
    const { config } = make(env);
    expect(config.rateLimitMode()).toBe('off');
    env.RATE_LIMIT_MODE = '   ';
    expect(config.rateLimitMode()).toBe('off');
  });

  it('accepts an allowed value, ignoring case and surrounding whitespace', () => {
    expect(make(base({ RATE_LIMIT_MODE: '  Dry-Run ' })).config.rateLimitMode()).toBe('dry-run');
  });

  it('reads the environment on every call (no caching)', () => {
    const env = base({ RATE_LIMIT_MODE: 'dry-run' });
    const { config } = make(env);
    expect(config.rateLimitMode()).toBe('dry-run');
    env.RATE_LIMIT_MODE = 'enforce';
    expect(config.rateLimitMode()).toBe('enforce');
    delete env.RATE_LIMIT_MODE;
    expect(config.rateLimitMode()).toBe('off');
  });

  it('falls back (and does not throw) on an unrecognized value', () => {
    expect(make(base({ RATE_LIMIT_MODE: 'enforcing' })).config.rateLimitMode()).toBe('off');
  });

  it('warns once per distinct invalid value, not on every call', () => {
    const env = base({ RATE_LIMIT_MODE: 'bogus' });
    const { config, warn } = make(env);
    config.rateLimitMode();
    config.rateLimitMode();
    config.rateLimitMode();
    expect(warn).toHaveBeenCalledTimes(1);
    env.RATE_LIMIT_MODE = 'other-bogus';
    config.rateLimitMode();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('resetWarnings lets the same bad value warn again', () => {
    const { config, warn } = make(base({ RATE_LIMIT_MODE: 'bogus' }));
    config.rateLimitMode();
    config.resetWarnings();
    config.rateLimitMode();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('e2eeEnabled', () => {
  it('defaults to off when unset, empty or invalid', () => {
    const env = base();
    const { config } = make(env);
    expect(config.e2eeEnabled()).toBe('off');
    env.E2EE_ENABLED = '';
    expect(config.e2eeEnabled()).toBe('off');
    env.E2EE_ENABLED = 'yes';
    expect(config.e2eeEnabled()).toBe('off');
  });

  it('is on only for the exact value, read on every call', () => {
    const env = base({ E2EE_ENABLED: ' ON ' });
    const { config } = make(env);
    expect(config.e2eeEnabled()).toBe('on');
    env.E2EE_ENABLED = 'off';
    expect(config.e2eeEnabled()).toBe('off');
  });
});

describe('E2EE numeric flags', () => {
  it('use their defaults when unset or empty', () => {
    const env = base();
    const { config } = make(env);
    expect(config.maxDevicesPerUser()).toBe(10);
    expect(config.pairingTtlSeconds()).toBe(60);
    env.MAX_DEVICES_PER_USER = ' ';
    expect(config.maxDevicesPerUser()).toBe(10);
  });

  it('accept values in range, read on every call', () => {
    const env = base();
    const { config } = make(env);
    env.MAX_DEVICES_PER_USER = '3';
    expect(config.maxDevicesPerUser()).toBe(3);
    env.MAX_DEVICES_PER_USER = '50';
    expect(config.maxDevicesPerUser()).toBe(50);
    env.PAIRING_TTL_SECONDS = '30';
    expect(config.pairingTtlSeconds()).toBe(30);
    env.PAIRING_TTL_SECONDS = '300';
    expect(config.pairingTtlSeconds()).toBe(300);
  });

  it('fall back (and warn once) for out-of-range, fractional or non-numeric values', () => {
    const env = base();
    const { config, warn } = make(env);
    for (const v of ['0', '51', '-1', '2.5', 'abc']) {
      env.MAX_DEVICES_PER_USER = v;
      expect(config.maxDevicesPerUser()).toBe(10);
    }
    for (const v of ['29', '301', '60.5']) {
      env.PAIRING_TTL_SECONDS = v;
      expect(config.pairingTtlSeconds()).toBe(60);
    }
    env.PAIRING_TTL_SECONDS = '301';
    config.pairingTtlSeconds();
    expect(warn).toHaveBeenCalledTimes(8); // one per distinct invalid value, not per call
  });
});

describe('other live values', () => {
  it('projectCacheTtlSeconds: 0 when unset/invalid, floored, capped', () => {
    const env = base();
    const { config } = make(env);
    expect(config.projectCacheTtlSeconds()).toBe(0);
    env.PROJECT_CACHE_TTL_SECONDS = '0.5';
    expect(config.projectCacheTtlSeconds()).toBe(0);
    env.PROJECT_CACHE_TTL_SECONDS = '30.9';
    expect(config.projectCacheTtlSeconds()).toBe(30);
    env.PROJECT_CACHE_TTL_SECONDS = '999999';
    expect(config.projectCacheTtlSeconds()).toBe(MAX_PROJECT_CACHE_TTL_SECONDS);
  });

  it('maxJsonBodyBytes: default unless a positive whole number', () => {
    const env = base();
    const { config } = make(env);
    expect(config.maxJsonBodyBytes()).toBe(DEFAULT_MAX_JSON_BODY_BYTES);
    for (const v of ['0', '-5', '1.5', 'abc']) {
      env.MAX_JSON_BODY_BYTES = v;
      expect(config.maxJsonBodyBytes()).toBe(DEFAULT_MAX_JSON_BODY_BYTES);
    }
    env.MAX_JSON_BODY_BYTES = '1024';
    expect(config.maxJsonBodyBytes()).toBe(1024);
  });

  it('webhookRetryBatchSize clamps to 1..100 and defaults to 25', () => {
    const env = base();
    const { config } = make(env);
    expect(config.webhookRetryBatchSize()).toBe(25);
    env.WEBHOOK_RETRY_BATCH = '9999';
    expect(config.webhookRetryBatchSize()).toBe(100);
    env.WEBHOOK_RETRY_BATCH = '0';
    expect(config.webhookRetryBatchSize()).toBe(1);
    env.WEBHOOK_RETRY_BATCH = 'x';
    expect(config.webhookRetryBatchSize()).toBe(25);
  });

  it('cronSecret and webhookRetrySecret are read live', () => {
    const env = base();
    const { config } = make(env);
    expect(config.cronSecret()).toBeUndefined();
    expect(config.webhookRetrySecret()).toBe('');
    env.CRON_SECRET = 'c';
    env.WEBHOOK_SECRET = 'w';
    expect(config.cronSecret()).toBe('c');
    expect(config.webhookRetrySecret()).toBe('w');
  });
});

describe('fixed values (captured at creation, as module-level reads were)', () => {
  it('throws when JWT_SECRET is missing, with the same message as before', () => {
    expect(() => createConfig(() => undefined)).toThrow('JWT_SECRET environment variable is not set');
  });

  it('captures jwt, cors and the webhook sender settings once', () => {
    const env = base({ JWT_EXPIRATION: '1h', CORS_ALLOWED_ORIGINS: 'https://a.com', WEBHOOK_SECRET: 's', WEBHOOK_TIMEOUT_MS: '1234' });
    const { config } = make(env);
    env.JWT_SECRET = 'changed';
    env.CORS_ALLOWED_ORIGINS = 'https://b.com';
    env.WEBHOOK_TIMEOUT_MS = '9';
    expect(config.jwt).toEqual({ secret: 'secret-secret-secret-secret', expiration: '1h' });
    expect(config.corsAllowedOrigins).toBe('https://a.com');
    expect(config.webhookSender).toEqual({ secret: 's', timeoutMs: 1234 });
  });

  it('applies the documented defaults', () => {
    const { config } = make(base());
    expect(config.jwt.expiration).toBe('7d');
    expect(config.corsAllowedOrigins).toBe('*');
    expect(config.webhookSender).toEqual({ secret: undefined, timeoutMs: 5000 });
  });
});
