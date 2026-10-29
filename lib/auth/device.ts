import type { NextRequest } from 'next/server';
import { query } from '../db/pool';
import { DeviceInvalidError, DeviceRequiredError } from '../e2ee/errors';
import { isUuid } from '../e2ee/schemas';
import { requireUserId } from '../e2ee/gate';
import type { AuthContext } from './middleware';

export interface ActiveDevice {
  id: string;
  userId: string;
  isPrimary: boolean;
}

export const DEVICE_HEADER = 'x-device-id';

/**
 * Resolve the calling device from the X-Device-Id header (decision D2). The header IDENTIFIES the device, it does not
 * authenticate it: the user's token does that, and a wrapped key is useless without the device's private key.
 * The device must belong to the token's user in the token's project and must not be revoked.
 */
export async function requireDevice(req: NextRequest, context: AuthContext): Promise<ActiveDevice> {
  const userId = requireUserId(context);
  const header = req.headers.get(DEVICE_HEADER)?.trim();
  if (!header) throw new DeviceRequiredError();
  if (!isUuid(header)) throw new DeviceInvalidError(); // never let a malformed value reach a uuid cast (would be a 500)

  const result = await query<{ id: string; user_id: string; is_primary: boolean }>(
    `SELECT id, user_id, is_primary FROM mx_devices
     WHERE id = $1 AND user_id = $2 AND project_id = $3 AND revoked_at IS NULL`,
    [header, userId, context.projectId]
  );
  if (result.rows.length === 0) throw new DeviceInvalidError();
  const row = result.rows[0];
  return { id: row.id, userId: row.user_id, isPrimary: row.is_primary };
}
