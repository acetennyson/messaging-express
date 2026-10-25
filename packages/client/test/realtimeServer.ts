import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';

/**
 * A miniature server that speaks the documented wire contract of lib/realtime/providers/socketio.ts
 * (handshake errors, join/leave acks, rooms named conversation:<id>). Tokens are fake: "user:<id>" is valid,
 * "inactive" is a deactivated project, anything else is invalid. The REAL server is exercised by
 * scripts/test-sdk-realtime.mjs against a running instance.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MiniServer {
  io: Server;
  port: number;
  url: string;
  /** conversationId -> userIds allowed to join. Share it between restarts to keep the "database". */
  members: Map<string, Set<string>>;
  /** tokens seen in handshakes, in order */
  handshakes: string[];
  /** Set `.code` to make every later handshake fail with it (what an expired token looks like). */
  reject: { code?: string };
  close(): Promise<void>;
}

export async function startMiniServer(opts: { port?: number; members?: Map<string, Set<string>>; rateLimitFirstJoins?: number } = {}): Promise<MiniServer> {
  const members = opts.members ?? new Map<string, Set<string>>();
  const handshakes: string[] = [];
  const reject: { code?: string } = {};
  const httpServer = http.createServer();
  const io = new Server(httpServer, { serveClient: false });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const fail = (code: string) => {
      const err = new Error(code) as Error & { data: { code: string } };
      err.data = { code };
      next(err);
    };
    if (typeof token !== 'string' || token === '') return fail('AUTH_REQUIRED');
    handshakes.push(token);
    if (reject.code) return fail(reject.code);
    if (token === 'inactive') return fail('PROJECT_INACTIVE');
    if (!token.startsWith('user:')) return fail('INVALID_TOKEN');
    socket.data.userId = token.slice(5);
    next();
  });

  io.on('connection', (socket) => {
    let limited = opts.rateLimitFirstJoins ?? 0;
    socket.on('join-conversation', (payload: { conversationId?: string } | null, ack?: (r: object) => void) => {
      const id = payload?.conversationId;
      if (limited > 0) { limited -= 1; return ack?.({ ok: false, code: 'RATE_LIMITED' }); }
      if (typeof id !== 'string' || !UUID_RE.test(id)) return ack?.({ ok: false, code: 'INVALID_PAYLOAD' });
      if (!members.get(id)?.has(socket.data.userId)) return ack?.({ ok: false, code: 'FORBIDDEN' });
      socket.join(`conversation:${id}`);
      ack?.({ ok: true });
    });
    socket.on('leave-conversation', (payload: { conversationId?: string } | null, ack?: (r: object) => void) => {
      const id = payload?.conversationId;
      if (typeof id !== 'string' || !UUID_RE.test(id)) return ack?.({ ok: false, code: 'INVALID_PAYLOAD' });
      socket.leave(`conversation:${id}`);
      ack?.({ ok: true });
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    io,
    port,
    url: `http://127.0.0.1:${port}`,
    members,
    handshakes,
    reject,
    close: () => new Promise<void>((resolve) => { io.local.disconnectSockets(true); io.close(() => resolve()); setTimeout(resolve, 500); }),
  };
}
