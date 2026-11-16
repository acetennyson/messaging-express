import { createLogger, type LogLevel } from '../logger';

/** The hosted server's logger: level from LOG_LEVEL (default info), read once at load, as before. */
export const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) || 'info' });
