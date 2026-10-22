import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { successResponse, createdResponse, validationError } from '@/lib/http';
import { createUserSchema } from '@/lib/validation/schemas';
import { query } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';

async function handleGET(req: NextRequest, context: any) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    const search = searchParams.get('search');
    const externalId = searchParams.get('externalId');

    let sql = 'SELECT * FROM users WHERE project_id = $1';
    const params: any[] = [context.projectId];
    let paramIndex = 2;

    if (search) {
      sql += ` AND (name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (externalId) {
      sql += ` AND external_id = $${paramIndex}`;
      params.push(externalId);
      paramIndex++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Get total count
    const countResult = await query(
      'SELECT COUNT(*) FROM users WHERE project_id = $1',
      [context.projectId]
    );
    const total = parseInt(countResult.rows[0].count);

    return successResponse(result.rows, {
      limit,
      page: Math.floor(offset / limit) + 1,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    logger.error('Error fetching users', error);
    return validationError(error.message);
  }
}

async function handlePOST(req: NextRequest, context: any) {
  try {
    const body = await req.json();
    const data = createUserSchema.parse(body);

    const result = await query(
      `INSERT INTO users (project_id, external_id, name, email, avatar_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, external_id) 
       DO UPDATE SET 
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         avatar_url = EXCLUDED.avatar_url,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        context.projectId,
        data.externalId || null,
        data.name,
        data.email || null,
        data.avatarUrl || null,
        data.metadata || {},
      ]
    );

    logger.info('User created/updated', { userId: result.rows[0].id, projectId: context.projectId });

    return createdResponse(result.rows[0]);
  } catch (error: any) {
    logger.error('Error creating user', error);
    return validationError(error.message);
  }
}

export const GET = withCors(requireAuth(handleGET));
export const POST = withCors(requireAuth(handlePOST));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
