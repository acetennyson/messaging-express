import type { Pool, PoolConfig } from 'pg';
import type { Logger } from './logger';
import type { CustomAuthenticate } from './auth/single-tenant';
import { ConfigError } from './errors';
import { DEFAULT_RULES } from './rate-limit/limits';
import type { ResolvedUpload } from './storage/embedded';

/** What `MessagingServer.init` accepts. Only `database` and `jwtSecret` are required (decision D5). */
export interface InitOptions {
  /** A connection string, a pg config object (we open and own the pool) or your pg.Pool (borrowed, never reconfigured). */
  database: string | PoolConfig | Pool;
  /** Verifies the tokens your backend signs. At least 32 characters. */
  jwtSecret: string;
  /** Postgres schema holding the tables. Default 'messaging'. */
  schema?: string;
  /** Name of the single project row. Default 'default'. */
  projectName?: string;
  /** Same rules as the hosted server. Default 'enforce'. */
  participantAccess?: 'enforce' | 'dry-run' | 'off';
  /** Encryption routes. Default 'on'. */
  e2ee?: 'on' | 'off';
  /** Bridge to your own login system. null = 401, a throw or a timeout = 503. See the README contract. */
  authenticate?: CustomAuthenticate;
  /** A hung `authenticate` becomes a 503 after this long. Default 5000. */
  authenticateTimeoutMs?: number;
  /** Run pending migrations inside init. Default false: run MessagingServer.migrate as a deploy step instead. */
  autoMigrate?: boolean;
  /**
   * Send events to your backend. Off unless set. `secret` signs the payload (HMAC-SHA256, header X-Webhook-Signature).
   * Failed deliveries are retried in-process every `retryIntervalMs` (default 30000) unless `retry: false`.
   */
  webhook?: { url: string; secret?: string; retry?: boolean; retryIntervalMs?: number };
  /**
   * Per-user request limits. Default `{ mode: 'off', store: 'postgres' }` (nothing is limited until you turn it on).
   * `mode`: 'enforce' answers 429, 'dry-run' only logs `rate_limit_would_block`. `store`: 'postgres' is shared by every
   * instance; 'memory' is per process (limits are per instance). `limits` overrides rules by name, e.g.
   * `{ 'messages:POST': { limit: 60, windowMs: 60000 } }`. See docs/rate-limiting.md.
   */
  rateLimit?: { mode?: 'off' | 'dry-run' | 'enforce'; store?: 'memory' | 'postgres'; limits?: Record<string, { limit: number; windowMs: number }> };
  /**
   * File uploads. Without it the upload routes answer 501.
   * - `{ type: 'local', route?: '/uploads', options: { dir, baseUrl } }`: files go to `dir` on this machine and this module
   *   serves them at `<root><route>/<file>`. `baseUrl` is the absolute URL your clients use to reach the module's root
   *   (e.g. 'https://api.acme.com/chat'); attachments must carry absolute URLs. Not shared between instances: use S3 for that.
   * - `{ type: 's3', options: { bucket, region, endpoint?, forcePathStyle?, publicBaseUrl?, accessKeyId?, secretAccessKey?, sessionToken? } }`:
   *   any S3-compatible service (AWS, Cloudflare R2, Supabase Storage, MinIO). The bucket (or `publicBaseUrl`, e.g. a CDN)
   *   must be readable by your clients. Credentials default to the AWS SDK chain (env vars, IAM role).
   * `limits` (all optional): `maxSizeBytes` (default 25 MB), `maxConcurrent` (4), `allowedMimeTypes`. See docs/uploads.md.
   */
  upload?:
    | { type: 'local'; route?: string; options: { dir: string; baseUrl: string }; limits?: UploadLimits }
    | {
        type: 's3';
        options: {
          bucket: string;
          region: string;
          endpoint?: string;
          forcePathStyle?: boolean;
          publicBaseUrl?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
        };
        limits?: UploadLimits;
      };
  /** false (default): your app owns CORS. Or the list of origins we answer for. */
  cors?: false | string[];
  /** Default: JSON lines on the console, with the usual redaction. */
  logger?: Logger;
}

export interface UploadLimits {
  maxSizeBytes?: number;
  maxConcurrent?: number;
  allowedMimeTypes?: string[];
}

