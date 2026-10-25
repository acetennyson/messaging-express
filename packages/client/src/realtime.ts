import type { Socket } from 'socket.io-client';
import type { Message, TokenSource } from './types';

/**
 * Realtime (SDK-3): `import { createRealtime } from '@messaging-express/client/realtime'`.
 *
 * Lives in its own entry point on purpose: it needs `socket.io-client`, an OPTIONAL peer dependency.
 * Customers who only use REST never import this file, so their bundler never has to resolve it.
 *
 * Wire contract (server: lib/realtime/providers/socketio.ts):
 *   handshake   auth: { token }                          rejected with err.data.code AUTH_REQUIRED | INVALID_TOKEN | PROJECT_INACTIVE
 *   join/leave  emit('join-conversation' | 'leave-conversation', { conversationId }, ack)   ack { ok } | { ok:false, code }
 *   events      the server emits each event under its own name ('message.created') with the data as payload
 */

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * `code` is one of the server's codes (AUTH_REQUIRED, INVALID_TOKEN, PROJECT_INACTIVE, INVALID_PAYLOAD, FORBIDDEN,
 * RATE_LIMITED, INTERNAL_ERROR) or one of the SDK's own: NOT_CONNECTED, CLOSED, TIMEOUT, CONNECT_FAILED,
 * TOKEN_ERROR, HANDLER_ERROR, SOCKET_IO_MISSING.
 */
