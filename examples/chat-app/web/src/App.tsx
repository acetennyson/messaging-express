import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { login, loadSession, makeConnection, saveSession, setupPrivacy, type Privacy, type Session } from './api';
import { Sidebar } from './Sidebar';
import { Thread } from './Thread';
import { NewChat } from './NewChat';
import { Lock } from './Icons';
import { addAnnounced, creatorOf, getAnnounced, markSeen, membersOf, titleOf, type Conv } from './util';
import { isPrivate, toView } from './view';

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  if (!session) return <Login onDone={(s) => { saveSession(s); setSession(s); }} />;
  return <Chat key={session.user.id} session={session} onSignOut={() => { saveSession(null); setSession(null); }} />;
}

function Login({ onDone }: { onDone: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { onDone(await login(name)); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <Mark />
        <h1>Postbox</h1>
        <p className="login-lead">A small chat app built on Messaging Express. Pick a name to sign in. If it is new, it creates a user.</p>
        <label htmlFor="name">Your name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" autoFocus autoComplete="off" />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || name.trim().length < 2}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="fine">Demo sign-in: anyone can use any name. Replace it with your own login before you ship.</p>
      </form>
    </main>
  );
}

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" /><path d="M8 11h16v10H8z" fill="none" stroke="#FBFCFE" strokeWidth="2" /><path d="M8 11l8 6 8-6" fill="none" stroke="#D6402D" strokeWidth="2" /></svg>
  );
}

function Chat({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const me = session.user;
  const conn = useMemo(() => makeConnection(session), [session]);
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [online, setOnline] = useState(true);
  const [privacy, setPrivacy] = useState<Privacy>('checking');
  const [alerts, setAlerts] = useState<Array<{ id: string; text: string }>>([]);
  const joined = useRef(new Set<string>());
  const convsRef = useRef<Conv[] | null>(null);
  convsRef.current = convs;

  useEffect(() => { void setupPrivacy(conn).then(setPrivacy); }, [conn]);

  const newest = (a: Conv, b: Conv) => (b.last?.created_at ?? b.row.created_at).localeCompare(a.last?.created_at ?? a.row.created_at);

  const refresh = useCallback(async () => {
    try {
      const { data } = await conn.client.conversations.list({ userId: me.id, limit: 100 });
      const withLast = await Promise.all(data.map(async (row) => {
        const page = await conn.client.messages.list({ conversationId: row.id, limit: 1 });
        const last = (await toView(conn, isPrivate(row), page.data))[0] ?? null;
        return { row, last } as Conv;
      }));
      withLast.sort(newest);
      setConvs(withLast); setLoadError('');
    } catch (err) { setLoadError((err as Error).message || 'Could not load your chats.'); }
  }, [conn, me.id]);

  useEffect(() => { void refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  // Everyone in a private chat is told: a notice for each private chat someone else made, shown once.
  useEffect(() => {
    if (!convs) return;
    const seen = new Set(getAnnounced(me.id));
    const fresh = convs.filter((c) => isPrivate(c.row) && !seen.has(c.row.id));
    if (!fresh.length) return;
    addAnnounced(me.id, fresh.map((c) => c.row.id));
    const others = fresh.filter((c) => creatorOf(c.row) !== me.id);
    setAlerts((cur) => [...cur, ...others.map((c) => {
      const by = membersOf(c.row).find((m) => m.id === creatorOf(c.row))?.name ?? 'Someone';
      return { id: c.row.id, text: `${by} started a private chat with you${c.row.type === 'group' ? ` (${titleOf(c.row, me.id)})` : ''}. Everything in it is end-to-end encrypted.` };
    })]);
  }, [convs, me.id]);

  useEffect(() => {
    const rt = conn.realtime;
    const offStatus = rt.onStatusChange((s, info) => { setOnline(s === 'connected'); if (info.reconnected) void refresh(); });
    const offMsg = rt.on('message.created', async (m) => {
      const known = convsRef.current?.find((c) => c.row.id === m.conversation_id);
      if (!known) { void refresh(); return; }
      const [last] = await toView(conn, isPrivate(known.row), [m]);
      setConvs((cur) => cur && cur.map((c) => (c.row.id === m.conversation_id ? { ...c, last: last! } : c)).sort(newest));
    });
    rt.connect().catch(() => setOnline(false));
    return () => { offStatus(); offMsg(); rt.disconnect(); joined.current.clear(); };
  }, [conn, refresh]);

  useEffect(() => {
    for (const c of convs ?? []) {
      if (joined.current.has(c.row.id)) continue;
      joined.current.add(c.row.id);
      conn.realtime.joinConversation(c.row.id).catch(() => joined.current.delete(c.row.id));
    }
  }, [convs, conn]);

  const current = convs?.find((c) => c.row.id === selected) ?? null;
  useEffect(() => { if (current?.last) markSeen(me.id, current.row.id, current.last.created_at); }, [current?.last?.id, current?.row.id, me.id]);

  const open = (id: string) => { setSelected(id); setCreating(false); setAlerts((a) => a.filter((x) => x.id !== id)); };
  return (
    <div className={`app ${current ? 'has-thread' : ''}`}>
      <Sidebar me={me} convs={convs} loadError={loadError} selected={selected} online={online} onOpen={open} onNew={() => setCreating(true)} onSignOut={onSignOut} onRetry={refresh} />
      <main className="stage">
        {current ? (
          <Thread key={current.row.id} conn={conn} me={me} conv={current} onBack={() => setSelected(null)} />
        ) : (
          <div className="stage-empty">
            <Mark />
            <h2>{convs && convs.length === 0 ? 'No chats yet' : 'Pick a chat'}</h2>
            <p>{convs && convs.length === 0 ? 'Start one with someone who has signed in.' : 'Your messages show up here.'}</p>
            <button className="primary" onClick={() => setCreating(true)}>New chat</button>
          </div>
        )}
      </main>
      {alerts.length > 0 && (
        <div className="toasts" role="status" aria-live="polite">
          {alerts.map((a) => (
            <div className="toast" key={a.id}>
              <Lock /><p>{a.text}</p>
              <button className="ghost" onClick={() => open(a.id)}>Open</button>
              <button className="ghost" aria-label="Dismiss" onClick={() => setAlerts((cur) => cur.filter((x) => x.id !== a.id))}>×</button>
            </div>
          ))}
        </div>
      )}
      {creating && <NewChat conn={conn} me={me} convs={convs ?? []} privacy={privacy} onClose={() => setCreating(false)} onCreated={async (id) => { await refresh(); open(id); }} />}
    </div>
  );
}
