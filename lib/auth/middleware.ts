import { NextRequest } from 'next/server';
import { extractBearerToken, verifyToken, JWTPayload } from './jwt';
import { loadActiveProject } from './project';
import { getRateLimitMode } from '../config/flags';
import { checkRateLimit, type RateLimitDecision } from '../rate-limit';
import { tooManyRequestsError, unauthorizedError } from '../http';
import { AuthError, toErrorResponse } from '../errors';
import { logger } from '../logger';

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

export interface AuthContext {
  projectId: string;
  userId?: string;
  organizationId?: string;
  type: 'api' | 'user' | 'admin';
  project?: any;
  organization?: any;
}

export async function authenticateRequest(
  request: NextRequest
): Promise<AuthContext> {
  const authHeader = request.headers.get('authorization');
  const token = extractBearerToken(authHeader);

  if (!token) {
    throw new AuthError('Missing authentication token');
  }

  let payload: JWTPayload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new AuthError('Invalid or expired token');
  }

  // Verify project exists and is active (shared with the realtime handshake, Stage 5.3)
  const project = await loadActiveProject(payload.projectId);

  return {
    projectId: payload.projectId,
    userId: payload.userId,
    organizationId: project.organization_id,
    type: payload.type,
    project,
    organization: {
      id: project.organization_id,
      name: project.organization_name,
    },
  };
}

export function requireAuth(handler: (req: NextRequest, context: AuthContext) => Promise<Response>) {
  return async (req: NextRequest) => {
    // Track H2: authentication has its own try. Only a failure to authenticate is a 401; a database error while
    // loading the project is a 500 (it is not the caller's credentials that are wrong).
    let context: AuthContext;
    try {
      context = await authenticateRequest(req);
    } catch (error) {
      if (error instanceof AuthError) {
        return unauthorizedError(error.message);
      }
      return toErrorResponse(error, 'authentication_failed_unexpectedly');
    }

    // Anything thrown from here on (rate limiting, the handler) is NOT an authentication problem.
    try {
      // Implementation Plan Stage 3.2: mode 'off' (default) takes this branch
      // not at all — no query, no row written, byte-identical to pre-3.2.
      const mode = getRateLimitMode();
      let decision: RateLimitDecision | undefined;
      if (mode !== 'off') {
        decision = await checkRateLimit(
          { pathname: req.nextUrl.pathname, method: req.method },
          { projectId: context.projectId, userId: context.userId }
        );
        if (!decision.allowed) {
          if (mode === 'enforce') {
            return withRateLimitHeaders(tooManyRequestsError(decision.retryAfterSeconds), decision);
          }
          logger.warn('rate_limit_would_block', {
            key: decision.key,
            projectId: context.projectId,
            group: decision.group,
          });
        }
      }

      const response = await handler(req, context);
      return decision ? withRateLimitHeaders(response, decision) : response;
    } catch (error) {
      return toErrorResponse(error, 'unhandled_error_in_handler');
    }
  };
}
