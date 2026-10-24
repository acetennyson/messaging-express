import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { verifyToken, type JWTPayload } from '../../auth/jwt';
import { loadActiveProject } from '../../auth/project';
import { query } from '../../db/pool';
import { logger } from '../../logger';
import type { RealtimeEvent, RealtimeProvider } from '../types';

/**
 * Socket.IO realtime provider (Implementation Plan, Stage 5.3, Path A).
 *
 * WIRE CONTRACT (what the SDK, SDK-3, relies on; do not change without coordinating):
 *   handshake        io(url, { auth: { token } })  -- the same JWT the REST API uses
 *   join             emit('join-conversation',  { conversationId }, ack)  ack: { ok: true } | { ok: false, code }
 *   leave            emit('leave-conversation', { conversationId }, ack)
 *   server -> client the event is emitted under its own name: 'message.created', ...,
 *                    with the event data as the payload; clients in room `conversation:<id>` get it.
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
  type: JWTPayload['type'];
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

function allowedOrigins(): string | string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS || '*';
  return raw === '*' ? '*' : raw.split(',').map((o) => o.trim()).filter(Boolean);
}

/** Create the Socket.IO server on `httpServer` and install authentication + room handlers. */
export function createSocketIoServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins() },
    serveClient: false,
    // engine.io's default destroys upgrade requests for paths that are not /socket.io after 1s
    // when nobody has answered. Next's dev HMR websocket (and any other upgrade handler on this
    // server) must be left alone, so do not destroy them.
    destroyUpgrade: false,
  });

  // ---- Handshake: same JWT as REST, project must be active (shared query) ----
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token === '') {
      return next(authError('AUTH_REQUIRED', 'Missing authentication token'));
    }

    let payload: JWTPayload;
    try {
      payload = verifyToken(token);
    } catch {
      return next(authError('INVALID_TOKEN', 'Invalid or expired token'));
    }

    try {
      await loadActiveProject(payload.projectId);
    } catch {
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

  io.on('connection', (socket) => registerHandlers(socket));
  return io;
}

function registerHandlers(socket: Socket): void {
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

      // The conversation must belong to THIS project and the user must be a participant.
      // "Not found" and "not a participant" answer identically, so ids cannot be probed.
      const result = await query(
        `SELECT 1
         FROM mx_conversation_participants cp
         JOIN mx_conversations c ON c.id = cp.conversation_id
         WHERE cp.conversation_id = $1 AND cp.user_id = $2 AND c.project_id = $3`,
        [conversationId, data.userId, data.projectId]
      );
      if (result.rows.length === 0) return reply(ack, { ok: false, code: 'FORBIDDEN' });

      await socket.join(roomFor(conversationId));
      reply(ack, { ok: true });
    } catch (error) {
      logger.error('realtime_join_failed', error, { projectId: data.projectId, userId: data.userId });
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
      logger.error('realtime_leave_failed', error, { projectId: data.projectId });
      reply(ack, { ok: false, code: 'INTERNAL_ERROR' });
    }
  });
}

/** Adapt a Socket.IO server to the RealtimeProvider interface used by emitEvent. */
export function createSocketIoProvider(io: Server): RealtimeProvider {
  return {
    stats(): Record<string, number> {
      let conversationRooms = 0;
      for (const room of io.of('/').adapter.rooms.keys()) {
        if (room.startsWith('conversation:')) conversationRooms += 1;
      }
      return { sockets: io.of('/').sockets.size, conversationRooms };
    },
    // `conversation:<id>` room; clients listen for the event under its own name.
    async publish(channel: string, event: RealtimeEvent): Promise<void> {
      io.to(channel).emit(event.type, event.data);
    },
    // Graceful shutdown: disconnects every socket (clients reconnect, landing on another
    // instance) and closes the engine. Deliberately does NOT wait for the HTTP server to finish
    // closing (io.close's callback does): that is server.ts's job, and a raw upgraded socket
    // that nobody answers would otherwise block shutdown until the forced timeout.
    async close(): Promise<void> {
      io.disconnectSockets(true);
      // io.close() resolves only once the HTTP server has fully closed, so do not await it
      // outright; give it a moment to close the engine and every websocket, then move on.
      const closing = io.close().catch(() => {});
      await Promise.race([closing, new Promise<void>((r) => setTimeout(r, 250))]);
    },
  };
}
