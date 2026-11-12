import type { RateLimiter } from './types';
import type { ServerContext } from '../core/context';
import { limitForRequest } from './limits';

export { limitForRequest } from './limits';
export type { RateLimiter, RateLimitResult } from './types';

export interface RateLimitDecision {
  allowed: boolean;
  key: string;
  group: string;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * What requireAuth calls (Stage 3.2). NEVER throws: on any failure the request is allowed.
 * Takes plain values (not a NextRequest) so it is easy to test and has no framework coupling.
 */
export async function checkRateLimit(
  ctx: ServerContext,
  req: { pathname: string; method: string },
  who: { projectId: string; userId?: string },
  rl: RateLimiter = ctx.rateLimiter
): Promise<RateLimitDecision> {
  const resolved = limitForRequest(req.pathname, req.method, who);
  try {
    const r = await rl.check(resolved.key, resolved.limit, resolved.windowMs);
    return {
      allowed: r.allowed,
      key: resolved.key,
      group: resolved.group,
      limit: resolved.limit,
      remaining: r.remaining,
      resetAt: r.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)),
    };
  } catch {
    return {
      allowed: true,
      key: resolved.key,
      group: resolved.group,
      limit: resolved.limit,
      remaining: resolved.limit,
      resetAt: new Date(Date.now() + resolved.windowMs),
      retryAfterSeconds: 1,
    };
  }
}
