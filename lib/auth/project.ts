import { query } from '../db/pool';
import { AuthError } from '../errors';
import { getProjectCacheTtlSeconds } from '../config/flags';

/**
 * The "project exists and is active, organization is active" check, shared by the REST
 * middleware (authenticateRequest) and the realtime handshake (Stage 5.3) so the two can
 * never drift apart. Throws with the same messages the REST API has always used.
 */
async function queryActiveProject(projectId: string) {
  const projectResult = await query(
    `SELECT p.*, o.id as organization_id, o.name as organization_name, o.is_active as org_active
     FROM mx_projects p
     JOIN mx_organizations o ON p.organization_id = o.id
     WHERE p.id = $1 AND p.is_active = true`,
    [projectId]
  );

  if (projectResult.rows.length === 0) {
    throw new AuthError('Project not found or inactive');
  }

  const project = projectResult.rows[0];

  if (!project.org_active) {
    throw new AuthError('Organization inactive');
  }

  return project;
}

/**
 * Track H4: optional in-memory cache in front of the lookup above.
 *
 *  - Off by default. Enabled by PROJECT_CACHE_TTL_SECONDS (1..3600), read on every call.
 *  - Only SUCCESSFUL lookups are cached. A failure (inactive project, database error) is never remembered, so a
 *    project that is (re)activated works immediately.
 *  - The price: a project or organization that is DEACTIVATED keeps working on this instance for up to the TTL.
 *    Each process, and each bundle inside it (route handlers vs the realtime handshake), has its own cache.
 *  - Bounded: at most MAX_ENTRIES projects, oldest evicted first.
 *  - Callers get a shallow copy, so one request cannot change what another sees.
 */
const MAX_ENTRIES = 1000;
const cache = new Map<string, { project: Record<string, any>; expiresAt: number }>();

export function clearProjectCache(): void {
  cache.clear();
}

export async function loadActiveProject(projectId: string) {
  const ttl = getProjectCacheTtlSeconds();
  if (ttl === 0) {
    if (cache.size > 0) cache.clear(); // TTL switched off at runtime: do not keep serving old entries
    return queryActiveProject(projectId);
  }

  const now = Date.now();
  const hit = cache.get(projectId);
  if (hit && hit.expiresAt > now) return { ...hit.project };

  const project = await queryActiveProject(projectId); // throws are not cached
  cache.delete(projectId);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(projectId, { project, expiresAt: now + ttl * 1000 });
  return { ...project };
}