export interface ResolvedOptions {
  database: string | PoolConfig | Pool;
  jwtSecret: string;
  schema: string;
  projectName: string;
  participantAccess: 'enforce' | 'dry-run' | 'off';
  e2ee: 'on' | 'off';
  authenticate?: CustomAuthenticate;
  authenticateTimeoutMs: number;
  autoMigrate: boolean;
  webhook?: { url: string; secret?: string; retry: boolean; retryIntervalMs: number };
  rateLimit: { mode: 'off' | 'dry-run' | 'enforce'; store: 'memory' | 'postgres'; limits?: Record<string, { limit: number; windowMs: number }> };
  upload?: ResolvedUpload;
  uploadLimits: UploadLimits;
  cors: false | string[];
  logger?: Logger;
}

export const MIN_JWT_SECRET_LENGTH = 32;

const KNOWN = new Set([
  'database',
  'jwtSecret',
  'schema',
  'projectName',
  'participantAccess',
  'e2ee',
  'authenticate',
  'authenticateTimeoutMs',
  'autoMigrate',
  'webhook',
  'rateLimit',
  'upload',
  'cors',
  'logger',
]);

export function isPool(x: unknown): x is Pool {
  const p = x as Partial<Pool> | null;
  return !!p && typeof p === 'object' && typeof p.query === 'function' && typeof p.connect === 'function' && typeof p.end === 'function';
}

function plainObject(name: string, value: unknown, known: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(name, 'must be an object');
  for (const key of Object.keys(value)) if (!known.includes(key)) throw new ConfigError(name, `unknown field '${key}'. Known: ${known.join(', ')}`);
  return value as Record<string, unknown>;
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(name, 'is required and must be a non-empty string');
  return value.trim();
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(name, value);
}

/** The `upload` option: validated here, so a wrong value stops init with the option's name in the message. */
function resolveUpload(input: unknown): { upload?: ResolvedUpload; uploadLimits: UploadLimits } {
  if (input === undefined) return { uploadLimits: {} };
  const u = plainObject('upload', input, ['type', 'route', 'options', 'limits']);
  const type = typeof u.type === 'string' ? u.type.toLowerCase() : u.type;
  if (type !== 'local' && type !== 's3') throw new ConfigError('upload.type', "must be 'local' or 's3'");

  const limitsIn = u.limits === undefined ? {} : plainObject('upload.limits', u.limits, ['maxSizeBytes', 'maxConcurrent', 'allowedMimeTypes']);
  const uploadLimits: UploadLimits = {};
  for (const key of ['maxSizeBytes', 'maxConcurrent'] as const) {
    const v = limitsIn[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || (v as number) <= 0) throw new ConfigError(`upload.limits.${key}`, 'must be a whole number greater than 0');
    uploadLimits[key] = v as number;
  }
  if (limitsIn.allowedMimeTypes !== undefined) {
    const m = limitsIn.allowedMimeTypes;
    if (!Array.isArray(m) || m.length === 0 || m.some((x) => typeof x !== 'string' || !x.includes('/'))) {
      throw new ConfigError('upload.limits.allowedMimeTypes', "must be a non-empty list of MIME types, e.g. ['image/png']");
    }
    uploadLimits.allowedMimeTypes = (m as string[]).map((x) => x.trim().toLowerCase());
  }

  if (type === 'local') {
    const o = plainObject('upload.options', u.options ?? {}, ['dir', 'baseUrl']);
    const dir = requiredString('upload.options.dir', o.dir);
    const baseRaw = requiredString('upload.options.baseUrl', o.baseUrl);
    let base: URL;
    try {
      base = new URL(baseRaw);
    } catch {
      throw new ConfigError('upload.options.baseUrl', "must be an absolute URL such as 'https://api.example.com/chat'");
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new ConfigError('upload.options.baseUrl', 'must start with http:// or https://');
    const route = u.route === undefined ? '/uploads' : u.route;
    if (typeof route !== 'string' || !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(route)) {
      throw new ConfigError('upload.route', "must be a path like '/uploads' or '/files/chat' (no trailing slash, no query)");
    }
    if (route === '/api' || route.startsWith('/api/') || route === '/meta') throw new ConfigError('upload.route', `'${route}' is used by the API`);
    return { upload: { type: 'local', route, dir, baseUrl: base.toString().replace(/\/+$/, '') }, uploadLimits };
  }

  if (u.route !== undefined) throw new ConfigError('upload.route', "only applies to type 'local' (S3 files are served by your bucket or CDN)");
  const o = plainObject('upload.options', u.options, ['bucket', 'region', 'endpoint', 'forcePathStyle', 'publicBaseUrl', 'accessKeyId', 'secretAccessKey', 'sessionToken']);
  const bucket = requiredString('upload.options.bucket', o.bucket);
  const region = requiredString('upload.options.region', o.region);
  const endpoint = optionalString('upload.options.endpoint', o.endpoint);
  const publicBaseUrl = optionalString('upload.options.publicBaseUrl', o.publicBaseUrl);
  for (const [name, v] of [['endpoint', endpoint], ['publicBaseUrl', publicBaseUrl]] as const) {
    if (v === undefined) continue;
    try {
      new URL(v);
    } catch {
      throw new ConfigError(`upload.options.${name}`, 'must be an absolute URL');
    }
  }
  if (o.forcePathStyle !== undefined && typeof o.forcePathStyle !== 'boolean') throw new ConfigError('upload.options.forcePathStyle', 'must be true or false');
  const accessKeyId = optionalString('upload.options.accessKeyId', o.accessKeyId);
  const secretAccessKey = optionalString('upload.options.secretAccessKey', o.secretAccessKey);
  if (!accessKeyId !== !secretAccessKey) throw new ConfigError('upload.options', 'accessKeyId and secretAccessKey go together: give both, or neither to use the AWS default credential chain');
  const sessionToken = optionalString('upload.options.sessionToken', o.sessionToken);
  return {
    upload: {
      type: 's3',
      bucket,
      region,
      endpoint,
      forcePathStyle: o.forcePathStyle as boolean | undefined,
      publicBaseUrl,
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } : undefined,
    },
    uploadLimits,
  };
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(name, `must be one of ${allowed.map((a) => `'${a}'`).join(', ')} (got ${JSON.stringify(value)})`);
}

