import { NextRequest } from 'next/server';
import { extractBearerToken, verifyToken, JWTPayload } from './jwt';
import { query } from '../db/pool';

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
     FROM projects p
     JOIN organizations o ON p.organization_id = o.id
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
      return await handler(req, context);
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
