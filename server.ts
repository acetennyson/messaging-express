/**
 * Application entrypoint (Implementation Plan, Stage 5.2 introduced it, 5.5 made it the default).
 *
 * Wraps Next's request handler in a plain http.Server so a realtime transport (Socket.IO,
 * REALTIME_PROVIDER=socketio, Stage 5.3) can share the same port and process. With the default
 * REALTIME_PROVIDER=none it serves exactly what `next start` serves.
 *
 *   npm run dev:socket        local development (tsx watch, dev mode)
 *   npm run build && npm start     production: `npm start` runs the compiled dist/server.js
 *   npm run nextstart         the old behaviour: plain `next start`, no server.ts (rollback / REST-only hosts)
 *
 * RULES FOR THIS FILE
 *  - Relative imports only (no "@/..." aliases): the compiled dist/server.js is run by plain
 *    `node`, which does not understand tsconfig paths.
 *  - Do not import anything that reads required env (e.g. lib/db/pool) at module scope: Next
 *    loads .env files inside `app.prepare()`, after this module has been evaluated.
 *  - Routes are bundled separately from this file, so they do NOT share module state with it.
 *    Anything routes and this file must share (the realtime provider, in-flight work) lives on
 *    globalThis (see lib/realtime/index.ts, lib/events/inflight.ts).
 *
 * LOAD BALANCER NOTE (matters once Socket.IO is attached, 5.3): Socket.IO's long-polling
 * fallback needs every request of one client to land on the same instance. Behind a
 * round-robin balancer use sticky sessions (ip_hash or cookie affinity), or force
 * `transports: ['websocket']` on the client. With more than one instance, Redis (5.6) is
 * REQUIRED, otherwise events published on instance A silently never reach sockets on B.
 */
import { createServer, type Server } from 'http';
import { monitorEventLoopDelay } from 'perf_hooks';
import type { Socket } from 'net';
import type nextFactory from 'next';
import { logger } from './lib/logger';
import { drainInflight, inflightCount } from './lib/events/inflight';
import { getRealtime, registerRealtime, unregisterRealtime } from './lib/realtime';

// Development only when asked: `--dev` (npm run dev:socket) or NODE_ENV=development. Anything else,
// including NODE_ENV unset (what `npm start` gives you), is PRODUCTION, like `next start`.
const dev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
// `next start` sets NODE_ENV itself; a plain `node dist/server.js` does not, and without it React
// loads its slow development build. Set it before `next` is loaded (it is imported dynamically below).
// (Next's types declare NODE_ENV read-only, hence the cast.)
(process.env as Record<string, string | undefined>).NODE_ENV = dev ? 'development' : 'production';
const port = parseInt(process.env.PORT || '3000', 10);
// Not HOSTNAME: Docker/Windows set that to the machine name.
const hostname = process.env.HOST || (dev ? 'localhost' : '0.0.0.0');
// Soak/observability (Stage 5.4): > 0 logs a `server_stats` line this often (ms). 0 = off (default).
const STATS_INTERVAL_MS = Math.max(0, parseInt(process.env.SOAK_STATS_INTERVAL_MS || '0', 10) || 0);
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10) || 10000);

// Module-scope and nullable on purpose: shutdown() must be safe even if the process crashes
// during app.prepare(), before any of these exist.
let httpServer: Server | null = null;
let app: ReturnType<typeof nextFactory> | null = null;
let shuttingDown = false;
// Every TCP socket, including ones that were upgraded (websockets / unanswered upgrade requests),
// which http.Server.closeAllConnections() does not cover. Destroyed at the end of shutdown.
const openSockets = new Set<Socket>();

/** Periodic gauges for soak runs: memory, sockets, in-flight work, event-loop delay. Opt-in, unref'd. */
function startStats(): void {
  if (STATS_INTERVAL_MS <= 0) return;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    logger.info('server_stats', {
      uptimeS: Math.round(process.uptime()),
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      externalMb: mb(mem.external),
      openTcpSockets: openSockets.size,
      inflight: inflightCount(),
      eventLoopMeanMs: Math.round((loop.mean / 1e6) * 10) / 10,
      eventLoopP99Ms: Math.round((loop.percentile(99) / 1e6) * 10) / 10,
      realtime: getRealtime()?.stats?.() ?? null,
    });
    loop.reset();
  }, STATS_INTERVAL_MS);
  timer.unref();
}

