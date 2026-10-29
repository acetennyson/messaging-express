import type { NextRequest } from 'next/server';
import { getE2eeEnabled } from '../config/flags';
import { notFoundError } from '../http';
import { ForbiddenError } from '../errors';
import type { AuthContext } from '../auth/middleware';

/**
 * Wrap an E2EE handler so it answers 404 NOT_FOUND while E2EE_ENABLED=off (Stage 7.1 flag, read per request).
 * Compose INSIDE requireAuth: withCors(requireAuth(e2eeOnly(handler))). With the flag off the handler body never runs
 * and the route behaves as if it did not exist.
 */
export function e2eeOnly<Args extends unknown[]>(
  handler: (req: NextRequest, context: AuthContext, ...rest: Args) => Promise<Response>
) {
  return async (req: NextRequest, context: AuthContext, ...rest: Args): Promise<Response> => {
    if (getE2eeEnabled() !== 'on') return notFoundError();
    return handler(req, context, ...rest);
  };
}

/** Most E2EE routes act on the caller's own devices, so the token must carry a user. */
export function requireUserId(context: AuthContext): string {
  if (!context.userId) {
    throw new ForbiddenError('This endpoint needs a token issued for a specific user');
  }
  return context.userId;
}
