import { query } from '../db/pool';

/**
 * The "project exists and is active, organization is active" check, shared by the REST
 * middleware (authenticateRequest) and the realtime handshake (Stage 5.3) so the two can
 * never drift apart. Throws with the same messages the REST API has always used.
 */
export async function loadActiveProject(projectId: string) {
  const projectResult = await query(
    `SELECT p.*, o.id as organization_id, o.name as organization_name, o.is_active as org_active
     FROM mx_projects p
     JOIN mx_organizations o ON p.organization_id = o.id
     WHERE p.id = $1 AND p.is_active = true`,
    [projectId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found or inactive');
  }

  const project = projectResult.rows[0];

  if (!project.org_active) {
    throw new Error('Organization inactive');
  }

  return project;
}