export class RealtimeError extends Error {
  readonly code: string;
  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = 'RealtimeError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Events the server publishes to conversation rooms today. (Other event names still work through the untyped `on` overload.) */
export interface RealtimeEventMap {
  'message.created': Message;
}

export interface RealtimeOptions {
  /** Origin of the API, e.g. "https://api.example.com". Optional only in a browser (same origin). */
  baseUrl?: string;
  /** A JWT of an END USER (it must carry a userId to join conversations), or a function returning one. The function is called on EVERY (re)connect, so refreshed tokens just work. */
  token: TokenSource;
  /** Socket.IO path. Default "/socket.io". */
  path?: string;
  /** Default ["websocket"]: no HTTP long-polling fallback, so no sticky sessions are needed behind a load balancer. */
  transports?: Array<'websocket' | 'polling'>;
  /** First reconnect delay, doubling up to `reconnectionDelayMaxMs`. Default 1000. */
  reconnectionDelayMs?: number;
  /** Default 30000. */
  reconnectionDelayMaxMs?: number;
  /** How long to wait for the server's answer to a join/leave, and for a reconnect before `joinConversation` gives up. Default 10000. */
  ackTimeoutMs?: number;
  /** Wait between rejoin retries when the server answers RATE_LIMITED (it allows 20 join/leave per 10 s per socket). Default 2000. */
  rateLimitRetryMs?: number;
}

export interface StatusInfo {
  /** Set when the status is `connected` again after a drop: events that arrived while offline are NOT replayed, so refetch what you display. */
  reconnected?: boolean;
  /** Why the status became `closed` or `reconnecting`, when there is an error behind it. */
  error?: RealtimeError;
}

export interface Realtime {
  readonly status: RealtimeStatus;
  /** Opens the connection. Resolves once connected; rejects (and stays closed) if the FIRST attempt fails. After that it reconnects by itself. */
  connect(): Promise<void>;
  /** Joins a conversation room. Rejects with FORBIDDEN if the user is not a participant. Re-joined automatically after every reconnect. */
  joinConversation(conversationId: string): Promise<void>;
  leaveConversation(conversationId: string): Promise<void>;
  /** Subscribe to a server event. Returns the unsubscribe function. */
  on<K extends keyof RealtimeEventMap>(event: K, handler: (data: RealtimeEventMap[K]) => void): () => void;
  on(event: string, handler: (data: unknown) => void): () => void;
  onStatusChange(listener: (status: RealtimeStatus, info: StatusInfo) => void): () => void;
  /** Non-fatal problems: a conversation that could not be rejoined, a failing token function, a throwing handler. */
  onError(listener: (error: RealtimeError) => void): () => void;
  /** Closes the connection and forgets the joined conversations. */
  disconnect(): void;
}

const RESERVED_EVENTS = new Set(['connect', 'disconnect', 'connect_error']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type IoFn = typeof import('socket.io-client').io;
type AnyHandler = (data: unknown) => void;

async function loadIo(): Promise<IoFn> {
  try {
    return (await import('socket.io-client')).io;
  } catch (cause) {
    throw new RealtimeError(
      'Realtime needs the optional peer dependency "socket.io-client". Install it with: npm i socket.io-client',
      'SOCKET_IO_MISSING',
      cause
    );
  }
}

function fromConnectError(err: unknown): RealtimeError {
  const e = err as { message?: string; data?: { code?: string } } | undefined;
  const code = e?.data?.code;
  return new RealtimeError(e?.message || 'Could not connect', code ?? 'CONNECT_FAILED', err);
}

export function createRealtime(options: RealtimeOptions): Realtime {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl && typeof location === 'undefined') {
    throw new TypeError('createRealtime: "baseUrl" is required outside a browser');
  }
  if (options.token === undefined || options.token === null || options.token === '') {
    throw new TypeError('createRealtime: "token" is required (a JWT string or a function returning one)');
  }
  const delayMs = options.reconnectionDelayMs ?? 1000;
  const delayMaxMs = options.reconnectionDelayMaxMs ?? 30_000;
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  const rateLimitRetryMs = options.rateLimitRetryMs ?? 2000;
  const staticToken = typeof options.token === 'string';

  let socket: Socket | null = null;
  let status: RealtimeStatus = 'idle';
  let generation = 0; // bumped whenever a socket is dropped, so late callbacks of the old one are ignored
  let everConnected = false;
  let initial: { resolve: () => void; reject: (e: RealtimeError) => void } | null = null;
  let connectPromise: Promise<void> | null = null;
  let manualTimer: ReturnType<typeof setTimeout> | null = null;
  let manualAttempt = 0;

  const joined = new Set<string>();
  const handlers = new Map<string, Set<AnyHandler>>();
  const dispatchers = new Map<string, AnyHandler>();
  const statusListeners = new Set<(s: RealtimeStatus, i: StatusInfo) => void>();
  const errorListeners = new Set<(e: RealtimeError) => void>();
  const waiters = new Set<{ resolve: () => void; reject: (e: RealtimeError) => void; timer: ReturnType<typeof setTimeout> }>();

  const emitError = (error: RealtimeError) => {
    for (const l of [...errorListeners]) {
      try {
        l(error);
      } catch {
        /* a throwing listener must not break the others */
      }
    }
  };

  const setStatus = (next: RealtimeStatus, info: StatusInfo = {}) => {
    if (status === next && !info.reconnected) return;
    status = next;
    if (next === 'connected') for (const w of [...waiters]) { clearTimeout(w.timer); waiters.delete(w); w.resolve(); }
    for (const l of [...statusListeners]) {
      try {
        l(next, info);
      } catch {
        /* ignore */
      }
    }
  };

  const rejectWaiters = (error: RealtimeError) => {
    for (const w of [...waiters]) { clearTimeout(w.timer); waiters.delete(w); w.reject(error); }
  };

  const dispatcherFor = (event: string): AnyHandler => {
    let d = dispatchers.get(event);
    if (!d) {
      d = (data) => {
        for (const h of [...(handlers.get(event) ?? [])]) {
          try {
            h(data);
          } catch (cause) {
            emitError(new RealtimeError(`A "${event}" handler threw`, 'HANDLER_ERROR', cause));
          }
        }
      };
      dispatchers.set(event, d);
    }
    return d;
  };

  /** Stop everything about the current socket. */
  const teardown = () => {
    generation += 1;
    if (manualTimer) clearTimeout(manualTimer);
    manualTimer = null;
    manualAttempt = 0;
    const s = socket;
    socket = null;
    s?.close();
    everConnected = false;
    connectPromise = null;
    initial = null;
  };

  const closeWith = (error?: RealtimeError) => {
    const pending = initial;
    teardown();
    joined.clear();
    setStatus('closed', { error });
    const err = error ?? new RealtimeError('Realtime was closed', 'CLOSED');
    rejectWaiters(err);
    pending?.reject(err);
    if (error) emitError(error);
  };

  const scheduleManualReconnect = (gen: number, first: boolean) => {
    if (manualTimer) return;
    const base = first ? 250 : Math.min(delayMaxMs, delayMs * 2 ** manualAttempt);
    manualAttempt += 1;
    const wait = base + Math.floor(Math.random() * Math.min(100, base));
    manualTimer = setTimeout(() => {
      manualTimer = null;
      if (gen !== generation || !socket) return;
      socket.connect(); // Socket.IO does not reconnect by itself after a server-side disconnect or a rejected handshake
    }, wait);
  };

  function emitAck(event: 'join-conversation' | 'leave-conversation', conversationId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = socket;
      if (!s) return reject(new RealtimeError('Not connected', 'NOT_CONNECTED'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s.timeout(ackTimeoutMs) as any).emit(event, { conversationId }, (err: unknown, res?: { ok: boolean; code?: string }) => {
        if (err) return reject(new RealtimeError('The server did not answer in time', 'TIMEOUT', err));
        if (res?.ok) return resolve();
        const code = res?.code ?? 'UNKNOWN';
        reject(new RealtimeError(`${event} failed: ${code}`, code));
      });
    });
  }

