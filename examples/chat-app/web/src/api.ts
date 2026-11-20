import { createClient } from '@messaging-express/client';
import { createRealtime } from '@messaging-express/client/realtime';
import { withCrypto, scopedKeyStore } from '@messaging-express/client-crypto';
import { indexedDbKeyStore } from '@messaging-express/client-crypto/stores/indexeddb';

export interface Session { user: { id: string; name: string }; token: string }
const KEY = 'postbox-session';

export function loadSession(): Session | null {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : null; } catch { return null; }
}
export function saveSession(s: Session | null) {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage blocked: the session lasts until reload */ }
}

export async function login(name: string): Promise<Session> {
  const res = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not sign in.');
  return body as Session;
}

const expiresSoon = (token: string) => {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 - Date.now() < 60_000; } catch { return true; }
};

/** One place that owns the token: reuses it, and signs in again (demo login) shortly before it expires. */
export function makeConnection(session: Session) {
  let current = session;
  const token = async () => {
    if (expiresSoon(current.token)) { current = await login(current.user.name); saveSession(current); }
    return current.token;
  };
  const baseUrl = `${location.origin}/chat`;
  // Keys for private chats live in this browser's IndexedDB, one store per user and server. They never leave it.
  const client = withCrypto(createClient({ baseUrl, token }), {
    keyStore: scopedKeyStore(indexedDbKeyStore(), { baseUrl, userId: session.user.id }),
    userId: session.user.id,
  });
  const realtime = createRealtime({ baseUrl: location.origin, path: '/chat/socket.io', token });
  return { client, realtime };
}
export type Connection = ReturnType<typeof makeConnection>;

/** Can this browser do private chats? It needs a device key registered for this user, held here. */
export type Privacy = 'checking' | 'ready' | 'other-device' | 'unsupported';
export async function setupPrivacy(conn: Connection): Promise<Privacy> {
  const dev = conn.client.crypto.device!;
  try {
    let state = await dev.state();
    if (state === 'primary' || state === 'companion') {
      try { await dev.listDevices(); } catch { /* revoked or reset on the server: state is wiped, handled below */ }
      state = await dev.state();
    }
    if (state === 'companion') return 'ready';
    if (state !== 'primary') await dev.registerPrimaryDevice({ deviceName: 'This browser' });
    return 'ready';
  } catch (e) {
    return (e as { code?: string }).code === 'DEVICE_EXISTS' ? 'other-device' : 'unsupported';
  }
}
