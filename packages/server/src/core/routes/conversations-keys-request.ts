import { requireAuth, type AuthContext } from '../../auth/middleware';
import { requireDevice } from '../../auth/device';
import { successResponse } from '../../http';
import { NotFoundError, toErrorResponse } from '../../errors';
import { readJsonBody } from '../../request-body';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import { e2eeOnly } from '../../e2ee/gate';
import { isUuid, keyRequestSchema } from '../../e2ee/schemas';
import { loadE2eeConversationForMember } from '../../e2ee/keys';
import { emitKeysRequested } from '../../events/e2ee';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

/**
 * POST /conversations/:id/keys/request: "my device cannot read this conversation, please send me the key."
 * The server only announces it (keys.requested); whichever member holds the key answers by uploading wraps.
 * Throttled per user by the `conversations/keys/request` rate-limit group.
 */
async function handlePOST(req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const m = new URL(req.url).pathname.match(/\/conversations\/([^/]+)\/keys\/request\/?$/);
    if (!m || !isUuid(m[1])) throw new NotFoundError('Conversation not found');
    const device = await requireDevice(ctx, req, context);
    const body = await readJsonBody(ctx, req).catch(() => ({}));
    const { keyVersion } = keyRequestSchema.parse(body ?? {});
    await loadE2eeConversationForMember(ctx, db, m[1], context.projectId, device.userId);

    emitKeysRequested(ctx, { projectId: context.projectId, conversationId: m[1], requestingUserId: device.userId, requestingDeviceId: device.id, keyVersion });
    ctx.logger.info('e2ee_keys_requested', { projectId: context.projectId, conversationId: m[1], deviceId: device.id, keyVersion });
    return successResponse({ requested: true }, undefined, 202);
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error requesting conversation keys');
  }
}

export const routes: RouteDef[] = [
  route('POST', '/api/v1/conversations/:id/keys/request', withCors(requireAuth(e2eeOnly(handlePOST)))),
  route('OPTIONS', '/api/v1/conversations/:id/keys/request', handleCorsPreflightRequest),
];
