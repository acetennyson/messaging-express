import type { ServerContext } from '../core/context';

/** Who is calling, and which project they act in. Produced by an AuthStrategy; everything downstream reads only this. */
export interface AuthContext {
  projectId: string;
  userId?: string;
  organizationId?: string;
  type: 'api' | 'user' | 'admin';
  project?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the joined project row, as before
  organization?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Token expiry (seconds since epoch) when the identity came from a JWT; the realtime handshake disconnects then. */
  exp?: number;
}

/**
 * How a request becomes an AuthContext. This is AUTHENTICATION only: the participant-access and E2EE rules run on the
 * resulting AuthContext exactly the same, whichever strategy produced it.
 *
 *  - hosted: multi-tenant JWT (`projectId` in the token, project and organization loaded and checked per request)
 *  - embedded: single-tenant (one project fixed at init; JWT signed with `jwtSecret`, or the customer's `authenticate`)
 *
 * Both methods throw AuthError for "not authenticated" (401) and AuthUnavailableError for "cannot tell" (503).
 */
export interface AuthStrategy {
  /** REST: from the request's Authorization header (or, for a custom strategy, anything on the request). */
  authenticate(ctx: ServerContext, request: Request): Promise<AuthContext>;
  /** Realtime handshake: a bearer JWT only (a socket has no request to hand to a custom authenticate). */
  authenticateToken(ctx: ServerContext, token: string): Promise<AuthContext>;
}
