import { Pool } from 'pg';
import { createConfig } from './core/config';
import { createDb } from './core/db';
import { createInflightTracker, detachedDefer } from './core/inflight';
import { matchRoute, dispatch } from './core/routing';
import { routes } from './core/routes';
import type { ServerContext } from './core/context';
import { createLogger, type Logger } from './logger';
import { createRealtimeRegistry } from './realtime';
import { createEmbeddedStorage } from './storage/embedded';
import { createPostgresRateLimiter } from './rate-limit/providers/postgres';
import { createMemoryRateLimiter } from './rate-limit/providers/memory';
import { applyWebhookSettings, createSingleTenantAuth, ensureSingleTenantProject } from './auth/single-tenant';
import { AppError, ConfigError, SchemaNotReadyError, toErrorResponse } from './errors';
import { errorResponse, notFoundError } from './http';
import { configReaderFor, isPool, resolveOptions, resolveMigrateOptions, type InitOptions, type MigrateOptions } from './options';
import { assertCompatible, migrate, readStatus, SCHEMA_VERSION, type MigrationResult } from './migrations/runner';
import { createNodeHandler, type NodeHandler, type NodeHandlerOptions } from './adapters/node';
import { CONTRACT_VERSION, MODULE_VERSION } from './version';
import { successResponse } from './http';
import type { Server as HttpServer } from 'http';
import type { Server as IoServer } from 'socket.io';
import { runWebhookRetryBatch } from './webhooks/retry';
import { type Audience, type ModuleEvent } from './realtime/audience';
import { authorizeJoin as authorizeJoinRule, listAudience as listAudienceRule, type AudiencePage } from './realtime/authorize';
import { createCustomProvider } from './realtime/providers/custom';
import { createSocketIoProvider, createSocketIoServer, installSocketIo } from './realtime/providers/socketio';

export interface AttachRealtimeOptions {
  /** Engine.IO path for the Socket.IO server we create. Default '/chat/socket.io'. Clients connect with `io(url, { path })`. */
  path?: string;
  /** An existing Socket.IO server to use instead of creating one (borrowed: never closed by us). */
  io?: IoServer;
  /** With `io`: the namespace our sockets live in, so your own sockets never meet our authentication. Default '/messaging-express'. */
  namespace?: string;
  /** Relay broadcasts through Redis so several instances behave as one (required for more than one instance). Not with `io`. */
  redisUrl?: string;
}

/** Which http servers already carry a realtime attachment (module-wide, so two instances cannot both claim one). */
const attached = new WeakSet<HttpServer>();

export interface CloseOptions {
  /** How long to wait for work that runs after a response (webhooks, realtime). Default 10000. */
  timeoutMs?: number;
  /** 'auto' (default): close the pool only if we created it. 'keep': never. 'close': also a pool you handed us. */
  database?: 'auto' | 'close' | 'keep';
}

/**
 * The embeddable server. `await MessagingServer.init({ database, jwtSecret })` returns an instance that is ready:
 * options are valid, the database is reachable, the tables exist and the single project is in place. If any of that
 * fails, init throws and leaves nothing open that it created.
 */
export class MessagingServer {
  private closing?: Promise<void>;
  private closed = false;
  private realtimeBy: 'none' | 'socketio' | 'custom' = 'none';
  private retryTimer?: ReturnType<typeof setInterval>;
  private retrying = false;

  private constructor(
    private readonly ctx: ServerContext,
    private readonly pool: Pool,
    private readonly ownsPool: boolean
  ) {}

  /**
   * Create or upgrade the tables, in `schema` (created if missing). Explicit and safe to run from several instances at once
   * (advisory lock); run it once per deploy. Never run by `init` unless you pass autoMigrate: true.
   */
  static async migrate(options: MigrateOptions): Promise<MigrationResult> {
    const o = resolveMigrateOptions(options);
    const logger: Logger | undefined = o.logger;
    const log = (line: string) => logger?.info(line);
    return migrate(o.database as Parameters<typeof migrate>[0], { schema: o.schema, dryRun: o.dryRun, log });
  }

  /** The project the instance runs as (its id is the `projectId` on every row). */
  get projectId(): string {
    return this.projectIdValue;
  }
  private projectIdValue = '';

