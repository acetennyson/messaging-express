import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { successResponse, createdResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { query, transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { e2eeOnly, requireUserId } from '@/lib/e2ee/gate';
import { DeviceExistsError } from '@/lib/e2ee/errors';
import { listDevicesQuerySchema, registerDeviceSchema } from '@/lib/e2ee/schemas';

/** POST /devices: register the user's FIRST device (it becomes the primary). Further devices are added by linking. */
async function handlePOST(req: NextRequest, context: AuthContext) {
  try {
    const userId = requireUserId(context);
    const data = registerDeviceSchema.parse(await readJsonBody(req));

    const device = await transaction(async (client) => {
      // Serialise registrations for this user: two concurrent first-device calls must yield exactly one primary.
      const user = await client.query('SELECT id FROM mx_users WHERE id = $1 AND project_id = $2 FOR UPDATE', [
        userId,
        context.projectId,
      ]);
      if (user.rows.length === 0) throw new NotFoundError('User not found');

      const existing = await client.query(
        'SELECT 1 FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1',
        [userId]
      );
      if (existing.rows.length > 0) throw new DeviceExistsError();

      const inserted = await client.query(
        `INSERT INTO mx_devices (project_id, user_id, public_key, device_name, is_primary)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, is_primary, created_at`,
        [context.projectId, userId, data.publicKey, data.deviceName ?? null]
      );
      return inserted.rows[0];
    });

    logger.info('e2ee_device_registered', { projectId: context.projectId, userId, deviceId: device.id });
    return createdResponse({ id: device.id, isPrimary: device.is_primary, createdAt: device.created_at });
  } catch (error) {
    return toErrorResponse(error, 'Error registering device');
  }
}

/** GET /devices?userIds=a,b: active devices (public keys) of users in the caller's project. */
async function handleGET(req: NextRequest, context: AuthContext) {
  try {
    requireUserId(context);
    const { userIds } = listDevicesQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));

    const result = await query(
      `SELECT id, user_id, public_key, is_primary, device_name
       FROM mx_devices
       WHERE project_id = $1 AND user_id = ANY($2::uuid[]) AND revoked_at IS NULL
       ORDER BY created_at, id`,
      [context.projectId, userIds]
    );

    return successResponse(
      result.rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        publicKey: r.public_key,
        isPrimary: r.is_primary,
        deviceName: r.device_name,
      }))
    );
  } catch (error) {
    return toErrorResponse(error, 'Error listing devices');
  }
}

export const GET = withCors(requireAuth(e2eeOnly(handleGET)));
export const POST = withCors(requireAuth(e2eeOnly(handlePOST)));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
