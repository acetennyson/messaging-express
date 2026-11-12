import type { Db } from './db';
import type { RateLimiter } from '../rate-limit/types';

export interface ProjectCacheEntry {
  project: Record<string, unknown>;
  expiresAt: number;
}

/**
 * Everything the core needs from its surroundings. Passed explicitly; the core reads no environment
 * variables and holds no module-level singletons (enforced in M1 by lint + the empty-env test).
 */
export interface ServerContext {
  db: Db;
  /** Per-instance cache for lib/auth/project (was a module-level Map: two instances would have shared it). */
  projectCache: Map<string, ProjectCacheEntry>;
  /** Per-instance limiter (was a module-level singleton). */
  rateLimiter: RateLimiter;
}