/** Check every option up front and apply the documented defaults. Throws ConfigError naming the first bad option. */
export function resolveOptions(input: unknown): ResolvedOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError('options', 'MessagingServer.init() needs an options object, e.g. { database, jwtSecret }');
  }
  const o = input as Record<string, unknown>;

  for (const key of Object.keys(o)) {
    if (!KNOWN.has(key)) throw new ConfigError(key, `unknown option. Known options: ${[...KNOWN].join(', ')}`);
  }

  const db = o.database;
  const dbOk =
    (typeof db === 'string' && db.trim() !== '') ||
    isPool(db) ||
    (typeof db === 'object' && db !== null && !Array.isArray(db) && Object.keys(db).length > 0);
  if (!dbOk) {
    throw new ConfigError('database', 'is required: a connection string, a pg config object or a pg.Pool');
  }

  const secret = o.jwtSecret;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new ConfigError('jwtSecret', 'is required: the secret your backend signs tokens with');
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError('jwtSecret', `is too short (${secret.length} characters); use at least ${MIN_JWT_SECRET_LENGTH}`);
  }

  let schema = 'messaging';
  if (o.schema !== undefined) {
    if (typeof o.schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(o.schema)) {
      throw new ConfigError('schema', `must be a lower-case Postgres identifier (letters, digits, underscore; got ${JSON.stringify(o.schema)})`);
    }
    schema = o.schema;
  }

  let projectName = 'default';
  if (o.projectName !== undefined) {
    if (typeof o.projectName !== 'string' || o.projectName.trim() === '' || o.projectName.length > 255) {
      throw new ConfigError('projectName', 'must be a non-empty string of at most 255 characters');
    }
    projectName = o.projectName;
  }

  const participantAccess = oneOf('participantAccess', o.participantAccess, ['enforce', 'dry-run', 'off'] as const, 'enforce');
  const e2ee = oneOf('e2ee', o.e2ee, ['on', 'off'] as const, 'on');

  if (o.authenticate !== undefined && typeof o.authenticate !== 'function') {
    throw new ConfigError('authenticate', 'must be a function (request) => { userId, type } | null');
  }

  let authenticateTimeoutMs = 5000;
  if (o.authenticateTimeoutMs !== undefined) {
    const t = o.authenticateTimeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 120_000) {
      throw new ConfigError('authenticateTimeoutMs', 'must be a whole number of milliseconds from 1 to 120000');
    }
    authenticateTimeoutMs = t;
  }

  if (o.autoMigrate !== undefined && typeof o.autoMigrate !== 'boolean') {
    throw new ConfigError('autoMigrate', 'must be true or false');
  }

  let rateLimit: ResolvedOptions['rateLimit'] = { mode: 'off', store: 'postgres' };
  if (o.rateLimit !== undefined) {
    const r = o.rateLimit as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new ConfigError('rateLimit', "must be an object: { mode?, store?, limits? }");
    for (const key of Object.keys(r)) if (!['mode', 'store', 'limits'].includes(key)) throw new ConfigError('rateLimit', `unknown field '${key}'. Known: mode, store, limits`);
    const mode = oneOf('rateLimit.mode', r.mode, ['off', 'dry-run', 'enforce'] as const, 'off');
    const store = oneOf('rateLimit.store', r.store, ['memory', 'postgres'] as const, 'postgres');
    let limits: Record<string, { limit: number; windowMs: number }> | undefined;
    if (r.limits !== undefined) {
      const l = r.limits as Record<string, unknown> | null;
      if (typeof l !== 'object' || l === null || Array.isArray(l)) throw new ConfigError('rateLimit.limits', 'must be an object of rule name -> { limit, windowMs }');
      limits = {};
      for (const [name, rule] of Object.entries(l)) {
        if (!(name in DEFAULT_RULES)) throw new ConfigError('rateLimit.limits', `unknown rule '${name}'. Known rules: ${Object.keys(DEFAULT_RULES).join(', ')}`);
        const v = rule as { limit?: unknown; windowMs?: unknown } | null;
        const ok = !!v && typeof v === 'object' && Number.isInteger(v.limit) && (v.limit as number) > 0 && Number.isInteger(v.windowMs) && (v.windowMs as number) > 0;
        if (!ok) throw new ConfigError('rateLimit.limits', `rule '${name}' must be { limit: whole number > 0, windowMs: whole number > 0 }`);
        limits[name] = { limit: v!.limit as number, windowMs: v!.windowMs as number };
      }
    }
    rateLimit = { mode, store, limits };
  }

  const { upload, uploadLimits } = resolveUpload(o.upload);

  let webhook: ResolvedOptions['webhook'];
  if (o.webhook !== undefined) {
    const w = o.webhook as Record<string, unknown> | null;
    if (typeof w !== 'object' || w === null || Array.isArray(w)) throw new ConfigError('webhook', 'must be an object: { url, secret?, retry?, retryIntervalMs? }');
    for (const key of Object.keys(w)) {
      if (!['url', 'secret', 'retry', 'retryIntervalMs'].includes(key)) throw new ConfigError('webhook', `unknown field '${key}'. Known: url, secret, retry, retryIntervalMs`);
    }
    let url: URL | null = null;
    try {
      url = typeof w.url === 'string' ? new URL(w.url) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new ConfigError('webhook', 'url must be an http(s) URL');
    if (w.secret !== undefined && (typeof w.secret !== 'string' || w.secret === '')) throw new ConfigError('webhook', 'secret must be a non-empty string when given');
    if (w.retry !== undefined && typeof w.retry !== 'boolean') throw new ConfigError('webhook', 'retry must be true or false');
    const every = w.retryIntervalMs ?? 30_000;
    if (typeof every !== 'number' || !Number.isInteger(every) || every < 1000 || every > 3_600_000) {
      throw new ConfigError('webhook', 'retryIntervalMs must be a whole number of milliseconds from 1000 to 3600000');
    }
    webhook = { url: w.url as string, secret: w.secret as string | undefined, retry: w.retry !== false, retryIntervalMs: every };
  }

  let cors: ResolvedOptions['cors'] = false;
  if (o.cors !== undefined && o.cors !== false) {
    const list = o.cors;
    if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string' && x.trim() !== '' && !x.includes(','))) {
      throw new ConfigError('cors', "must be false or a non-empty list of origins such as ['https://app.example.com']");
    }
    cors = list as string[];
  }

  if (o.logger !== undefined) {
    const l = o.logger as Record<string, unknown> | null;
    const ok = !!l && ['debug', 'info', 'warn', 'error'].every((m) => typeof l[m] === 'function');
    if (!ok) throw new ConfigError('logger', 'must have debug, info, warn and error functions');
  }

  return {
    database: db as ResolvedOptions['database'],
    jwtSecret: secret,
    schema,
    projectName,
    participantAccess,
    e2ee,
    authenticate: o.authenticate as CustomAuthenticate | undefined,
    authenticateTimeoutMs,
    autoMigrate: o.autoMigrate === true,
    webhook,
    rateLimit,
    upload,
    uploadLimits,
    cors,
    logger: o.logger as Logger | undefined,
  };
}

