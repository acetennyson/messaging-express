import { requireAuth, type AuthContext } from '../../auth/middleware';
import { successResponse } from '../../http';
import { NotFoundError, toErrorResponse } from '../../errors';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import { e2eeOnly, requireUserId } from '../../e2ee/gate';
import { isUuid } from '../../e2ee/schemas';
import { emitDevicesRemoved } from '../../events/e2ee';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

/**
 * DELETE /devices/:id: revoke one of the caller's own devices (any of them may revoke any other, itself included).
 * requireAuth does not pass Next's route params through, so the id is read from the path.
 */
async function handleDELETE(req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const userId = requireUserId(context);
    const id = new URL(req.url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!isUuid(id)) throw new NotFoundError('Device not found');

    const revokedAt = await db.transaction(async (client) => {
      // Same lock as registration, so a revoke cannot interleave with a register for this user.
      await client.query(`SELECT id FROM ${db.t('users')} WHERE id = $1 AND project_id = $2 FOR UPDATE`, [
        userId,
        context.projectId,
      ]);

      const device = await client.query(
        `UPDATE ${db.t('devices')} SET revoked_at = NOW(), is_primary = false
         WHERE id = $1 AND user_id = $2 AND project_id = $3 AND revoked_at IS NULL
         RETURNING revoked_at, (SELECT is_primary FROM ${db.t('devices')} WHERE id = $1) AS was_primary`,
        [id, userId, context.projectId]
      );
      if (device.rows.length === 0) throw new NotFoundError('Device not found');

      // Approvals this device made for new devices die with it.
      await client.query(`DELETE FROM ${db.t('pairing_requests')} WHERE requesting_device_id = $1`, [id]);

      // The primary was revoked: promote the oldest remaining active device (deterministic).
      if (device.rows[0].was_primary) {
        await client.query(
          `UPDATE ${db.t('devices')} SET is_primary = true
           WHERE id = (SELECT id FROM ${db.t('devices')} WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id LIMIT 1)`,
          [userId]
        );
      }
      return device.rows[0].revoked_at;
    });

    emitDevicesRemoved(ctx, { projectId: context.projectId, userId, deviceIds: [id] });
    ctx.logger.info('e2ee_device_revoked', { projectId: context.projectId, userId, deviceId: id });
    return successResponse({ id, revokedAt });
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error revoking device');
  }
}

export const routes: RouteDef[] = [
  route('DELETE', '/api/v1/devices/:id', withCors(requireAuth(e2eeOnly(handleDELETE)))),
  route('OPTIONS', '/api/v1/devices/:id', handleCorsPreflightRequest),
];
