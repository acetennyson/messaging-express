import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { requireDevice } from '@/lib/auth/device';
import { successResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { e2eeOnly } from '@/lib/e2ee/gate';
import { isUuid, keyRequestSchema } from '@/lib/e2ee/schemas';
import { loadE2eeConversationForMember } from '@/lib/e2ee/keys';
import { emitKeysRequested } from '@/lib/events/e2ee';
import type { ServerContext } from '@/lib/core/context';
import { hosted } from '@/lib/hosted/next';

/**
 * POST /conversations/:id/keys/request: "my device cannot read this conversation, please send me the key."
 * The server only announces it (keys.requested); whichever member holds the key answers by uploading wraps.
 * Throttled per user by the `conversations/keys/request` rate-limit group.
 */
async function handlePOST(req: NextRequest, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const m = req.nextUrl.pathname.match(/\/conversations\/([^/]+)\/keys\/request\/?$/);
    if (!m || !isUuid(m[1])) throw new NotFoundError('Conversation not found');
    const device = await requireDevice(ctx, req, context);
    const body = await readJsonBody(req).catch(() => ({}));
    const { keyVersion } = keyRequestSchema.parse(body ?? {});
    await loadE2eeConversationForMember(ctx, db, m[1], context.projectId, device.userId);

    emitKeysRequested(ctx, { projectId: context.projectId, conversationId: m[1], requestingUserId: device.userId, requestingDeviceId: device.id, keyVersion });
    logger.info('e2ee_keys_requested', { projectId: context.projectId, conversationId: m[1], deviceId: device.id, keyVersion });
    return successResponse({ requested: true }, undefined, 202);
  } catch (error) {
    return toErrorResponse(error, 'Error requesting conversation keys');
  }
}

export const POST = hosted(withCors(requireAuth(e2eeOnly(handlePOST))));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