/** The values the shared config reads, derived from the options. This is the embedded module's only "environment". */
export function configReaderFor(o: ResolvedOptions): (name: string) => string | undefined {
  const values: Record<string, string> = {
    JWT_SECRET: o.jwtSecret,
    PARTICIPANT_ACCESS_MODE: o.participantAccess,
    E2EE_ENABLED: o.e2ee,
    // cors:false must match no origin. (The shared config turns an empty value into '*', so a non-origin sentinel is used.)
    ...(o.upload?.type === 's3'
      ? {
          S3_BUCKET: o.upload.bucket,
          S3_REGION: o.upload.region,
          ...(o.upload.endpoint ? { S3_ENDPOINT: o.upload.endpoint } : {}),
          ...(o.upload.forcePathStyle !== undefined ? { S3_FORCE_PATH_STYLE: String(o.upload.forcePathStyle) } : {}),
          ...(o.upload.publicBaseUrl ? { S3_PUBLIC_BASE_URL: o.upload.publicBaseUrl } : {}),
        }
      : {}),
    ...(o.uploadLimits.maxSizeBytes ? { MAX_UPLOAD_SIZE_BYTES: String(o.uploadLimits.maxSizeBytes) } : {}),
    ...(o.uploadLimits.maxConcurrent ? { MAX_CONCURRENT_UPLOADS: String(o.uploadLimits.maxConcurrent) } : {}),
    ...(o.uploadLimits.allowedMimeTypes ? { UPLOAD_ALLOWED_MIME_TYPES: o.uploadLimits.allowedMimeTypes.join(',') } : {}),
    RATE_LIMIT_MODE: o.rateLimit.mode,
    ...(o.rateLimit.limits ? { RATE_LIMITS_JSON: JSON.stringify(o.rateLimit.limits) } : {}),
    ...(o.webhook ? { WEBHOOK_DISPATCH: 'on', WEBHOOK_RETRY: o.webhook.retry ? 'on' : 'off', ...(o.webhook.secret ? { WEBHOOK_SECRET: o.webhook.secret } : {}) } : {}),
    CORS_ALLOWED_ORIGINS: o.cors === false ? 'cors-disabled' : o.cors.join(','),
  };
  return (name) => values[name];
}

/** What `MessagingServer.migrate` accepts. */
export interface MigrateOptions {
  database: string | PoolConfig | Pool;
  /** Default 'messaging'. */
  schema?: string;
  /** Report the pending steps and change nothing. */
  dryRun?: boolean;
  logger?: Logger;
}

export function resolveMigrateOptions(input: unknown): { database: ResolvedOptions['database']; schema: string; dryRun: boolean; logger?: Logger } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError('options', 'MessagingServer.migrate() needs an options object, e.g. { database }');
  }
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!['database', 'schema', 'dryRun', 'logger'].includes(key)) throw new ConfigError(key, 'unknown option. Known options: database, schema, dryRun, logger');
  }
  if (o.dryRun !== undefined && typeof o.dryRun !== 'boolean') throw new ConfigError('dryRun', 'must be true or false');
  // Reuse the init checks for the shared options, with a placeholder secret for the one this call does not take.
  const r = resolveOptions({ database: o.database, jwtSecret: 'x'.repeat(MIN_JWT_SECRET_LENGTH), schema: o.schema, logger: o.logger });
  return { database: r.database, schema: r.schema, dryRun: o.dryRun === true, logger: r.logger };
}
