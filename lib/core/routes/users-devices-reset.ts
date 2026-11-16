import { requireAuth, type AuthContext } from '../../auth/middleware';
import { successResponse } from '../../http';
import { ForbiddenError, NotFoundError, toErrorResponse } from '../../errors';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import { e2eeOnly } from '../../e2ee/gate';
import { isUuid } from '../../e2ee/schemas';
import { emitDevicesRemoved } from '../../events/e2ee';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

/**
 * POST /users/:userId/devices/reset: revoke ALL of a user's devices (decision D4). For the customer's backend (token type
 * `admin` or `api`), e.g. after its own support flow has re-verified who the user is. An end user's token cannot do this:
 * that is what keeps a stolen user token from wiping devices. Old e2ee history stays unreadable unless the user has a
 * key backup; the user then registers a fresh device with POST /devices.
 */
async function handlePOST(req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    if (context.type !== 'admin' && context.type !== 'api') {
      throw new ForbiddenError('Only an admin or API token can reset a user\'s devices');
    }
    // requireAuth does not pass route params through: the path is /api/v1/users/:userId/devices/reset
    const segments = new URL(req.url).pathname.replace(/\/+$/, '').split('/');
    const userId = segments[segments.length - 3] ?? '';
    if (!isUuid(userId)) throw new NotFoundError('User not found');

    const revokedIds = await db.transaction(async (client) => {
      const user = await client.query(`SELECT id FROM ${db.t('users')} WHERE id = $1 AND project_id = $2 FOR UPDATE`, [userId, context.projectId]);
      if (user.rows.length === 0) throw new NotFoundError('User not found');

      const r = await client.query(
        `UPDATE ${db.t('devices')} SET revoked_at = NOW(), is_primary = false
         WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [userId]
      );
      await client.query(`DELETE FROM ${db.t('pairing_requests')} WHERE user_id = $1`, [userId]);
      return r.rows.map((x) => x.id as string);
    });

    const revoked = revokedIds.length;
    emitDevicesRemoved(ctx, { projectId: context.projectId, userId, deviceIds: revokedIds });
    ctx.logger.warn('e2ee_devices_reset', { projectId: context.projectId, userId, revoked, actorType: context.type });
    return successResponse({ revoked });
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error resetting devices');
  }
}

export const routes: RouteDef[] = [
  route('POST', '/api/v1/users/:userId/devices/reset', withCors(requireAuth(e2eeOnly(handlePOST)))),
  route('OPTIONS', '/api/v1/users/:userId/devices/reset', handleCorsPreflightRequest),
];
