import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { successResponse, createdResponse } from '@/lib/http';
import { RequestValidationError, toErrorResponse } from '@/lib/errors';
import { createConversationSchema, conversationQuerySchema } from '@/lib/validation/schemas';
import { query, transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { emitEvent } from '@/lib/events/emit';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';

async function handleGET(req: NextRequest, context: any) {
  try {
    const { searchParams } = new URL(req.url);
    const queryParams = conversationQuerySchema.parse(Object.fromEntries(searchParams));

    const { limit, offset, type, isArchived, userId } = queryParams;

    let sql = `
      SELECT 
        c.*,
        COUNT(DISTINCT cp.user_id) as participant_count,
        (SELECT COUNT(*) FROM mx_messages m WHERE m.conversation_id = c.id AND m.is_deleted = false) as message_count
      FROM mx_conversations c
      LEFT JOIN mx_conversation_participants cp ON c.id = cp.conversation_id
      WHERE c.project_id = $1
    `;

    const params: any[] = [context.projectId];
    let paramIndex = 2;

    if (type) {
      sql += ` AND c.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (isArchived !== undefined) {
      sql += ` AND c.is_archived = $${paramIndex}`;
      params.push(isArchived);
      paramIndex++;
    }

    if (userId) {
      sql += ` AND EXISTS (SELECT 1 FROM mx_conversation_participants WHERE conversation_id = c.id AND user_id = $${paramIndex})`;
      params.push(userId);
      paramIndex++;
    }

    sql += ` GROUP BY c.id ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM mx_conversations c WHERE c.project_id = $1';
    const countParams: any[] = [context.projectId];
    let countParamIndex = 2;

    if (type) {
      countSql += ` AND c.type = $${countParamIndex}`;
      countParams.push(type);
      countParamIndex++;
    }

    if (isArchived !== undefined) {
      countSql += ` AND c.is_archived = $${countParamIndex}`;
      countParams.push(isArchived);
      countParamIndex++;
    }

    if (userId) {
      countSql += ` AND EXISTS (SELECT 1 FROM mx_conversation_participants WHERE conversation_id = c.id AND user_id = $${countParamIndex})`;
      countParams.push(userId);
    }

    const countResult = await query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count);

    return successResponse(result.rows, {
      limit,
      page: Math.floor(offset / limit) + 1,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    return toErrorResponse(error, 'Error fetching conversations');
  }
}

async function handlePOST(req: NextRequest, context: any) {
  try {
    const body = await req.json();
    const data = createConversationSchema.parse(body);

    if (new Set(data.participantIds).size !== data.participantIds.length) {
      throw new RequestValidationError('participantIds must be unique');
    }

    const result = await transaction(async (client) => {
      // Every participant must be a user of THIS project. Without this check a user id from another tenant
      // (a foreign key alone does not care which project owns it) could be added to this project's conversation.
      const members = await client.query(
        'SELECT id FROM mx_users WHERE project_id = $1 AND id = ANY($2::uuid[])',
        [context.projectId, data.participantIds]
      );
      if (members.rows.length !== data.participantIds.length) {
        throw new RequestValidationError('One or more participantIds are not users of this project');
      }

      // Create conversation
      const conversationResult = await client.query(
        `INSERT INTO mx_conversations (project_id, type, title, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [context.projectId, data.type, data.title, data.metadata || {}]
      );

      const conversation = conversationResult.rows[0];

      // Add participants
      for (const participantId of data.participantIds) {
        await client.query(
          `INSERT INTO mx_conversation_participants (conversation_id, user_id)
           VALUES ($1, $2)`,
          [conversation.id, participantId]
        );
      }

      // Fetch full conversation with participants
      const fullConversation = await client.query(
        `SELECT 
           c.*,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', u.id,
                 'name', u.name,
                 'email', u.email,
                 'avatarUrl', u.avatar_url,
                 'role', cp.role
               )
             ) FILTER (WHERE u.id IS NOT NULL),
             '[]'
           ) as participants
         FROM mx_conversations c
         LEFT JOIN mx_conversation_participants cp ON c.id = cp.conversation_id
         LEFT JOIN mx_users u ON cp.user_id = u.id
         WHERE c.id = $1
         GROUP BY c.id`,
        [conversation.id]
      );

      return fullConversation.rows[0];
    });

    logger.info('Conversation created', { conversationId: result.id, projectId: context.projectId });

    emitEvent({ projectId: context.projectId, event: 'conversation.created', data: result });

    return createdResponse(result);
  } catch (error: any) {
    return toErrorResponse(error, 'Error creating conversation');
  }
}

export const GET = withCors(requireAuth(handleGET));
export const POST = withCors(requireAuth(handlePOST));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
