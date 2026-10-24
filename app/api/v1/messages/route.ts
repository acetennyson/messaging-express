import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { successResponse, createdResponse } from '@/lib/http';
import { createMessageSchema, messageQuerySchema } from '@/lib/validation/schemas';
import { query, transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { emitEvent } from '@/lib/events/emit';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { NotFoundError, RequestValidationError, toErrorResponse } from '@/lib/errors';

async function handleGET(req: NextRequest, context: any) {
  try {
    const { searchParams } = new URL(req.url);
    const queryParams = messageQuerySchema.parse(Object.fromEntries(searchParams));

    const { conversationId, limit, offset, before, after, type, senderId } = queryParams;

    let sql = `
      SELECT 
        m.*,
        json_build_object(
          'id', u.id,
          'name', u.name,
          'email', u.email,
          'avatarUrl', u.avatar_url
        ) as sender,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', a.id,
              'type', a.type,
              'url', a.url,
              'thumbnailUrl', a.thumbnail_url,
              'filename', a.filename,
              'mimeType', a.mime_type,
              'sizeBytes', a.size_bytes,
              'width', a.width,
              'height', a.height,
              'durationSeconds', a.duration_seconds
            )
          ) FROM mx_message_attachments a WHERE a.message_id = m.id),
          '[]'
        ) as attachments,
        (SELECT COUNT(*) FROM mx_message_reactions WHERE message_id = m.id) as reaction_count
      FROM mx_messages m
      JOIN mx_users u ON m.sender_id = u.id
      JOIN mx_conversations c ON m.conversation_id = c.id
      WHERE c.project_id = $1 
        AND m.conversation_id = $2
        AND m.is_deleted = false
    `;

    const params: any[] = [context.projectId, conversationId];
    let paramIndex = 3;

    if (before) {
      sql += ` AND m.created_at < $${paramIndex}`;
      params.push(before);
      paramIndex++;
    }

    if (after) {
      sql += ` AND m.created_at > $${paramIndex}`;
      params.push(after);
      paramIndex++;
    }

    if (type) {
      sql += ` AND m.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (senderId) {
      sql += ` AND m.sender_id = $${paramIndex}`;
      params.push(senderId);
      paramIndex++;
    }

    sql += ` ORDER BY m.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    return successResponse(result.rows, {
      limit,
      page: Math.floor(offset / limit) + 1,
    });
  } catch (error: any) {
    return toErrorResponse(error, 'Error fetching messages');
  }
}

async function handlePOST(req: NextRequest, context: any) {
  try {
    const body = await req.json();
    const data = createMessageSchema.parse(body);

    const result = await transaction(async (client) => {
      // Verify conversation belongs to project
      const convCheck = await client.query(
        'SELECT id FROM mx_conversations WHERE id = $1 AND project_id = $2',
        [data.conversationId, context.projectId]
      );

      if (convCheck.rows.length === 0) {
        throw new NotFoundError('Conversation not found');
      }

      // Verify sender is a participant
      const participantCheck = await client.query(
        'SELECT id FROM mx_conversation_participants WHERE conversation_id = $1 AND user_id = $2',
        [data.conversationId, data.senderId]
      );

      if (participantCheck.rows.length === 0) {
        throw new RequestValidationError('Sender is not a participant in this conversation');
      }

      // Insert message
      const messageResult = await client.query(
        `INSERT INTO mx_messages (conversation_id, sender_id, content, type, parent_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          data.conversationId,
          data.senderId,
          data.content,
          data.type,
          data.parentId || null,
          data.metadata || {},
        ]
      );

      const message = messageResult.rows[0];

      // Insert attachments if any
      if (data.attachments && data.attachments.length > 0) {
        for (const attachment of data.attachments) {
          await client.query(
            `INSERT INTO mx_message_attachments (
              message_id, type, url, thumbnail_url, filename, mime_type, 
              size_bytes, width, height, duration_seconds, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              message.id,
              attachment.type,
              attachment.url,
              attachment.thumbnailUrl || null,
              attachment.filename || null,
              attachment.mimeType || null,
              attachment.sizeBytes || null,
              attachment.width || null,
              attachment.height || null,
              attachment.durationSeconds || null,
              attachment.metadata || {},
            ]
          );
        }
      }

      // Update conversation last_message_at
      await client.query(
        'UPDATE mx_conversations SET last_message_at = NOW() WHERE id = $1',
        [data.conversationId]
      );

      // Update unread counts for other participants
      await client.query(
        `UPDATE mx_conversation_participants 
         SET unread_count = unread_count + 1
         WHERE conversation_id = $1 AND user_id != $2`,
        [data.conversationId, data.senderId]
      );

      // Fetch full message with sender and attachments
      const fullMessage = await client.query(
        `SELECT 
           m.*,
           json_build_object(
             'id', u.id,
             'name', u.name,
             'email', u.email,
             'avatarUrl', u.avatar_url
           ) as sender,
           COALESCE(
             (SELECT json_agg(
               json_build_object(
                 'id', a.id,
                 'type', a.type,
                 'url', a.url,
                 'thumbnailUrl', a.thumbnail_url,
                 'filename', a.filename,
                 'mimeType', a.mime_type,
                 'sizeBytes', a.size_bytes,
                 'width', a.width,
                 'height', a.height,
                 'durationSeconds', a.duration_seconds
               )
             ) FROM mx_message_attachments a WHERE a.message_id = m.id),
             '[]'
           ) as attachments
         FROM mx_messages m
         JOIN mx_users u ON m.sender_id = u.id
         WHERE m.id = $1`,
        [message.id]
      );

      return fullMessage.rows[0];
    });

    logger.info('Message created', { 
      messageId: result.id, 
      conversationId: data.conversationId,
      projectId: context.projectId 
    });

    emitEvent({
      projectId: context.projectId,
      event: 'message.created',
      data: result,
      channel: `conversation:${data.conversationId}`,
    });

    return createdResponse(result);
  } catch (error: any) {
    // Track H3: 404 for a missing conversation, 400 for bad input, 500 (generic) for anything unexpected.
    return toErrorResponse(error, 'Error creating message');
  }
}

export const GET = withCors(requireAuth(handleGET));
export const POST = withCors(requireAuth(handlePOST));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
