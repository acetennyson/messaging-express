import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { successResponse, createdResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { ParticipantHasNoDeviceError } from '@/lib/e2ee/errors';
import { isUuid } from '@/lib/e2ee/schemas';
import { lockedActiveDevices } from '@/lib/e2ee/keys';
import { lockConversationForMembership } from '@/lib/conversations/participants';
import { emitParticipantChange } from '@/lib/events/e2ee';

const addParticipantSchema = z.object({ userId: z.string().uuid() }).strict();

/**
 * POST /conversations/:id/participants   { userId }
 * Caller: an existing participant, or an admin/api token. The user must belong to the same project. Idempotent:
 * 201 when added, 200 when already a participant. In an e2ee conversation the new member must already have an active
 * device (otherwise every later key rotation would be blocked), else 409 PARTICIPANT_HAS_NO_DEVICE. The new member
 * can read nothing until a member uploads wraps of the current key for the new member's devices (POST .../keys).
 */
async function handlePOST(req: NextRequest, context: AuthContext) {
  try {
    const m = req.nextUrl.pathname.match(/\/conversations\/([^/]+)\/participants\/?$/);
    if (!m || !isUuid(m[1])) throw new NotFoundError('Conversation not found');
    const conversationId = m[1];
    const { userId } = addParticipantSchema.parse(await readJsonBody(req));

    const result = await transaction(async (client) => {
      const conv = await lockConversationForMembership(client, conversationId, context.projectId, context.userId);

      const target = await client.query('SELECT id FROM mx_users WHERE id = $1 AND project_id = $2', [userId, context.projectId]);
      if (target.rows.length === 0) throw new NotFoundError('User not found');

      const existing = await client.query('SELECT 1 FROM mx_conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
      if (existing.rows.length > 0) return { created: false, e2ee: conv.encryption_mode === 'e2ee-v1' };

      if (conv.encryption_mode === 'e2ee-v1') {
        const devices = await lockedActiveDevices(client, context.projectId, [userId]);
        if (devices.length === 0) throw new ParticipantHasNoDeviceError([userId]);
      }
      await client.query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [conversationId, userId]);
      return { created: true, e2ee: conv.encryption_mode === 'e2ee-v1' };
    });

    if (result.created && result.e2ee) {
      emitParticipantChange({ projectId: context.projectId, conversationId, userId, event: 'participant.added' });
    }
    logger.info('conversation_participant_added', { projectId: context.projectId, conversationId, userId, created: result.created });
    const body = { conversationId, userId };
    return result.created ? createdResponse(body) : successResponse(body);
  } catch (error) {
    return toErrorResponse(error, 'Error adding participant');
  }
}

export const POST = withCors(requireAuth(handlePOST));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
