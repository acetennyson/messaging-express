import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';
import { logger } from '../../logger';

/**
 * Redis adapter for the Socket.IO provider (Implementation Plan, Stage 5.6).
 *
 * WHY: Socket.IO's default adapter is in-process. With two instances behind a balancer, an event
 * published (a REST request) on instance A never reaches a socket connected to instance B: no
 * error, no warning. The Redis adapter relays every room broadcast through Redis pub/sub so each
 * instance delivers to its own sockets. REQUIRED before running more than one instance.
 *
 * Loaded only when REDIS_URL is set (server.ts imports it dynamically), so single-instance
 * deployments never load ioredis.
 *
 * FAILURE POLICY (never kill the process over Redis):
 *  - connection errors are logged (throttled) and ioredis reconnects with backoff;
 *  - the subscriber re-subscribes by itself after a reconnect (ioredis autoResubscribe);
 *  - publishes fail fast while Redis is down (no unbounded offline queue) and are swallowed + logged,
 *    because the adapter fires them without awaiting and a rejection there would otherwise surface
 *    as an unhandledRejection (which server.ts treats as fatal);
 *  - while Redis is down, delivery keeps working to sockets on the SAME instance as the publisher
 *    (the adapter delivers locally first); only cross-instance delivery is lost until it reconnects.
 */

export interface RedisAttachment {
  /** true while both connections are ready */
  isReady(): boolean;
  /** Flush and close both connections. Never throws. */
  close(): Promise<void>;
}

const READY_WAIT_MS = 3000;
const LOG_EVERY_MS = 10_000;

/** Log `fn` at most once per LOG_EVERY_MS per key so an outage cannot flood the logs. */
function throttled() {
  const last = new Map<string, number>();
  return (key: string, fn: () => void) => {
    const now = Date.now();
    if (now - (last.get(key) ?? 0) >= LOG_EVERY_MS) {
      last.set(key, now);
      fn();
    }
  };
}

/** Host only: never log credentials from the URL. */
function describe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export async function attachRedisAdapter(io: Server, url: string): Promise<RedisAttachment> {
  const once = throttled();
  const target = describe(url);

  const common = {
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    // Do not connect-or-die at boot: keep retrying in the background.
    lazyConnect: false,
  };
  // Publisher: fail fast while disconnected (no offline queue), so an outage cannot pile up memory.
  const pub = new Redis(url, { ...common, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  // Subscriber: must be able to queue its SUBSCRIBE while still connecting, and wait for it.
  const sub = new Redis(url, { ...common, enableOfflineQueue: true, maxRetriesPerRequest: null });

  for (const [name, client] of [['pub', pub], ['sub', sub]] as const) {
    // An 'error' event with no listener would throw and crash the process.
    client.on('error', (error: Error) =>
      once(`error:${name}`, () => logger.error('redis_error', error, { client: name, target }))
    );
    client.on('reconnecting', () => once(`reconnecting:${name}`, () => logger.warn('redis_reconnecting', { client: name, target })));
    client.on('ready', () => logger.info('redis_ready', { client: name, target }));
  }

  // The adapter fires these commands without awaiting or catching them. If Redis is down (or the
  // connection is already closed, e.g. during shutdown) the returned promise rejects and surfaces as an
  // unhandledRejection, which server.ts treats as fatal. Swallow + log (throttled) instead.
  const guard = (client: Redis, methods: string[], label: string) => {
    for (const method of methods) {
      const holder = client as unknown as Record<string, (...args: unknown[]) => unknown>;
      const raw = holder[method].bind(client);
      holder[method] = (...args: unknown[]) => {
        const result = raw(...args);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          return (result as Promise<unknown>).catch((error: Error) => {
            once(`${label}:${method}`, () => logger.error('redis_command_failed', error, { command: method, client: label, target }));
            return 0;
          });
        }
        return result;
      };
    }
  };
  guard(pub, ['publish'], 'pub');
  guard(sub, ['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe'], 'sub');

  io.adapter(createAdapter(pub, sub));

  // Give the connections a moment so the first events after boot are not dropped, but do not block
  // startup on Redis: if it is down, keep going and let ioredis retry.
  const ready = Promise.all([
    pub.status === 'ready' ? Promise.resolve() : new Promise<void>((r) => pub.once('ready', () => r())),
    sub.status === 'ready' ? Promise.resolve() : new Promise<void>((r) => sub.once('ready', () => r())),
  ]);
  const timedOut = await Promise.race([
    ready.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), READY_WAIT_MS)),
  ]);
  if (timedOut) {
    logger.warn('redis_not_ready_at_boot', {
      target,
      note: 'serving anyway; cross-instance delivery starts once Redis connects',
    });
  }

  return {
    isReady: () => pub.status === 'ready' && sub.status === 'ready',
    async close() {
      // quit() sends QUIT after queued commands, so in-flight publishes are flushed first. If Redis is
      // unreachable the QUIT can never be delivered: do not wait for it for more than a second.
      await Promise.race([
        Promise.allSettled([pub.quit(), sub.quit()]),
        new Promise<void>((r) => setTimeout(r, 1000)),
      ]);
      pub.disconnect();
      sub.disconnect();
    },
  };
}
