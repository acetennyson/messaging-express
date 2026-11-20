import { requireAuth, type AuthContext } from '../../auth/middleware';
import { successResponse } from '../../http';
import { NotFoundError, toErrorResponse } from '../../errors';
import { readJsonBody } from '../../request-body';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import { e2eeOnly, requireUserId } from '../../e2ee/gate';
import { putBackupSchema } from '../../e2ee/schemas';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

/**
 * Passphrase-encrypted device-key backup (E2EE Stage 7.8): one opaque blob + the Argon2id parameters per user.
 * Authenticated by the user's JWT only (NOT X-Device-Id): restoring on a new device happens before it has one.
 * The server cannot read the blob; the contents and the passphrase never reach it. The blob is never logged.
 */

/** PUT: create or replace the caller's backup. */
async function handlePUT(req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const userId = requireUserId(context);
    const data = putBackupSchema.parse(await readJsonBody(ctx, req));
    const r = await db.query(
      `INSERT INTO ${db.t('key_backups')} (user_id, blob, kdf, updated_at)
       SELECT u.id, $2, $3::jsonb, NOW() FROM ${db.t('users')} u WHERE u.id = $1 AND u.project_id = $4
       ON CONFLICT (user_id) DO UPDATE SET blob = EXCLUDED.blob, kdf = EXCLUDED.kdf, updated_at = NOW()
       RETURNING updated_at`,
      [userId, data.blob, JSON.stringify(data.kdf), context.projectId]
    );
    if (r.rows.length === 0) throw new NotFoundError('User not found');
    ctx.logger.info('e2ee_backup_stored', { projectId: context.projectId, userId });
    return successResponse({ updatedAt: r.rows[0].updated_at });
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error storing key backup');
  }
}

/** GET: the caller's own backup, or 404. */
async function handleGET(_req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const userId = requireUserId(context);
    const r = await db.query(
      `SELECT b.blob, b.kdf, b.updated_at FROM ${db.t('key_backups')} b
       JOIN ${db.t('users')} u ON u.id = b.user_id
       WHERE b.user_id = $1 AND u.project_id = $2`,
      [userId, context.projectId]
    );
    if (r.rows.length === 0) throw new NotFoundError('No key backup');
    return successResponse({ blob: r.rows[0].blob, kdf: r.rows[0].kdf, updatedAt: r.rows[0].updated_at });
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error reading key backup');
  }
}

/** DELETE: remove the caller's backup. Idempotent. */
async function handleDELETE(_req: Request, context: AuthContext, ctx: ServerContext) {
  const db = ctx.db;
  try {
    const userId = requireUserId(context);
    await db.query(
      `DELETE FROM ${db.t('key_backups')} WHERE user_id = $1 AND user_id IN (SELECT id FROM ${db.t('users')} WHERE id = $1 AND project_id = $2)`,
      [userId, context.projectId]
    );
    ctx.logger.info('e2ee_backup_deleted', { projectId: context.projectId, userId });
    return successResponse({ deleted: true });
  } catch (error) {
    return toErrorResponse(ctx, error, 'Error deleting key backup');
  }
}

export const routes: RouteDef[] = [
  route('PUT', '/api/v1/devices/backup', withCors(requireAuth(e2eeOnly(handlePUT)))),
  route('GET', '/api/v1/devices/backup', withCors(requireAuth(e2eeOnly(handleGET)))),
  route('DELETE', '/api/v1/devices/backup', withCors(requireAuth(e2eeOnly(handleDELETE)))),
  route('OPTIONS', '/api/v1/devices/backup', handleCorsPreflightRequest),
];
