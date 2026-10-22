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

function formatMessage(level: string, message: string, meta?: any): string {
  const timestamp = new Date().toISOString();
  const logEntry: any = {
    timestamp,
    level,
    message,
  };

  if (meta) {
    // Redact sensitive fields
    const sanitized = { ...meta };
    ['password', 'token', 'apiKey', 'secret'].forEach((field) => {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    });
    logEntry.meta = sanitized;
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