  static async init(options: InitOptions): Promise<MessagingServer> {
    const opts = resolveOptions(options); // throws ConfigError naming the option; nothing opened yet

    const logger: Logger = opts.logger ?? createLogger();
    const ownsPool = !isPool(opts.database);
    const pool: Pool = isPool(opts.database)
      ? opts.database
      : new Pool(typeof opts.database === 'string' ? { connectionString: opts.database } : opts.database);
    if (ownsPool) {
      // An idle-connection error on a pool nobody listens to would crash the process. A borrowed pool is the customer's to watch.
      pool.on('error', (error) => logger.error('pg_pool_error', error));
    }

    try {
      const db = createDb({ pool, schema: opts.schema, onClientError: (error) => logger.error('pg_client_error', error) });

      // Read-only check first. Newer or edited schema is always refused; older is refused unless autoMigrate is on.
      let status = await readStatus(db, opts.schema);
      assertCompatible(status);
      if (status.pending.length > 0) {
        if (!opts.autoMigrate) {
          throw new SchemaNotReadyError(
            `The database is not ready: schema '${opts.schema}' is missing ${status.pending.length} migration step(s). Run MessagingServer.migrate({ database, schema }) once per deploy, or pass autoMigrate: true to init.`
          );
        }
        await migrate(pool, { schema: opts.schema, log: (line) => logger.info(line) });
        status = await readStatus(db, opts.schema);
        assertCompatible(status);
      }

      const project = await ensureSingleTenantProject(db, logger, opts.projectName);
      if (opts.webhook) await applyWebhookSettings(db, opts.webhook);

      const read = configReaderFor(opts);
      const inflight = createInflightTracker();
      const ctx: ServerContext = {
        config: createConfig(read, { warn: (event, data) => logger.warn(event, data) }),
        logger,
        db,
        auth: createSingleTenantAuth({ project, authenticate: opts.authenticate, timeoutMs: opts.authenticateTimeoutMs }),
        storage: createEmbeddedStorage(opts.upload, read),
        realtime: createRealtimeRegistry({ onError: (event, error, meta) => logger.error(event, error, meta) }),
        projectCache: new Map(),
        rateLimiter: opts.rateLimit.store === 'memory' ? createMemoryRateLimiter() : createPostgresRateLimiter({ db, logger }),
        inflight,
        defer: detachedDefer(inflight),
      };

      if (opts.upload) {
        // Fail at startup, not on the first upload: a missing package or setting surfaces here.
        try {
          await ctx.storage.getProvider();
        } catch (error) {
          throw new ConfigError('upload', error instanceof Error ? error.message : String(error));
        }
      }

      const server = new MessagingServer(ctx, pool, ownsPool);
      server.uploadRoute = opts.upload?.type === 'local' ? opts.upload.route : '/uploads';
      server.projectIdValue = project.id;
      if (opts.webhook?.retry) server.startRetryLoop(opts.webhook.retryIntervalMs);
      return server;
    } catch (error) {
      if (ownsPool) await pool.end().catch(() => undefined); // never leak a pool we opened for an instance that did not start
      throw error;
    }
  }

  /** Public path of the local file route (default '/uploads'). The core serves it at /uploads, so other paths are mapped. */
  private uploadRoute = '/uploads';

  private toCorePath(pathname: string): string {
    if (this.uploadRoute === '/uploads') return pathname;
    if (pathname.startsWith(`${this.uploadRoute}/`)) return `/uploads${pathname.slice(this.uploadRoute.length)}`;
    if (pathname === '/uploads' || pathname.startsWith('/uploads/')) return '/__not-served__'; // a custom route replaces /uploads
    return pathname;
  }

