import { createLogger } from '../logger';

/**
 * The logger test contexts use (see testing.ts). Tests spy on it or vi.mock this module to assert what gets logged.
 * Kept separate from the hosted server's logger so the package never reaches outside itself.
 */
export const logger = createLogger({ level: 'info' });
