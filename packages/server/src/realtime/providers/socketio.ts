import type { Server as HttpServer } from 'http';
import { Server, type Namespace, type Socket } from 'socket.io';
import type { AuthContext } from '../../auth/strategy';
import { AuthError } from '../../errors';
import type { ServerContext } from '../../core/context';
import type { RealtimeEvent, RealtimeProvider } from '../types';
import { userChannel } from '../channels';
import { authorizeJoin } from '../authorize';
import type { RedisAttachment } from './redis';

/**
 * Socket.IO realtime provider (Implementation Plan, Stage 5.3, Path A).
 *
 * WIRE CONTRACT (what the SDK, SDK-3, relies on; do not change without coordinating):
 *   handshake        io(url, { auth: { token } })  -- the same JWT the REST API uses
 *   join             emit('join-conversation',  { conversationId }, ack)  ack: { ok: true } | { ok: false, code }
 *   leave            emit('leave-conversation', { conversationId }, ack)
 *   server -> client the event is emitted under its own name: 'message.created', ...,
 *                    with the event data as the payload; clients in room `conversation:<id>` get it.
 *   user room        (E2EE, additive) after a verified handshake whose token has a userId, the socket auto-joins
 *                    room `user:<userId>`. No client event is involved, so there is no new authorization surface.
 *                    Server events sent there: device.added, device.removed, keys.updated, keys.requested,
 *                    participant.added, participant.removed (payload = the event data, like message.created).
 *   ack codes        INVALID_PAYLOAD | FORBIDDEN | RATE_LIMITED | INTERNAL_ERROR
 *   connect errors   err.data.code: AUTH_REQUIRED | INVALID_TOKEN | PROJECT_INACTIVE
 *
 * This file is only ever loaded by server.ts (dynamically, after Next loaded the env files),
 * never from a route bundle.
 */

export const JOIN_LIMIT = 20; // join/leave attempts ...
export const JOIN_WINDOW_MS = 10_000; // ... per socket per window (stops conversation-id probing)

interface SocketData {
  projectId: string;
  userId?: string;
  type: AuthContext['type'];
}

type Ack = (response: { ok: boolean; code?: string }) => void;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIMER_MS = 2 ** 31 - 1;

function authError(code: string, message: string): Error {
  const err = new Error(message) as Error & { data: { code: string } };
  err.data = { code };
  return err;
}

export function roomFor(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function allowedOrigins(ctx: ServerContext): string | string[] {
  const raw = ctx.config.corsAllowedOrigins;
  return raw === '*' ? '*' : raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export interface SocketIoOptions {
  /** Engine.IO path. Default "/socket.io" (the hosted server). */
  path?: string;
  /** When it returns true, new handshakes are refused (the embedded module is shutting down). */
  isClosed?: () => boolean;
}

/** Create the Socket.IO server on `httpServer` and install authentication + room handlers. */
export function createSocketIoServer(httpServer: HttpServer, ctx: ServerContext, options: SocketIoOptions = {}): Server {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins(ctx) },
    serveClient: false,
    ...(options.path ? { path: options.path } : {}),
    // engine.io's default destroys upgrade requests for paths that are not /socket.io after 1s
    // when nobody has answered. Next's dev HMR websocket (and any other upgrade handler on this
    // server) must be left alone, so do not destroy them.
    destroyUpgrade: false,
  });
  installSocketIo(io, ctx, options);
  return io;
}

/**
 * Install the handshake check and room handlers on a Socket.IO server or namespace. For a server we create this is the
 * default namespace (the wire contract above); for a borrowed server it is a dedicated namespace, so the customer's own
 * sockets never meet our authentication.
 */
export function installSocketIo(target: Server | Namespace, ctx: ServerContext, options: SocketIoOptions = {}): void {
  const io = target;

  // ---- Handshake: same JWT as REST, project must be active (shared query) ----
  io.use(async (socket, next) => {
    if (options.isClosed?.()) return next(authError('SERVER_CLOSING', 'The server is shutting down'));
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token === '') {
      return next(authError('AUTH_REQUIRED', 'Missing authentication token'));
    }

    let payload: AuthContext;
    try {
      payload = await ctx.auth.authenticateToken(ctx, token);
    } catch (error) {
      if (error instanceof AuthError && error.reason === 'invalid_token') {
        return next(authError('INVALID_TOKEN', 'Invalid or expired token'));
      }
      return next(authError('PROJECT_INACTIVE', 'Project not found or inactive'));
    }

    const data: SocketData = { projectId: payload.projectId, userId: payload.userId, type: payload.type };
    socket.data = data;

    // A socket must not outlive its token: disconnect at expiry; the client reconnects and its
    // `auth` callback supplies a fresh token (SDK-3).
    if (payload.exp) {
      const ms = Math.min(MAX_TIMER_MS, Math.max(0, payload.exp * 1000 - Date.now()));
      const timer = setTimeout(() => socket.disconnect(true), ms);
      timer.unref();
      socket.once('disconnect', () => clearTimeout(timer));
    }
    next();
  });

  io.on('connection', async (socket) => {
    // The room name comes from the verified token, never from the client. Joined before handlers are registered so
    // an event published right after connect is not missed.
    const userId = (socket.data as SocketData).userId;
    if (userId) {
      try {
        await socket.join(userChannel(userId));
      } catch (error) {
        ctx.logger.error('realtime_user_room_join_failed', error, { userId });
      }
    }
    registerHandlers(socket, ctx);
  });
}

