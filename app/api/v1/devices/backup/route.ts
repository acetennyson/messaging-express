import { NextRequest } from 'next/server';
import { requireAuth, type AuthContext } from '@/lib/auth/middleware';
import { successResponse } from '@/lib/http';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { readJsonBody } from '@/lib/request-body';
import { query } from '@/lib/db/pool';
import { logger } from '@/lib/logger';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { e2eeOnly, requireUserId } from '@/lib/e2ee/gate';
import { putBackupSchema } from '@/lib/e2ee/schemas';

/**
 * Passphrase-encrypted device-key backup (E2EE Stage 7.8): one opaque blob + the Argon2id parameters per user.
 * Authenticated by the user's JWT only (NOT X-Device-Id): restoring on a new device happens before it has one.
 * The server cannot read the blob; the contents and the passphrase never reach it. The blob is never logged.
 */

/** PUT: create or replace the caller's backup. */
async function handlePUT(req: NextRequest, context: AuthContext) {
  try {
    const userId = requireUserId(context);
    const data = putBackupSchema.parse(await readJsonBody(req));
    const r = await query(
      `INSERT INTO mx_key_backups (user_id, blob, kdf, updated_at)
       SELECT u.id, $2, $3::jsonb, NOW() FROM mx_users u WHERE u.id = $1 AND u.project_id = $4
       ON CONFLICT (user_id) DO UPDATE SET blob = EXCLUDED.blob, kdf = EXCLUDED.kdf, updated_at = NOW()
       RETURNING updated_at`,
      [userId, data.blob, JSON.stringify(data.kdf), context.projectId]
    );
    if (r.rows.length === 0) throw new NotFoundError('User not found');
    logger.info('e2ee_backup_stored', { projectId: context.projectId, userId });
    return successResponse({ updatedAt: r.rows[0].updated_at });
  } catch (error) {
    return toErrorResponse(error, 'Error storing key backup');
  }
}

/** GET: the caller's own backup, or 404. */
async function handleGET(_req: NextRequest, context: AuthContext) {
  try {
    const userId = requireUserId(context);
    const r = await query(
      `SELECT b.blob, b.kdf, b.updated_at FROM mx_key_backups b
       JOIN mx_users u ON u.id = b.user_id
       WHERE b.user_id = $1 AND u.project_id = $2`,
      [userId, context.projectId]
    );
    if (r.rows.length === 0) throw new NotFoundError('No key backup');
    return successResponse({ blob: r.rows[0].blob, kdf: r.rows[0].kdf, updatedAt: r.rows[0].updated_at });
  } catch (error) {
    return toErrorResponse(error, 'Error reading key backup');
  }
}

/** DELETE: remove the caller's backup. Idempotent. */
async function handleDELETE(_req: NextRequest, context: AuthContext) {
  try {
    const userId = requireUserId(context);
    await query(
      `DELETE FROM mx_key_backups WHERE user_id = $1 AND user_id IN (SELECT id FROM mx_users WHERE id = $1 AND project_id = $2)`,
      [userId, context.projectId]
    );
    logger.info('e2ee_backup_deleted', { projectId: context.projectId, userId });
    return successResponse({ deleted: true });
  } catch (error) {
    return toErrorResponse(error, 'Error deleting key backup');
  }
}

export const PUT = withCors(requireAuth(e2eeOnly(handlePUT)));
export const GET = withCors(requireAuth(e2eeOnly(handleGET)));
export const DELETE = withCors(requireAuth(e2eeOnly(handleDELETE)));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
