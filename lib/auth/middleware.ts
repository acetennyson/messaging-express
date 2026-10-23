import { NextRequest } from 'next/server';
import { extractBearerToken, verifyToken, JWTPayload } from './jwt';
import { query } from '../db/pool';
import { getRateLimitMode } from '../config/flags';
import { checkRateLimit, type RateLimitDecision } from '../rate-limit';
import { tooManyRequestsError } from '../http';
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
    throw new Error('Missing authentication token');
  }

  let payload: JWTPayload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new Error('Invalid or expired token');
  }

  // Verify project exists and is active
  const projectResult = await query(
    `SELECT p.*, o.id as organization_id, o.name as organization_name, o.is_active as org_active
     FROM mx_projects p
     JOIN mx_organizations o ON p.organization_id = o.id
     WHERE p.id = $1 AND p.is_active = true`,
    [payload.projectId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found or inactive');
  }

  const project = projectResult.rows[0];

  if (!project.org_active) {
    throw new Error('Organization inactive');
  }

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
    try {
      const context = await authenticateRequest(req);

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
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          error: {
            message: error.message || 'Authentication failed',
            code: 'UNAUTHORIZED',
          },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  };
}
