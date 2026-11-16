import type { Db } from './db';
import type { ServerConfig } from './config';
import type { RateLimiter } from '../rate-limit/types';
import type { StorageService } from '../storage';
import type { RealtimeRegistry } from '../realtime';
import type { Logger } from '../logger';
import type { InflightTracker } from './inflight';

export interface ProjectCacheEntry {
  project: Record<string, unknown>;
  expiresAt: number;
}

/**
 * Everything the core needs from its surroundings. Passed explicitly; the core reads no environment
 * variables and holds no module-level singletons (enforced in M1 by lint + the empty-env test).
 */
export interface ServerContext {
  config: ServerConfig;
  logger: Logger;
  db: Db;
  /** Per-instance cache for lib/auth/project (was a module-level Map: two instances would have shared it). */
  projectCache: Map<string, ProjectCacheEntry>;
  storage: StorageService;
  realtime: RealtimeRegistry;
  /** Per-instance limiter (was a module-level singleton). */
  rateLimiter: RateLimiter;
  /** Work started after a response; tracked so the owner can wait for it on shutdown. */
  inflight: InflightTracker;
  /**
   * Run `work` after the response, keeping it alive and tracked. Never throws; `work` must handle its own errors.
   * Hosted adds Next's after() (serverless keep-alive); embedded just runs it detached.
   */
  defer(work: () => Promise<unknown>): void;
}
