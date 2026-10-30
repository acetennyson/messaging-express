import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { createdResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { getMaxDevicesPerUser } from '@/lib/config/flags';
import { e2eeOnly, requireUserId } from '@/lib/e2ee/gate';
import { DeviceLimitError, PairingNotFoundError } from '@/lib/e2ee/errors';
import { linkDeviceSchema } from '@/lib/e2ee/schemas';
import { emitDeviceAdded } from '@/lib/events/e2ee';

/**
 * POST /devices/link: the NEW device claims the approval its primary made for its public key. It has no device id yet,
 * so there is no X-Device-Id; the token identifies the user. Consuming the approval, the device-limit check and the
 * insert are ONE transaction: if any step fails, the approval is not used up.
 * The new device polls this route (every ~2 s) until the primary has approved it or the approval window ends.
 */
async function handlePOST(req: NextRequest, context: AuthContext) {
  try {
    const userId = requireUserId(context);
    const data = linkDeviceSchema.parse(await readJsonBody(req));

    const result = await transaction(async (client) => {
      const user = await client.query('SELECT id FROM mx_users WHERE id = $1 AND project_id = $2 FOR UPDATE', [userId, context.projectId]);
      if (user.rows.length === 0) throw new NotFoundError('User not found');

      // Not approved / expired / already used / different key: all the same answer, so it cannot be probed.
      const consumed = await client.query(
        `UPDATE mx_pairing_requests SET consumed_at = NOW()
         WHERE user_id = $1 AND public_key = $2 AND consumed_at IS NULL AND expires_at > NOW()
         RETURNING requesting_device_id`,
        [userId, data.publicKey]
      );
      if (consumed.rows.length === 0) throw new PairingNotFoundError();

      // The approving device must still be active (revoking it deletes its approvals; this guards the race anyway).
      const approver = await client.query(
        'SELECT 1 FROM mx_devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [consumed.rows[0].requesting_device_id, userId]
      );
      if (approver.rows.length === 0) throw new PairingNotFoundError();

      const others = await client.query(
        `SELECT id, user_id, public_key, is_primary, device_name
         FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`,
        [userId]
      );
      const limit = getMaxDevicesPerUser();
      if (others.rows.length >= limit) throw new DeviceLimitError(limit);

      const inserted = await client.query(
        `INSERT INTO mx_devices (project_id, user_id, public_key, device_name, is_primary)
         VALUES ($1, $2, $3, $4, false) RETURNING id`,
        [context.projectId, userId, data.publicKey, data.deviceName ?? null]
      );

      const convs = await client.query(
        `SELECT c.id FROM mx_conversations c
         JOIN mx_conversation_participants p ON p.conversation_id = c.id
         WHERE p.user_id = $1 AND c.project_id = $2 AND c.encryption_mode = 'e2ee-v1'
         ORDER BY c.created_at, c.id`,
        [userId, context.projectId]
      );

      return {
        id: inserted.rows[0].id as string,
        devices: others.rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          publicKey: r.public_key,
          isPrimary: r.is_primary,
          deviceName: r.device_name,
        })),
        conversationIds: convs.rows.map((r) => r.id as string),
      };
    });

    emitDeviceAdded({ projectId: context.projectId, userId, deviceId: result.id, publicKey: data.publicKey });
    logger.info('e2ee_device_linked', { projectId: context.projectId, userId, deviceId: result.id });
    return createdResponse({ id: result.id, isPrimary: false, devices: result.devices, conversationIds: result.conversationIds });
  } catch (error) {
    return toErrorResponse(error, 'Error linking device');
  }
}

export const POST = withCors(requireAuth(e2eeOnly(handlePOST)));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
