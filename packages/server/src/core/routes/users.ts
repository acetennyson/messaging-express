import { requireAuth } from '../../auth/middleware';
import { successResponse, createdResponse } from '../../http';
import { toErrorResponse } from '../../errors';
import { readJsonBody } from '../../request-body';
import { createUserSchema, userQuerySchema } from '../../validation/schemas';
import { listUsers } from '../users';
import { emitEvent } from '../../events/emit';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

async function handleGET(req: Request, context: any, ctx: ServerContext) {
  try {
    const { searchParams } = new URL(req.url);
    const { limit, offset, search, externalId } = userQuerySchema.parse(Object.fromEntries(searchParams));

    const { rows, total } = await listUsers(ctx, context.projectId, { limit, offset, search, externalId });

    return successResponse(rows, {
      limit,
      page: Math.floor(offset / limit) + 1,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    return toErrorResponse(ctx, error, 'Error fetching users');
  }
}

async function handlePOST(req: Request, context: any, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const body = await readJsonBody(ctx, req);
    const data = createUserSchema.parse(body);

    const result = await db.query(
      `INSERT INTO ${db.t('users')} (project_id, external_id, name, email, avatar_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, external_id) 
       DO UPDATE SET 
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         avatar_url = EXCLUDED.avatar_url,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *, (xmax = 0) AS inserted`,
      [
        context.projectId,
        data.externalId || null,
        data.name,
        data.email || null,
        data.avatarUrl || null,
        data.metadata || {},
      ]
    );

    // POST /users is an upsert. `inserted` (xmax = 0) tells a fresh row from a conflict-update,
    // so webhook consumers get user.created only once. It is stripped from the response.
    const { inserted, ...user } = result.rows[0];

    ctx.logger.info('User created/updated', { userId: user.id, projectId: context.projectId });

    emitEvent(ctx, {
      projectId: context.projectId,
      event: inserted ? 'user.created' : 'user.updated',
      data: user,
    });

    return createdResponse(user);
  } catch (error: any) {
    return toErrorResponse(ctx, error, 'Error creating user');
  }
}

export const routes: RouteDef[] = [
  route('GET', '/api/v1/users', withCors(requireAuth(handleGET))),
  route('POST', '/api/v1/users', withCors(requireAuth(handlePOST))),
  route('OPTIONS', '/api/v1/users', handleCorsPreflightRequest),
];
