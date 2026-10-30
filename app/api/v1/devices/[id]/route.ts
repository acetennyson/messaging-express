import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { successResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { e2eeOnly, requireUserId } from '@/lib/e2ee/gate';
import { isUuid } from '@/lib/e2ee/schemas';
import { emitDevicesRemoved } from '@/lib/events/e2ee';

/**
 * DELETE /devices/:id: revoke one of the caller's own devices (any of them may revoke any other, itself included).
 * requireAuth does not pass Next's route params through, so the id is read from the path.
 */
async function handleDELETE(req: NextRequest, context: AuthContext) {
  try {
    const userId = requireUserId(context);
    const id = req.nextUrl.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!isUuid(id)) throw new NotFoundError('Device not found');

    const revokedAt = await transaction(async (client) => {
      // Same lock as registration, so a revoke cannot interleave with a register for this user.
      await client.query('SELECT id FROM mx_users WHERE id = $1 AND project_id = $2 FOR UPDATE', [
        userId,
        context.projectId,
      ]);

      const device = await client.query(
        `UPDATE mx_devices SET revoked_at = NOW(), is_primary = false
         WHERE id = $1 AND user_id = $2 AND project_id = $3 AND revoked_at IS NULL
         RETURNING revoked_at, (SELECT is_primary FROM mx_devices WHERE id = $1) AS was_primary`,
        [id, userId, context.projectId]
      );
      if (device.rows.length === 0) throw new NotFoundError('Device not found');

      // Approvals this device made for new devices die with it.
      await client.query('DELETE FROM mx_pairing_requests WHERE requesting_device_id = $1', [id]);

      // The primary was revoked: promote the oldest remaining active device (deterministic).
      if (device.rows[0].was_primary) {
        await client.query(
          `UPDATE mx_devices SET is_primary = true
           WHERE id = (SELECT id FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id LIMIT 1)`,
          [userId]
        );
      }
      return device.rows[0].revoked_at;
    });

    emitDevicesRemoved({ projectId: context.projectId, userId, deviceIds: [id] });
    logger.info('e2ee_device_revoked', { projectId: context.projectId, userId, deviceId: id });
    return successResponse({ id, revokedAt });
  } catch (error) {
    return toErrorResponse(error, 'Error revoking device');
  }
}

export const DELETE = withCors(requireAuth(e2eeOnly(handleDELETE)));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
