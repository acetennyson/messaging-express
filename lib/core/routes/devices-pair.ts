import { requireAuth, type AuthContext } from '../../auth/middleware';
import { requireDevice } from '../../auth/device';
import { successResponse } from '../../http';
import { ForbiddenError, RequestValidationError, toErrorResponse } from '../../errors';
import { readJsonBody } from '../../request-body';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import { e2eeOnly } from '../../e2ee/gate';
import { DeviceInvalidError, DeviceLimitError } from '../../e2ee/errors';
import { pairDeviceSchema } from '../../e2ee/schemas';
import { maybeCleanupPairingRequests } from '../../e2ee/pairing';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

/**
 * POST /devices/pair: the PRIMARY device approves one specific new-device public key (decision D10). The approval is bound
 * to that key, not a bearer token, so a leaked QR code is useless to anyone else. Valid for PAIRING_TTL_SECONDS.
 */
async function handlePOST(req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const caller = await requireDevice(ctx, req, context);
    if (!caller.isPrimary) throw new ForbiddenError('Only the primary device can approve a new device');
    const { publicKey } = pairDeviceSchema.parse(await readJsonBody(ctx, req));
    const ttl = ctx.config.pairingTtlSeconds();

    const expiresAt = await db.transaction(async (client) => {
      // Same per-user lock as register / link / revoke.
      await client.query(`SELECT id FROM ${db.t('users')} WHERE id = $1 AND project_id = $2 FOR UPDATE`, [caller.userId, context.projectId]);

      // Re-check under the lock: the caller may have been revoked, or demoted, since requireDevice ran.
      const still = await client.query(
        `SELECT is_primary FROM ${db.t('devices')} WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [caller.id, caller.userId]
      );
      if (still.rows.length === 0) throw new DeviceInvalidError();
      if (!still.rows[0].is_primary) throw new ForbiddenError('Only the primary device can approve a new device');

      const devices = await client.query(
        `SELECT public_key FROM ${db.t('devices')} WHERE user_id = $1 AND revoked_at IS NULL`,
        [caller.userId]
      );
      if (devices.rows.some((d) => d.public_key === publicKey)) {
        throw new RequestValidationError('That public key already belongs to an active device of this user');
      }
      if (devices.rows.length >= ctx.config.maxDevicesPerUser()) throw new DeviceLimitError(ctx.config.maxDevicesPerUser());

      // One live approval per user: drop any other pending one, then upsert this key's.
      await client.query(`DELETE FROM ${db.t('pairing_requests')} WHERE user_id = $1 AND public_key <> $2`, [caller.userId, publicKey]);
      const row = await client.query(
        `INSERT INTO ${db.t('pairing_requests')} (user_id, public_key, requesting_device_id, expires_at, consumed_at)
         VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), NULL)
         ON CONFLICT (user_id, public_key) DO UPDATE
           SET requesting_device_id = EXCLUDED.requesting_device_id, expires_at = EXCLUDED.expires_at, consumed_at = NULL
         RETURNING expires_at`,
        [caller.userId, publicKey, caller.id, ttl]
      );
      return row.rows[0].expires_at as Date;
    });

    maybeCleanupPairingRequests(ctx);
    ctx.logger.info('e2ee_pairing_approved', { projectId: context.projectId, userId: caller.userId, byDeviceId: caller.id });
    return successResponse({ expiresAt });
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error approving device pairing');
  }
}

export const routes: RouteDef[] = [
  route('POST', '/api/v1/devices/pair', withCors(requireAuth(e2eeOnly(handlePOST)))),
  route('OPTIONS', '/api/v1/devices/pair', handleCorsPreflightRequest),
];
