import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { successResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { isUuid } from '@/lib/e2ee/schemas';
import { lockConversationForMembership } from '@/lib/conversations/participants';
import { emitParticipantChange } from '@/lib/events/e2ee';
import { schedule } from '@/lib/events/emit';
import { evictFromChannel } from '@/lib/realtime';
import { conversationChannel } from '@/lib/realtime/channels';

/**
 * DELETE /conversations/:id/participants/:userId
 * Caller: a participant (may remove themselves) or an admin/api token. 404 when the user is not a participant, so a
 * repeated call cannot keep bumping the key version. In an e2ee conversation the SAME transaction raises
 * min_key_version to (highest uploaded key version + 1): from then on messages under the old key are refused
 * (409 KEY_ROTATION_REQUIRED) until a member uploads a new version, and that version can only cover the remaining
 * participants' devices. The removed user's sockets are also taken out of the conversation room.
 */
async function handleDELETE(req: NextRequest, context: AuthContext) {
  try {
    const m = req.nextUrl.pathname.match(/\/conversations\/([^/]+)\/participants\/([^/]+)\/?$/);
    if (!m || !isUuid(m[1])) throw new NotFoundError('Conversation not found');
    if (!isUuid(m[2])) throw new NotFoundError('Participant not found');
    const [conversationId, userId] = [m[1], m[2]];

    const result = await transaction(async (client) => {
      const conv = await lockConversationForMembership(client, conversationId, context.projectId, context.userId);

      const removed = await client.query('DELETE FROM mx_conversation_participants WHERE conversation_id = $1 AND user_id = $2 RETURNING id', [conversationId, userId]);
      if (removed.rows.length === 0) throw new NotFoundError('Participant not found');

      if (conv.encryption_mode !== 'e2ee-v1') return { e2ee: false, minKeyVersion: null as number | null };
      const bumped = await client.query(
        `UPDATE mx_conversations
         SET min_key_version = GREATEST(min_key_version, COALESCE((SELECT MAX(key_version) FROM mx_conversation_keys WHERE conversation_id = $1), 0) + 1)
         WHERE id = $1 RETURNING min_key_version`,
        [conversationId]
      );
      return { e2ee: true, minKeyVersion: bumped.rows[0].min_key_version as number };
    });

    schedule(() => evictFromChannel(conversationChannel(conversationId), userId), 'evict_removed_participant_failed', { projectId: context.projectId, conversationId });
    if (result.e2ee) {
      emitParticipantChange({ projectId: context.projectId, conversationId, userId, event: 'participant.removed', minKeyVersion: result.minKeyVersion });
    }
    logger.info('conversation_participant_removed', { projectId: context.projectId, conversationId, userId, minKeyVersion: result.minKeyVersion });
    return successResponse({ conversationId, userId, minKeyVersion: result.minKeyVersion });
  } catch (error) {
    return toErrorResponse(error, 'Error removing participant');
  }
}

export const DELETE = withCors(requireAuth(handleDELETE));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
