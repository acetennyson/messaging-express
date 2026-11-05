import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { successResponse, createdResponse } from '@/lib/http';
import { RequestValidationError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { createConversationSchema, conversationQuerySchema } from '@/lib/validation/schemas';
import { query, transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { emitEvent } from '@/lib/events/emit';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { getE2eeEnabled, getE2eeKeysMaxBatch } from '@/lib/config/flags';
import { requireDevice } from '@/lib/auth/device';
import { assertFullCoverage, assertWellFormedKeys, insertKeys, lockedActiveDevices } from '@/lib/e2ee/keys';
import { ConversationExistsError } from '@/lib/e2ee/errors';
import { emitKeysUpdated } from '@/lib/events/e2ee';
import { restrictedCaller, violation } from '@/lib/auth/access';
import { getParticipantAccessMode } from '@/lib/config/flags';

async function handleGET(req: NextRequest, context: any) {
  try {
    const { searchParams } = new URL(req.url);
    const queryParams = conversationQuerySchema.parse(Object.fromEntries(searchParams));

    const { limit, offset, type, isArchived } = queryParams;
    let userId = queryParams.userId;

    // Stage 7.12. A user token lists only its own conversations (enforce) or is logged for doing otherwise (dry-run).
    const caller = restrictedCaller(context);
    const accessMode = getParticipantAccessMode();
    if (caller && accessMode !== 'off' && userId !== caller) {
      // Naming another user is refused; naming nobody (the old "list everything") is narrowed to the caller's own list.
      if (userId) violation(accessMode, 'foreign_listing', context, { requestedUserId: userId });
      else if (accessMode === 'dry-run') violation('dry-run', 'foreign_listing', context, { requestedUserId: null });
      if (accessMode === 'enforce') userId = caller;
    }
    // Encrypted conversations are only ever listed to their participants (always, for user tokens); plain rows are untouched.
    const hideForeignEncrypted = !!caller && getE2eeEnabled() === 'on';

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

    if (hideForeignEncrypted) {
      sql += ` AND (c.encryption_mode <> 'e2ee-v1' OR EXISTS (SELECT 1 FROM mx_conversation_participants self WHERE self.conversation_id = c.id AND self.user_id = $${paramIndex}))`;
      params.push(caller);
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

    if (hideForeignEncrypted) {
      countSql += ` AND (c.encryption_mode <> 'e2ee-v1' OR EXISTS (SELECT 1 FROM mx_conversation_participants self WHERE self.conversation_id = c.id AND self.user_id = $${countParams.length + 1}))`;
      countParams.push(caller);
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
    const body = await readJsonBody(req);
    const data = createConversationSchema.parse(body);

    if (new Set(data.participantIds).size !== data.participantIds.length) {
      throw new RequestValidationError('participantIds must be unique');
    }

    // E2EE (Stage 7.4). With the flag off, "e2ee-v1" and `keys` are refused here, before anything else runs, and the
    // INSERT below is the original one, so the plaintext path is unchanged.
    const e2ee = data.encryptionMode === 'e2ee-v1';
    if ((e2ee || data.keys) && getE2eeEnabled() !== 'on') {
      throw new RequestValidationError('End-to-end encryption is not enabled on this server');
    }
    if (data.keys && !e2ee) {
      throw new RequestValidationError('keys is only valid with encryptionMode "e2ee-v1"');
    }
    if (e2ee) {
      const caller = await requireDevice(req, context);
      if (!data.participantIds.includes(caller.userId)) {
        throw new RequestValidationError('The creator must be one of the participantIds of an end-to-end encrypted conversation');
      }
      if (!data.keys || data.keys.length === 0) {
        throw new RequestValidationError('keys is required for an end-to-end encrypted conversation');
      }
      if (data.keys.length > getE2eeKeysMaxBatch()) {
        throw new RequestValidationError(`keys accepts at most ${getE2eeKeysMaxBatch()} entries`);
      }
      assertWellFormedKeys(data.keys, caller.id);
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

      // E2EE: the keys must cover exactly the participants' active devices, checked under a lock that keeps the device
      // set stable until this transaction ends. Any failure rolls back, so no conversation is left without keys.
      let e2eeActiveDevices: { id: string; user_id: string }[] = [];
      if (e2ee) {
        e2eeActiveDevices = await lockedActiveDevices(client, context.projectId, data.participantIds);
        assertFullCoverage(e2eeActiveDevices, data.participantIds, data.keys!);
      }

      // Create conversation
      // 7.10: with a client-chosen id (e2ee only) a duplicate is a 409, never a silent overwrite or a leak of who owns the id.
      let conversationResult;
      if (e2ee && data.id) {
        const inserted = await client.query(
          `INSERT INTO mx_conversations (id, project_id, type, title, metadata, encryption_mode)
           VALUES ($1, $2, $3, $4, $5, 'e2ee-v1')
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [data.id, context.projectId, data.type, data.title, data.metadata || {}]
        );
        if (inserted.rows.length === 0) throw new ConversationExistsError();
        conversationResult = inserted;
      } else conversationResult = e2ee
        ? await client.query(
            `INSERT INTO mx_conversations (project_id, type, title, metadata, encryption_mode)
             VALUES ($1, $2, $3, $4, 'e2ee-v1')
             RETURNING *`,
            [context.projectId, data.type, data.title, data.metadata || {}]
          )
        : await client.query(
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

      if (e2ee) {
        await insertKeys(client, conversation.id, 1, data.keys!);
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
    if (e2ee) {
      // Tell every target device's user that keys exist for the new conversation (best effort; they can also just fetch).
      emitKeysUpdated({ projectId: context.projectId, conversationId: result.id, keyVersion: 1, deviceIds: data.keys!.map((k) => k.deviceId) });
    }

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
