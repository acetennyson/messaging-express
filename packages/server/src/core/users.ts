import type { ServerContext } from './context';

export interface ListUsersParams {
  limit: number;
  offset: number;
  search?: string;
  externalId?: string;
}

export async function listUsers(ctx: ServerContext, projectId: string, p: ListUsersParams) {
  const users = ctx.db.t('users');
  let sql = `SELECT * FROM ${users} WHERE project_id = $1`;
  const params: unknown[] = [projectId];
  let i = 2;

  if (p.search) {
    sql += ` AND (name ILIKE $${i} OR email ILIKE $${i})`;
    params.push(`%${p.search}%`);
    i++;
  }
  if (p.externalId) {
    sql += ` AND external_id = $${i}`;
    params.push(p.externalId);
    i++;
  }
  sql += ` ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
  params.push(p.limit, p.offset);

  const result = await ctx.db.query(sql, params);

  // Total count (unfiltered, as before)
  const countResult = await ctx.db.query(`SELECT COUNT(*) FROM ${users} WHERE project_id = $1`, [projectId]);
  const total = parseInt(String(countResult.rows[0].count));

  return { rows: result.rows, total };
}
