import { ForbiddenError, NotFoundError } from '../errors';
import type { Queryable } from '../e2ee/keys';

export interface LockedConversation {
  id: string;
  encryption_mode: string;
  min_key_version: number;
}

/**
 * Take the conversation row FOR UPDATE and authorize the caller. This is the SAME lock the key-upload route takes, so a
 * membership change and a key rotation can never interleave (the rotation's "exactly the active devices of the current
 * participants" check always sees a settled participant set).
 *
 * `callerUserId` is set for end-user tokens, which must be participants (403); admin/api tokens pass undefined.
 * 404 for an unknown conversation or one of another project.
 */
export async function lockConversationForMembership(
  client: Queryable,
  conversationId: string,
  projectId: string,
  callerUserId?: string
): Promise<LockedConversation> {
  const r = await client.query(
    `SELECT c.id, c.encryption_mode, c.min_key_version,
            EXISTS (SELECT 1 FROM mx_conversation_participants p WHERE p.conversation_id = c.id AND p.user_id = $3::uuid) AS is_member
     FROM mx_conversations c
     WHERE c.id = $1 AND c.project_id = $2
     FOR UPDATE OF c`,
    [conversationId, projectId, callerUserId ?? null]
  );
  if (r.rows.length === 0) throw new NotFoundError('Conversation not found');
  if (callerUserId && !r.rows[0].is_member) throw new ForbiddenError('You are not a participant of this conversation');
  return r.rows[0];
}
