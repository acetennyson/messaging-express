type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function shouldLog(level: LogLevel): boolean {
  return levels[level] >= levels[LOG_LEVEL];
}

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

function formatMessage(level: string, message: string, meta?: any): string {
  const timestamp = new Date().toISOString();
  const logEntry: any = {
    timestamp,
    level,
    message,
  };

  if (meta) {
    logEntry.meta = redact(meta, 0);
  }

  return JSON.stringify(logEntry);
}

export const logger = {
  debug: (message: string, meta?: any) => {
    if (shouldLog('debug')) {
      console.log(formatMessage('debug', message, meta));
    }
  },

  info: (message: string, meta?: any) => {
    if (shouldLog('info')) {
      console.log(formatMessage('info', message, meta));
    }
  },

  warn: (message: string, meta?: any) => {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', message, meta));
    }
  },

  error: (message: string, error?: Error | any, meta?: any) => {
    if (shouldLog('error')) {
      const errorMeta = {
        ...meta,
        ...(error && {
          error: {
            message: error.message,
            stack: error.stack,
            ...(error.code && { code: error.code }),
          },
        }),
      };
      console.error(formatMessage('error', message, errorMeta));
    }
  },
};
