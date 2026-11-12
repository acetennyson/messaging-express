import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { successResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { e2eeOnly, requireUserId } from '@/lib/e2ee/gate';
import { isUuid } from '@/lib/e2ee/schemas';
import { loadE2eeConversationForMember } from '@/lib/e2ee/keys';
import type { ServerContext } from '@/lib/core/context';
import { hosted } from '@/lib/hosted/next';

/**
 * GET /conversations/:id/devices (Stage 7.11): the active devices of the conversation's CURRENT participants, in one call.
 * Clients need exactly this to answer a key request, wrap keys for a new device, or rotate after a removal; without it they would
 * have to learn the participant list and then list devices, with a race between the two. Participants of an e2ee-v1 conversation only.
 * Same item shape as GET /devices.
 */
async function handleGET(req: NextRequest, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const userId = requireUserId(context);
    const m = req.nextUrl.pathname.match(/\/conversations\/([^/]+)\/devices\/?$/);
    if (!m || !isUuid(m[1])) throw new NotFoundError('Conversation not found');
    await loadE2eeConversationForMember(ctx, db, m[1], context.projectId, userId);

    const result = await db.query(
      `SELECT d.id, d.user_id, d.public_key, d.is_primary, d.device_name
       FROM ${db.t('devices')} d
       JOIN ${db.t('conversation_participants')} p ON p.user_id = d.user_id AND p.conversation_id = $1
       WHERE d.project_id = $2 AND d.revoked_at IS NULL
       ORDER BY d.created_at, d.id`,
      [m[1], context.projectId]
    );
    return successResponse(
      result.rows.map((r) => ({ id: r.id, userId: r.user_id, publicKey: r.public_key, isPrimary: r.is_primary, deviceName: r.device_name }))
    );
  } catch (error) {
    return toErrorResponse(error, 'Error listing conversation devices');
  }
}

export const GET = hosted(withCors(requireAuth(e2eeOnly(handleGET))));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
