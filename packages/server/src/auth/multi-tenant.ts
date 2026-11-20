import { extractBearerToken, verifyToken, type JWTPayload } from './jwt';
import { loadActiveProject } from './project';
import { AuthError } from '../errors';
import type { AuthContext, AuthStrategy } from './strategy';
import type { ServerContext } from '../core/context';

async function fromToken(ctx: ServerContext, token: string): Promise<AuthContext> {
  let payload: JWTPayload;
  try {
    payload = verifyToken(ctx, token);
  } catch {
    throw new AuthError('Invalid or expired token', 'invalid_token');
  }

  // Verify project exists and is active (shared with the realtime handshake, Stage 5.3)
  let project;
  try {
    project = await loadActiveProject(ctx, payload.projectId);
  } catch (error) {
    if (error instanceof AuthError) throw new AuthError(error.message, 'project_inactive');
    throw error; // a database failure is a 500, not a 401 (Track H2)
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
    exp: payload.exp,
  };
}

/** The hosted server's strategy: unchanged behaviour, moved out of middleware.ts. */
export function createMultiTenantAuth(): AuthStrategy {
  return {
    async authenticate(ctx, request) {
      const token = extractBearerToken(request.headers.get('authorization'));
      if (!token) throw new AuthError('Missing authentication token');
      return fromToken(ctx, token);
    },
    authenticateToken: fromToken,
  };
}
