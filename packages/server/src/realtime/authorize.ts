import type { ServerContext } from '../core/context';
import type { Audience } from './audience';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * May `userId` subscribe to events of `conversationId`? The single rule behind both the built-in `join-conversation` and
 * `chat.authorizeJoin` for custom transports: the conversation belongs to THIS project and the user is a participant right
 * now. "Not found", "not a participant" and "removed" all answer false identically, so ids cannot be probed.
 */
export async function authorizeJoin(ctx: ServerContext, projectId: string, userId: string, conversationId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(conversationId)) return false;
  const db = ctx.db;
  const result = await db.query(
    `SELECT 1
     FROM ${db.t('conversation_participants')} cp
     JOIN ${db.t('conversations')} c ON c.id = cp.conversation_id
     WHERE cp.conversation_id = $1 AND cp.user_id = $2 AND c.project_id = $3`,
    [conversationId, userId, projectId]
  );
  return result.rows.length > 0;
}

export interface AudiencePage {
  userIds: string[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export const MAX_AUDIENCE_PAGE = 1000;

/** The full recipient list of an audience, a page at a time, only when asked (nothing is materialised per event). */
export async function listAudience(
  ctx: ServerContext,
  projectId: string,
  audience: Audience,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<AudiencePage> {
  const limit = Math.min(MAX_AUDIENCE_PAGE, Math.max(1, Math.floor(options.limit ?? 500)));
  const cursor = options.cursor ?? null;

  if (audience.kind === 'users') {
    const sorted = [...new Set(audience.userIds)].sort();
    const rest = cursor ? sorted.filter((id) => id > cursor) : sorted;
    const page = rest.slice(0, limit);
    return { userIds: page, nextCursor: rest.length > limit ? page[page.length - 1] : null };
  }

  if (!isUuid(audience.conversationId) || (cursor !== null && !isUuid(cursor))) return { userIds: [], nextCursor: null };
  const db = ctx.db;
  const r = await db.query(
    `SELECT p.user_id::text AS user_id
     FROM ${db.t('conversation_participants')} p
     JOIN ${db.t('conversations')} c ON c.id = p.conversation_id
     WHERE p.conversation_id = $1 AND c.project_id = $2 AND ($3::uuid IS NULL OR p.user_id > $3::uuid)
     ORDER BY p.user_id
     LIMIT ${limit + 1}`,
    [audience.conversationId, projectId, cursor]
  );
  const ids = r.rows.map((x) => x.user_id as string);
  const page = ids.slice(0, limit);
  return { userIds: page, nextCursor: ids.length > limit ? page[page.length - 1] : null };
}