/**
 * Graceful shutdown: stop accepting connections, tell realtime clients to reconnect elsewhere,
 * let in-flight webhook/realtime work finish (bounded), then exit. Idempotent.
 * `code` is 0 for signals and 1 for crashes, so a process manager restarts on failure.
 */
async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { reason, code, timeoutMs: SHUTDOWN_TIMEOUT_MS });

  // Last-resort: never hang past the budget, whatever a step below does.
  const force = setTimeout(() => {
    logger.error('shutdown_forced', new Error('shutdown exceeded its time budget'), { reason });
    process.exit(code || 1);
  }, SHUTDOWN_TIMEOUT_MS + 2000);
  force.unref();

  try {
    const closing = httpServer
      ? new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
          httpServer!.closeIdleConnections?.();
        })
      : Promise.resolve();

    // 1. Let in-flight webhook/realtime work finish FIRST: a realtime publish still in flight must reach
    //    the sockets (and, with Redis, the other instances) before the transport is closed under it.
    const stillPending = await drainInflight(SHUTDOWN_TIMEOUT_MS);
    if (stillPending > 0) logger.warn('shutdown_inflight_abandoned', { pending: stillPending });

    // 2. Then close realtime: provider.close() disconnects this instance's sockets so clients
    //    reconnect to another instance, and flushes/closes the Redis connections.
    try {
      await getRealtime()?.close?.();
    } catch (error) {
      logger.error('shutdown_realtime_close_failed', error);
    }
    unregisterRealtime();

    // Give open requests the rest of the budget, then cut whatever is left.
    await Promise.race([closing, new Promise((r) => setTimeout(r, 1000))]);
    httpServer?.closeAllConnections?.();
    for (const socket of openSockets) socket.destroy();

    try {
      await app?.close?.();
    } catch (error) {
      logger.error('shutdown_next_close_failed', error);
    }
    // The DB pool is not closed here: route bundles own their own pool instance, and process
    // exit drops those connections. (Sharing one pool across bundles is tracked in Track H1.)
  } catch (error) {
    logger.error('shutdown_failed', error, { reason });
    code = code || 1;
  }

  logger.info('shutdown_complete', { reason, code });
  process.exit(code);
}

// Crash safety net: log, drain what is in flight within a bounded timeout, exit NON-ZERO and
// let the process manager restart clean. No "log and keep going".
process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', error);
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', reason);
  void shutdown('unhandledRejection', 1);
});
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));

async function main(): Promise<void> {
  let handle: ReturnType<ReturnType<typeof nextFactory>['getRequestHandler']> | null = null;

  httpServer = createServer((req, res) => {
    if (!handle) {
      res.statusCode = 503;
      res.end('starting');
      return;
    }
    handle(req, res).catch((error) => {
      logger.error('request_handler_failed', error, { url: req.url });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });

  httpServer.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });

  // Passing httpServer lets Next attach its own upgrade handling (dev HMR websocket).
  // Loaded here, after NODE_ENV is settled above (a static import would run first).
  const next = (await import('next')).default;
  app = next({ dev, hostname, port, httpServer });
  handle = app.getRequestHandler();
  await app.prepare();

  const provider = (process.env.REALTIME_PROVIDER || 'none').trim().toLowerCase();
  if (provider === 'socketio') {
    // Dynamic import: these modules read env (DATABASE_URL, JWT_SECRET) at load time, which
    // Next only loaded inside app.prepare() above.
    const { createSocketIoServer, createSocketIoProvider } = await import('./lib/realtime/providers/socketio');
    const io = createSocketIoServer(httpServer);
    // REDIS_URL set: relay broadcasts through Redis so several instances behave as one (5.6).
    // Unset: in-memory adapter, correct for exactly ONE instance.
    const redisUrl = process.env.REDIS_URL?.trim();
    let redis: import('./lib/realtime/providers/redis').RedisAttachment | null = null;
    if (redisUrl) {
      const { attachRedisAdapter } = await import('./lib/realtime/providers/redis');
      redis = await attachRedisAdapter(io, redisUrl);
    }
    logger.info('realtime_adapter', { adapter: redis ? 'redis' : 'memory' });
    registerRealtime(createSocketIoProvider(io, { redis }));
  } else if (provider !== 'none') {
    logger.warn('realtime_provider_ignored', { provider, note: 'only socketio is wired in server.ts (Path A)' });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.listen(port, hostname, () => resolve());
  });
  startStats();
  logger.info('server_listening', { url: `http://${hostname}:${port}`, dev, realtime: provider });
}

main().catch((error) => {
  logger.error('startup_failed', error);
  void shutdown('startup_failed', 1);
});