  async function joinWithRetry(conversationId: string, gen: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await emitAck('join-conversation', conversationId);
      } catch (e) {
        const rateLimited = e instanceof RealtimeError && e.code === 'RATE_LIMITED';
        if (!rateLimited || attempt >= 8 || gen !== generation) throw e;
        await sleep(rateLimitRetryMs);
        if (gen !== generation) throw e;
      }
    }
  }

  async function rejoinAll(gen: number) {
    for (const id of [...joined]) {
      if (gen !== generation) return;
      try {
        await joinWithRetry(id, gen);
      } catch (e) {
        const code = e instanceof RealtimeError ? e.code : 'UNKNOWN';
        // Removed from the conversation (or an invalid id): stop trying. Anything else is retried at the next reconnect.
        if (code === 'FORBIDDEN' || code === 'INVALID_PAYLOAD') joined.delete(id);
        if (gen === generation) emitError(new RealtimeError(`Could not rejoin conversation ${id}: ${code}`, code, e));
      }
    }
  }

  function createSocket(io: IoFn): Socket {
    const gen = generation;
    const opts = {
      path: options.path,
      transports: options.transports ?? ['websocket'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: delayMs,
      reconnectionDelayMax: delayMaxMs,
      // Called on every (re)connect attempt: this is how a refreshed token reaches the server.
      auth: (cb: (data: object) => void) => {
        Promise.resolve()
          .then(() => (typeof options.token === 'function' ? options.token() : options.token))
          .then(
            (token) => cb({ token }),
            (cause) => {
              emitError(new RealtimeError('The token function threw', 'TOKEN_ERROR', cause));
              cb({});
            }
          );
      },
    };
    const s = baseUrl ? io(baseUrl, opts) : io(opts);

    s.on('connect', async () => {
      if (gen !== generation) return;
      manualAttempt = 0;
      if (manualTimer) clearTimeout(manualTimer);
      manualTimer = null;
      const reconnected = everConnected;
      everConnected = true;
      if (reconnected) {
        await rejoinAll(gen); // 'connected' is announced only once the rooms are back
        if (gen !== generation || !s.connected) return;
      }
      setStatus('connected', { reconnected });
      const pending = initial;
      initial = null;
      pending?.resolve();
    });

    s.on('disconnect', (reason: string) => {
      if (gen !== generation || reason === 'io client disconnect') return;
      setStatus('reconnecting');
      if (reason === 'io server disconnect') scheduleManualReconnect(gen, true); // e.g. the token expired
    });

    s.on('connect_error', (err: unknown) => {
      if (gen !== generation) return;
      const error = fromConnectError(err);
      if (!everConnected) return closeWith(error); // the first attempt failed: report it, do not retry in the background
      const rejected = (err as { data?: { code?: string } })?.data?.code !== undefined || s.active === false;
      if (!rejected) return; // network trouble: Socket.IO retries by itself
      // The server refused the handshake. A static token cannot get better; a token function may return a fresh one next time.
      const fatal = error.code === 'PROJECT_INACTIVE' || (staticToken && (error.code === 'INVALID_TOKEN' || error.code === 'AUTH_REQUIRED'));
      if (fatal) return closeWith(error);
      emitError(error);
      scheduleManualReconnect(gen, false);
    });

    for (const event of handlers.keys()) s.on(event, dispatcherFor(event));
    return s;
  }

  async function whenConnected(): Promise<void> {
    if (status === 'connected') return;
    if (status === 'connecting' || status === 'reconnecting') {
      return new Promise((resolve, reject) => {
        const w = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(w);
            reject(new RealtimeError('Still not connected', 'NOT_CONNECTED'));
          }, ackTimeoutMs),
        };
        waiters.add(w);
      });
    }
    throw new RealtimeError(status === 'closed' ? 'Realtime is closed: call connect() again' : 'Call connect() first', status === 'closed' ? 'CLOSED' : 'NOT_CONNECTED');
  }

  return {
    get status() {
      return status;
    },

    connect() {
      if (status === 'connected') return Promise.resolve();
      if (connectPromise) return connectPromise;
      if (status === 'reconnecting') return whenConnected();
      setStatus('connecting');
      connectPromise = new Promise<void>((resolve, reject) => {
        initial = { resolve, reject };
      });
      const gen = generation;
      loadIo().then(
        (io) => {
          if (gen !== generation) return; // disconnect() was called while the module loaded
          socket = createSocket(io);
          socket.connect();
        },
        (e: RealtimeError) => closeWith(e)
      );
      return connectPromise;
    },

    async joinConversation(conversationId) {
      await whenConnected();
      joined.add(conversationId); // before the ack, so a reconnect in between still restores it
      try {
        await emitAck('join-conversation', conversationId);
      } catch (e) {
        joined.delete(conversationId);
        throw e;
      }
    },

    async leaveConversation(conversationId) {
      joined.delete(conversationId); // forget it first: a reconnect must not bring it back
      if (status !== 'connected') return; // not in the room any more anyway
      await emitAck('leave-conversation', conversationId);
    },

    on(event: string, handler: AnyHandler) {
      if (RESERVED_EVENTS.has(event)) {
        throw new TypeError(`"${event}" is a connection event: use onStatusChange() instead of on("${event}")`);
      }
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler);
      if (socket && set.size === 1) socket.on(event, dispatcherFor(event));
      return () => {
        const current = handlers.get(event);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlers.delete(event);
          const d = dispatchers.get(event);
          if (d) socket?.off(event, d);
          dispatchers.delete(event);
        }
      };
    },

    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },

    onError(listener) {
      errorListeners.add(listener);
      return () => void errorListeners.delete(listener);
    },

    disconnect() {
      if (status === 'idle' && !socket) return;
      closeWith();
    },
  } as Realtime;
}
