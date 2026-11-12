import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { successResponse, createdResponse } from '@/lib/http';
import { toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { createUserSchema, userQuerySchema } from '@/lib/validation/schemas';
import { logger } from '@/lib/logger';
import { listUsers } from '@/lib/core/users';
import { emitEvent } from '@/lib/events/emit';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import type { ServerContext } from '@/lib/core/context';
import { hosted } from '@/lib/hosted/next';

async function handleGET(req: NextRequest, context: any, ctx: ServerContext) {
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
    return toErrorResponse(error, 'Error fetching users');
  }
}

async function handlePOST(req: NextRequest, context: any, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const body = await readJsonBody(req);
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

    logger.info('User created/updated', { userId: user.id, projectId: context.projectId });

    emitEvent(ctx, {
      projectId: context.projectId,
      event: inserted ? 'user.created' : 'user.updated',
      data: user,
    });

    return createdResponse(user);
  } catch (error: any) {
    return toErrorResponse(error, 'Error creating user');
  }
}

export const GET = hosted(withCors(requireAuth(handleGET)));
export const POST = hosted(withCors(requireAuth(handlePOST)));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
