export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Keys whose values must never reach the logs. Matched case-insensitively at ANY depth (an object logged under
 * `meta.body` or `meta.error` is covered too). The E2EE entries (Stage 7.1) are opaque blobs the server stores but
 * must not write to logs: wrapped conversation keys, ciphertext and the key backup.
 */
const SENSITIVE_KEYS = new Set(
  [
    'password',
    'token',
    'apiKey',
    'secret',
    'wrappedKey',
    'wrapped_key',
    'ciphertext',
    'blob',
    'privateKey',
    'private_key',
  ].map((k) => k.toLowerCase())
);

const MAX_REDACT_DEPTH = 6;

function redact(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[Truncated]'; // also makes a cyclic object loggable instead of throwing
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function formatMessage(level: string, message: string, meta?: unknown): string {
  const timestamp = new Date().toISOString();
  const logEntry: Record<string, unknown> = {
    timestamp,
    level,
    message,
  };

  if (meta) {
    logEntry.meta = redact(meta, 0);
  }

  return JSON.stringify(logEntry);
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, error?: unknown, meta?: unknown): void;
}

export interface LoggerOptions {
  /** Minimum level written. An unrecognised level writes nothing (as before). Default 'info'. */
  level?: LogLevel;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const LOG_LEVEL: LogLevel = options.level || 'info';
  const shouldLog = (level: LogLevel): boolean => levels[level] >= levels[LOG_LEVEL];

  return {
  debug: (message: string, meta?: unknown) => {
    if (shouldLog('debug')) {
      console.log(formatMessage('debug', message, meta));
    }
  },

  info: (message: string, meta?: unknown) => {
    if (shouldLog('info')) {
      console.log(formatMessage('info', message, meta));
    }
  },

  warn: (message: string, meta?: unknown) => {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', message, meta));
    }
  },

  error: (message: string, error?: unknown, meta?: unknown) => {
    if (shouldLog('error')) {
      const e = error as { message?: unknown; stack?: unknown; code?: unknown } | null | undefined;
      const errorMeta = {
        ...(meta as object | undefined),
        ...(e && {
          error: {
            message: e.message,
            stack: e.stack,
            ...(e.code ? { code: e.code } : {}),
          },
        }),
      };
      console.error(formatMessage('error', message, errorMeta));
    }
  },
  };
}