  /**
   * Handle one Web Request and return a Response (paths as in the REST API: /api/v1/...). Express and `http` adapters
   * (with a mount path) come with the next milestone; this is what they will call. After close(), answers 503.
   */
  handler = async (request: Request): Promise<Response> => {
    if (this.closed) return errorResponse('The server is shutting down', 503, 'service_unavailable');
    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/meta' && (request.method === 'GET' || request.method === 'HEAD')) {
        return successResponse({ moduleVersion: MODULE_VERSION, contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION });
      }
      const m = matchRoute(routes, request.method, this.toCorePath(pathname));
      if (!m) return notFoundError('Not found');
      return await dispatch(m, request, this.ctx);
    } catch (error) {
      return toErrorResponse(this.ctx, error, error instanceof AppError ? 'handler_error' : 'unhandled_error');
    }
  };

  /** Does a route exist for this request? Adapters ask first, so unknown paths fall through to the customer's own routes. */
  matches(method: string, pathname: string): boolean {
    return (pathname === '/meta' && (method === 'GET' || method === 'HEAD')) || matchRoute(routes, method, this.toCorePath(pathname)) !== null;
  }

  /**
   * `(req, res, next?) => void` for `http.createServer` or Express. For a plain http server mounted under a prefix pass
   * `{ root: '/chat' }`; requests outside it call next() (or get a 404). Express strips its own mount path.
   */
  nodeHandler(options: NodeHandlerOptions = {}): NodeHandler {
    return createNodeHandler(this, options, (error) => this.ctx.logger.error('node_adapter_error', error));
  }

  /** Express (4 and 5): `chat.middleware(app, '/chat')`. Mount it BEFORE body parsers. Unknown paths fall through to your routes. */
  middleware(app: { use(path: string, handler: NodeHandler): unknown }, root = '/'): void {
    app.use(root, this.nodeHandler());
  }

  private startRetryLoop(everyMs: number): void {
    this.retryTimer = setInterval(() => {
      if (this.retrying || this.closed) return;
      this.retrying = true;
      this.ctx.defer(async () => {
        try {
          await runWebhookRetryBatch(this.ctx);
        } catch (error) {
          this.ctx.logger.error('webhook_retry_batch_failed', error);
        } finally {
          this.retrying = false;
        }
      });
    }, everyMs);
    this.retryTimer.unref();
  }

  private assertCanProvideRealtime(what: string): void {
    if (this.closed) throw new Error(`${what}: this MessagingServer is closed`);
    if (this.realtimeBy !== 'none') throw new Error(`${what}: realtime is already provided (${this.realtimeBy === 'socketio' ? 'attachRealtime' : 'onEvent'}); use one or the other`);
  }

  /**
   * Realtime over Socket.IO on your http.Server, with the same token check, `join-conversation` rules and user rooms as the
   * hosted server. Pass `io` to use your own Socket.IO server (we then live in a dedicated namespace and never close it).
   * Rejects if this http.Server already has one attached, or if realtime is already provided another way.
   */
  async attachRealtime(httpServer: HttpServer, options: AttachRealtimeOptions = {}): Promise<void> {
    this.assertCanProvideRealtime('attachRealtime');
    if (!httpServer || typeof httpServer.on !== 'function') throw new ConfigError('httpServer', 'attachRealtime needs the http.Server returned by http.createServer / app.listen');
    if (attached.has(httpServer)) throw new Error('attachRealtime: this http.Server already has a Messaging Express realtime attached');
    const known = new Set(['path', 'io', 'namespace', 'redisUrl']);
    for (const key of Object.keys(options)) if (!known.has(key)) throw new ConfigError(key, `unknown attachRealtime option. Known: ${[...known].join(', ')}`);
    const isClosed = () => this.closed;

    if (options.io) {
      if (options.redisUrl) throw new ConfigError('redisUrl', 'cannot be combined with io: configure the adapter on your own Socket.IO server');
      const namespace = options.namespace ?? '/messaging-express';
      if (!namespace.startsWith('/') || namespace === '/') throw new ConfigError('namespace', "must start with '/' and not be the default namespace (that one is yours)");
      if ((options.io as unknown as { _nsps?: Map<string, unknown> })._nsps?.has(namespace)) throw new Error(`attachRealtime: namespace '${namespace}' already exists on the Socket.IO server you passed`);
      const nsp = options.io.of(namespace);
      installSocketIo(nsp, this.ctx, { isClosed });
      this.ctx.realtime.register(createSocketIoProvider(nsp, { owned: false }));
    } else {
      const path = options.path ?? '/chat/socket.io';
      if (typeof path !== 'string' || !path.startsWith('/')) throw new ConfigError('path', "must be a path starting with '/'");
      const io = createSocketIoServer(httpServer, this.ctx, { path, isClosed });
      let redis = null;
      if (options.redisUrl) {
        const { attachRedisAdapter } = await import('./realtime/providers/redis');
        redis = await attachRedisAdapter(io, options.redisUrl, this.ctx.logger);
      }
      this.ctx.realtime.register(createSocketIoProvider(io, { redis, closeEngine: true }));
    }
    attached.add(httpServer);
    this.realtimeBy = 'socketio';
  }

  /**
   * Bring your own realtime: the module calls `fn` with every event (type, data, audience) instead of publishing to
   * Socket.IO. Authorize each person ONCE with `authorizeJoin` before putting them in a room, and evict them on
   * `participant.removed`. Throws if realtime is already provided.
   */
  onEvent(fn: (event: ModuleEvent) => void | Promise<void>): void {
    this.assertCanProvideRealtime('onEvent');
    if (typeof fn !== 'function') throw new ConfigError('onEvent', 'needs a function (event) => void');
    this.ctx.realtime.register(createCustomProvider(fn, (channel) => this.ctx.logger.warn('event_unroutable', { channel })));
    this.realtimeBy = 'custom';
  }

  /** The check behind `join-conversation`, for custom transports: is this user a participant of this conversation right now? */
  authorizeJoin(userId: string, conversationId: string): Promise<boolean> {
    return authorizeJoinRule(this.ctx, this.projectIdValue, userId, conversationId);
  }

  /** The full recipient list of an event (or its audience), one page at a time, only when asked. */
  listAudience(eventOrAudience: ModuleEvent | Audience, options: { limit?: number; cursor?: string | null } = {}): Promise<AudiencePage> {
    const audience = 'audience' in eventOrAudience ? eventOrAudience.audience : eventOrAudience;
    return listAudienceRule(this.ctx, this.projectIdValue, audience, options);
  }

  /** Stop accepting requests, wait (bounded) for work still running after responses, then release what we own. */
  close(options: CloseOptions = {}): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      if (this.retryTimer) clearInterval(this.retryTimer);
      const left = await this.ctx.inflight.drain(options.timeoutMs ?? 10_000);
      if (left > 0) this.ctx.logger.warn('shutdown_forced', { pending: left });
      try {
        await this.ctx.realtime.get()?.close?.(); // sockets of OUR Socket.IO server (a borrowed one stays open)
      } catch (error) {
        this.ctx.logger.error('shutdown_realtime_close_failed', error);
      }
      this.ctx.realtime.unregister();
      const mode = options.database ?? 'auto';
      if (mode === 'close' || (mode === 'auto' && this.ownsPool)) await this.pool.end();
    })();
    return this.closing;
  }
}