function registerHandlers(socket: Socket, ctx: ServerContext): void {
  const data = socket.data as SocketData;
  let windowStart = Date.now();
  let attempts = 0;

  /** In-memory per-socket limiter for join/leave. Returns true when the call may proceed. */
  const withinLimit = (): boolean => {
    const now = Date.now();
    if (now - windowStart >= JOIN_WINDOW_MS) {
      windowStart = now;
      attempts = 0;
    }
    attempts += 1;
    return attempts <= JOIN_LIMIT;
  };

  const reply = (ack: unknown, response: { ok: boolean; code?: string }) => {
    if (typeof ack === 'function') (ack as Ack)(response);
  };

  const conversationIdFrom = (payload: unknown): string | null => {
    const id = (payload as { conversationId?: unknown } | null)?.conversationId;
    return typeof id === 'string' && UUID_RE.test(id) ? id : null;
  };

  socket.on('join-conversation', async (payload: unknown, ack: unknown) => {
    try {
      if (!withinLimit()) return reply(ack, { ok: false, code: 'RATE_LIMITED' });

      const conversationId = conversationIdFrom(payload);
      if (!conversationId) return reply(ack, { ok: false, code: 'INVALID_PAYLOAD' });

      // Only end users (tokens with a userId) can be participants.
      if (!data.userId) return reply(ack, { ok: false, code: 'FORBIDDEN' });

      // The conversation must belong to THIS project and the user must be a participant (shared with chat.authorizeJoin).
      // "Not found" and "not a participant" answer identically, so ids cannot be probed.
      if (!(await authorizeJoin(ctx, data.projectId, data.userId, conversationId))) return reply(ack, { ok: false, code: 'FORBIDDEN' });

      await socket.join(roomFor(conversationId));
      reply(ack, { ok: true });
    } catch (error) {
      ctx.logger.error('realtime_join_failed', error, { projectId: data.projectId, userId: data.userId });
      reply(ack, { ok: false, code: 'INTERNAL_ERROR' });
    }
  });

  socket.on('leave-conversation', async (payload: unknown, ack: unknown) => {
    try {
      if (!withinLimit()) return reply(ack, { ok: false, code: 'RATE_LIMITED' });
      const conversationId = conversationIdFrom(payload);
      if (!conversationId) return reply(ack, { ok: false, code: 'INVALID_PAYLOAD' });
      await socket.leave(roomFor(conversationId));
      reply(ack, { ok: true });
    } catch (error) {
      ctx.logger.error('realtime_leave_failed', error, { projectId: data.projectId });
      reply(ack, { ok: false, code: 'INTERNAL_ERROR' });
    }
  });
}

/**
 * Adapt a Socket.IO server (or a namespace of one) to the RealtimeProvider interface used by emitEvent.
 * `owned: false` (a borrowed server): close() only disconnects OUR namespace's sockets; it never closes the customer's
 * Socket.IO server or http server (decision D10).
 */
export function createSocketIoProvider(io: Server | Namespace, options: { redis?: RedisAttachment | null; owned?: boolean; closeEngine?: boolean } = {}): RealtimeProvider {
  const redis = options.redis ?? null;
  const owned = options.owned !== false;
  const nsp: Namespace = io instanceof Server ? io.of('/') : io;
  return {
    stats(): Record<string, number> {
      let conversationRooms = 0;
      for (const room of nsp.adapter.rooms.keys()) {
        if (room.startsWith('conversation:')) conversationRooms += 1;
      }
      return {
        sockets: nsp.sockets.size,
        conversationRooms,
        ...(redis ? { redisReady: redis.isReady() ? 1 : 0 } : {}),
      };
    },
    // Cluster-wide with the Redis adapter (fetchSockets and RemoteSocket.leave go through it).
    async evictUser(channel: string, userId: string): Promise<void> {
      for (const s of await nsp.in(channel).fetchSockets()) {
        if ((s.data as SocketData | undefined)?.userId === userId) s.leave(channel);
      }
    },
    // `conversation:<id>` room; clients listen for the event under its own name.
    async publish(channel: string, event: RealtimeEvent): Promise<void> {
      nsp.to(channel).emit(event.type, event.data);
    },
    // Graceful shutdown: disconnects THIS instance's sockets (clients reconnect, landing on another
    // instance) and closes the engine. Deliberately does NOT wait for the HTTP server to finish
    // closing (io.close's callback does): that is server.ts's job, and a raw upgraded socket
    // that nobody answers would otherwise block shutdown until the forced timeout.
    async close(): Promise<void> {
      // `.local`: with the Redis adapter a plain disconnectSockets() is a CLUSTER-WIDE broadcast and
      // would kick every client on every other instance when one instance shuts down.
      nsp.local.disconnectSockets(true);
      if (owned && io instanceof Server) {
        if (options.closeEngine) {
          // Embedded: io.close() would also close the CUSTOMER's http server. Close only the engine (its clients).
          io.engine.close();
        } else {
          // io.close() resolves only once the HTTP server has fully closed, so do not await it
          // outright; give it a moment to close the engine and every websocket, then move on.
          const closing = io.close().catch(() => {});
          await Promise.race([closing, new Promise<void>((r) => setTimeout(r, 250))]);
        }
      }
      await redis?.close();
    },
  };
}
