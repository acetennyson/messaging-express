import { randomBytes } from 'crypto';
import { extractBearerToken, verifyToken } from './jwt';
import { fetchActiveProject } from './project';
import { AuthError, AuthUnavailableError, ConfigError } from '../errors';
import type { AuthContext, AuthStrategy } from './strategy';
import type { Db } from '../core/db';
import type { Logger } from '../logger';
import type { ServerContext } from '../core/context';

/** What the customer's `authenticate()` returns for a caller it recognises. */
export interface AuthIdentity {
  /** Required for type 'user'. */
  userId?: string;
  type: 'user' | 'api' | 'admin';
}

export type CustomAuthenticate = (request: Request) => Promise<AuthIdentity | null> | AuthIdentity | null;

const TYPES = ['user', 'api', 'admin'] as const;
const isType = (t: unknown): t is AuthIdentity['type'] => (TYPES as readonly unknown[]).includes(t);

export interface SingleTenantAuthOptions {
  /** The single project row (joined with its organization), loaded once at init. */
  project: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- same row shape the hosted lookup returns
  authenticate?: CustomAuthenticate;
  /** A hung `authenticate` becomes a 503 after this long. */
  timeoutMs: number;
}

function contextFor(project: SingleTenantAuthOptions['project'], who: AuthIdentity, exp?: number): AuthContext {
  return {
    projectId: project.id,
    userId: who.userId,
    organizationId: project.organization_id,
    type: who.type,
    project: { ...project },
    organization: { id: project.organization_id, name: project.organization_name },
    exp,
  };
}

/**
 * Single-tenant authentication. The project is fixed at init, so there is no per-request lookup and the token carries no
 * projectId. Order: our own JWT (signed with `jwtSecret`) first; if there is none, or it does not verify, the customer's
 * `authenticate` (when given) decides. Either way the result is the same AuthContext, so participant access and E2EE
 * rules apply identically: this only answers "who is calling".
 */
export function createSingleTenantAuth(options: SingleTenantAuthOptions): AuthStrategy {
  const { project, authenticate, timeoutMs } = options;

  function fromJwt(ctx: ServerContext, token: string): AuthContext | null {
    try {
      const p = verifyToken(ctx, token);
      if (!isType(p.type)) return null;
      if (p.userId !== undefined && (typeof p.userId !== 'string' || p.userId === '')) return null;
      return contextFor(project, { userId: p.userId, type: p.type }, p.exp);
    } catch {
      return null;
    }
  }

  async function callCustom(ctx: ServerContext, request: Request): Promise<AuthIdentity | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => authenticate!(request)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`authenticate() did not answer within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      ctx.logger.error('authenticate_failed', error);
      throw new AuthUnavailableError();
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === null) return null;
    const r = result as Partial<AuthIdentity> | undefined;
    const ok =
      typeof r === 'object' &&
      r !== null &&
      isType(r.type) &&
      (r.userId === undefined || (typeof r.userId === 'string' && r.userId !== '')) &&
      !(r.type === 'user' && r.userId === undefined);
    if (!ok) {
      // A bug on the customer's side: never guess what they meant, and never grant access on it.
      ctx.logger.error('authenticate_invalid_result', undefined, { expected: "{ userId?: string, type: 'user' | 'api' | 'admin' } or null" });
      throw new AuthUnavailableError();
    }
    return { userId: r.userId, type: r.type as AuthIdentity['type'] };
  }

  return {
    async authenticate(ctx, request) {
      const token = extractBearerToken(request.headers.get('authorization'));
      if (token) {
        const viaJwt = fromJwt(ctx, token);
        if (viaJwt) return viaJwt;
      }
      if (!authenticate) {
        throw new AuthError(token ? 'Invalid or expired token' : 'Missing authentication token', token ? 'invalid_token' : 'rejected');
      }
      const who = await callCustom(ctx, request);
      if (!who) throw new AuthError(token ? 'Invalid or expired token' : 'Missing authentication token');
      return contextFor(project, who);
    },

    async authenticateToken(ctx, token) {
      const viaJwt = fromJwt(ctx, token);
      if (!viaJwt) throw new AuthError('Invalid or expired token', 'invalid_token');
      return viaJwt;
    },
  };
}

const ORG_SLUG = 'embedded';

/**
 * Make sure the one organization and the one project row exist (idempotent; the project is found by name) and return
 * the project exactly as the hosted lookup would. The tables keep their foreign keys, so every query and the 7.12 rules
 * stay identical to the hosted server (decision D2). A transaction-level advisory lock makes two instances starting at
 * once safe. The credentials on these rows are random and unusable: nothing in embedded mode authenticates with them.
 */
export async function ensureSingleTenantProject(db: Db, logger: Logger, projectName: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const secret = () => randomBytes(24).toString('hex');
  const projectId: string = await db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${db.t('projects')}:single-tenant`]);

    let org = (await client.query(`SELECT id FROM ${db.t('organizations')} WHERE slug = $1`, [ORG_SLUG])).rows[0];
    if (!org) {
      org = (
        await client.query(
          `INSERT INTO ${db.t('organizations')} (name, slug, api_key, api_secret_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
          ['Embedded', ORG_SLUG, `embedded_${secret()}`, `!${secret()}`]
        )
      ).rows[0];
      logger.info('single_tenant_organization_created', {});
    }

    const existing = (
      await client.query(`SELECT id FROM ${db.t('projects')} WHERE organization_id = $1 AND name = $2`, [org.id, projectName])
    ).rows[0];
    if (existing) return existing.id as string;
    const created = await client.query(`INSERT INTO ${db.t('projects')} (organization_id, name, api_key) VALUES ($1, $2, $3) RETURNING id`, [
      org.id,
      projectName,
      `embedded_${secret()}`,
    ]);
    logger.info('single_tenant_project_created', { projectName });
    return created.rows[0].id as string;
  });

  try {
    return await fetchActiveProject(db, projectId);
  } catch (error) {
    if (error instanceof AuthError) {
      throw new ConfigError('projectName', `the project '${projectName}' (or its organization) is deactivated in the database; reactivate it or choose another name`);
    }
    throw error;
  }
}

/** Store the webhook target on the single organisation (the sender reads it per event, so a change applies at once). */
export async function applyWebhookSettings(db: Db, webhook: { url: string; secret?: string }): Promise<void> {
  await db.query(`UPDATE ${db.t('organizations')} SET webhook_url = $1, webhook_secret = $2 WHERE slug = $3`, [webhook.url, webhook.secret ?? null, ORG_SLUG]);
}
