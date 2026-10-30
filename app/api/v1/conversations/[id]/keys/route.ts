import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { requireDevice } from '@/lib/auth/device';
import { successResponse, createdResponse } from '@/lib/http';
import { NotFoundError, RequestValidationError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { query, transaction } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { getE2eeKeysMaxBatch } from '@/lib/config/flags';
import { e2eeOnly } from '@/lib/e2ee/gate';
import { KeyExistsError } from '@/lib/e2ee/errors';
import { isUuid, uploadKeysSchema } from '@/lib/e2ee/schemas';
import { emitKeysUpdated } from '@/lib/events/e2ee';
import { assertFullCoverage, assertWellFormedKeys, insertKeys, loadE2eeConversationForMember, lockedActiveDevices } from '@/lib/e2ee/keys';

/** /api/v1/conversations/:id/keys. requireAuth does not pass route params through, so the id is read from the path. */
function conversationIdFrom(req: NextRequest): string {
  const m = req.nextUrl.pathname.match(/\/conversations\/([^/]+)\/keys\/?$/);
  if (!m || !isUuid(m[1])) throw new NotFoundError('Conversation not found');
  return m[1];
}

/** GET: every wrapped key addressed to the CALLING device (all versions), with the wrapper's public key. */
async function handleGET(req: NextRequest, context: AuthContext) {
  try {
    const conversationId = conversationIdFrom(req);
    const device = await requireDevice(req, context);
    await loadE2eeConversationForMember({ query }, conversationId, context.projectId, device.userId);

    const r = await query(
      `SELECT k.key_version, k.wrapped_key, k.wrapped_by_device_id, w.public_key AS wrapped_by_public_key
       FROM mx_conversation_keys k
       LEFT JOIN mx_devices w ON w.id = k.wrapped_by_device_id
       WHERE k.conversation_id = $1 AND k.device_id = $2
       ORDER BY k.key_version`,
      [conversationId, device.id]
    );
    return successResponse(
      r.rows.map((x) => ({
        keyVersion: x.key_version,
        wrappedKey: x.wrapped_key,
        wrappedByDeviceId: x.wrapped_by_device_id,
        wrappedByPublicKey: x.wrapped_by_public_key,
      }))
    );
  } catch (error) {
    return toErrorResponse(error, 'Error fetching conversation keys');
  }
}

/**
 * POST: upload wrapped keys for one key version.
 *  - A NEW version (latest + 1, i.e. a rotation) must cover exactly the active devices of the current participants, so a
 *    version is always one complete, consistent set. Two members rotating at once: the conversation row is locked, the
 *    first wins, and the second finds every row already present (409 KEY_EXISTS) and should adopt the winner's key.
 *  - An EXISTING version (latest or older) adds wraps for devices that lack it (a new device joined). Targets must be
 *    active devices of current participants, so a removed member's devices can never be included.
 * First writer wins per (conversation, device, version).
 */
async function handlePOST(req: NextRequest, context: AuthContext) {
  try {
    const conversationId = conversationIdFrom(req);
    const device = await requireDevice(req, context);
    const data = uploadKeysSchema.parse(await readJsonBody(req));
    if (data.keys.length > getE2eeKeysMaxBatch()) {
      throw new RequestValidationError(`keys accepts at most ${getE2eeKeysMaxBatch()} entries`);
    }
    assertWellFormedKeys(data.keys, device.id);

    const inserted = await transaction(async (client) => {
      await loadE2eeConversationForMember(client, conversationId, context.projectId, device.userId, { lock: true });

      const participants = (
        await client.query('SELECT user_id FROM mx_conversation_participants WHERE conversation_id = $1', [conversationId])
      ).rows.map((r) => r.user_id as string);
      const active = await lockedActiveDevices(client, context.projectId, participants);

      const latest = (
        await client.query('SELECT COALESCE(MAX(key_version), 0) AS v FROM mx_conversation_keys WHERE conversation_id = $1', [conversationId])
      ).rows[0].v as number;

      if (data.keyVersion > latest + 1) {
        throw new RequestValidationError(`keyVersion must be at most ${latest + 1} (the latest version is ${latest})`);
      }
      if (data.keyVersion === latest + 1) {
        assertFullCoverage(active, participants, data.keys);
      } else {
        const valid = new Set(active.map((d) => d.id));
        const invalid = data.keys.filter((k) => !valid.has(k.deviceId)).map((k) => k.deviceId);
        if (invalid.length > 0) {
          throw new RequestValidationError('Some target devices are not active devices of current participants');
        }
      }

      const n = await insertKeys(client, conversationId, data.keyVersion, data.keys);
      if (n === 0) throw new KeyExistsError();
      return n;
    });

    emitKeysUpdated({ projectId: context.projectId, conversationId, keyVersion: data.keyVersion, deviceIds: data.keys.map((k) => k.deviceId) });
    logger.info('e2ee_keys_uploaded', { projectId: context.projectId, conversationId, keyVersion: data.keyVersion, count: inserted });
    return createdResponse({ inserted });
  } catch (error) {
    return toErrorResponse(error, 'Error uploading conversation keys');
  }
}

export const GET = withCors(requireAuth(e2eeOnly(handleGET)));
export const POST = withCors(requireAuth(e2eeOnly(handlePOST)));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
