import type { AuthContext } from './strategy';
import { checkRateLimit, type RateLimitDecision } from '../rate-limit';
import { tooManyRequestsError, unauthorizedError } from '../http';
import { AuthError, toErrorResponse } from '../errors';
import type { ServerContext } from '../core/context';

/**
 * Stage 3.5 (optional): X-RateLimit-* headers so a client can see its own
 * budget. Only ever set when RATE_LIMIT_MODE is not 'off' (default env is
 * unaffected — scripts/smoke.sh's baseline doesn't need re-recording).
 */
function withRateLimitHeaders(response: Response, decision: RateLimitDecision): Response {
  response.headers.set('X-RateLimit-Limit', String(decision.limit));
  response.headers.set('X-RateLimit-Remaining', String(decision.remaining));
  response.headers.set('X-RateLimit-Reset', String(Math.floor(decision.resetAt.getTime() / 1000)));
  return response;
}

export type { AuthContext };

/** Authenticate through the instance's strategy (hosted: multi-tenant JWT; embedded: single-tenant). */
export function authenticateRequest(ctx: ServerContext, request: Request): Promise<AuthContext> {
  return ctx.auth.authenticate(ctx, request);
}

export function requireAuth(handler: (req: Request, context: AuthContext, ctx: ServerContext) => Promise<Response>) {
  return async (req: Request, ctx: ServerContext) => {
    // Track H2: authentication has its own try. Only a failure to authenticate is a 401; a database error while
    // loading the project is a 500 (it is not the caller's credentials that are wrong).
    let context: AuthContext;
    try {
      context = await authenticateRequest(ctx, req);
    } catch (error) {
      if (error instanceof AuthError) {
        return unauthorizedError(error.message);
      }
      return toErrorResponse(ctx, error, 'authentication_failed_unexpectedly');
    }

    // Anything thrown from here on (rate limiting, the handler) is NOT an authentication problem.
    try {
      // Implementation Plan Stage 3.2: mode 'off' (default) takes this branch
      // not at all — no query, no row written, byte-identical to pre-3.2.
      const mode = ctx.config.rateLimitMode();
      let decision: RateLimitDecision | undefined;
      if (mode !== 'off') {
        decision = await checkRateLimit(
          ctx,
          { pathname: new URL(req.url).pathname, method: req.method },
          { projectId: context.projectId, userId: context.userId }
        );
        if (!decision.allowed) {
          if (mode === 'enforce') {
            return withRateLimitHeaders(tooManyRequestsError(decision.retryAfterSeconds), decision);
          }
          ctx.logger.warn('rate_limit_would_block', {
            key: decision.key,
            projectId: context.projectId,
            group: decision.group,
          });
        }
      }

      const response = await handler(req, context, ctx);
      return decision ? withRateLimitHeaders(response, decision) : response;
    } catch (error) {
      return toErrorResponse(ctx, error, 'unhandled_error_in_handler');
    }
  };
}
