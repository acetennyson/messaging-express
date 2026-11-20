import { useEffect, useState } from 'react';
import type { User } from '@messaging-express/client';
import type { Connection, Privacy } from './api';
import { Avatar } from './Avatar';
import { Lock } from './Icons';
import { membersOf, type Conv } from './util';
import { isPrivate } from './view';

interface Props { conn: Connection; me: { id: string; name: string }; convs: Conv[]; privacy: Privacy; onClose: () => void; onCreated: (id: string) => void }

const WHY: Record<Privacy, string> = {
  checking: 'Setting up this browser for private chats…',
  ready: '',
  'other-device': 'Your private-chat keys live on another browser or device. Linking a second device is not part of this demo yet.',
  unsupported: 'This browser cannot store the keys private chats need (storage is blocked or unavailable).',
};

export function NewChat({ conn, me, convs, privacy, onClose, onCreated }: Props) {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<User[] | null>(null);
  const [picked, setPicked] = useState<User[]>([]);
  const [title, setTitle] = useState('');
  const [priv, setPriv] = useState(false);
  const [ready, setReady] = useState<Set<string> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      conn.client.users.list({ search: search.trim() || undefined, limit: 50 })
        .then((p) => { setUsers(p.data.filter((u) => u.id !== me.id)); setError(''); })
        .catch((e) => setError((e as Error).message || 'Could not load people.'));
    }, 200);
    return () => clearTimeout(t);
  }, [conn, me.id, search]);

  // Private chats need every person to have a device key. Ask the server who does.
  useEffect(() => {
    if (!priv || !users?.length) return;
    let stop = false;
    conn.client.crypto.devices.list(users.map((u) => u.id))
      .then((d) => { if (!stop) setReady(new Set(d.map((x) => x.userId))); })
      .catch(() => { if (!stop) setReady(new Set()); });
    return () => { stop = true; };
  }, [conn, priv, users]);

  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const canPrivate = privacy === 'ready';
  const blocked = (u: User) => priv && ready !== null && !ready.has(u.id);
  const turnOn = (on: boolean) => { setPriv(on); setReady(null); if (!on) return; setPicked([]); };
  const toggle = (u: User) => setPicked((cur) => (cur.some((p) => p.id === u.id) ? cur.filter((p) => p.id !== u.id) : [...cur, u]));
  const isGroup = picked.length > 1;
  const nameOf = (u: User) => u.name || u.external_id || 'Someone';

  const create = async () => {
    setBusy(true); setError('');
    try {
      const members = [{ id: me.id, name: me.name }, ...picked.map((p) => ({ id: p.id, name: nameOf(p) }))];
      const metadata = { members, createdBy: me.id };
      if (!isGroup) {
        const other = picked[0]!;
        const existing = convs.find((c) => c.row.type === 'direct' && isPrivate(c.row) === priv && membersOf(c.row).some((m) => m.id === other.id));
        if (existing) return onCreated(existing.row.id);
      }
      const type = isGroup ? 'group' : 'direct';
      if (priv) {
        const secure = conn.client.crypto.secure!;
        const c = await secure.createSecureConversation({ participantIds: picked.map((p) => p.id), type, title: isGroup ? title.trim() : undefined, metadata });
        // The first message tells everyone, in the chat itself, that it is private. It is encrypted like the rest.
        await secure.sendSecureMessage({ conversationId: c.id, type: 'system', text: `${me.name} turned on private chat. Messages and files here are end-to-end encrypted.` }).catch(() => undefined);
        return onCreated(c.id);
      }
      const c = await conn.client.conversations.create({ type, title: isGroup ? title.trim() : undefined, participantIds: [me.id, ...picked.map((p) => p.id)], metadata });
      onCreated(c.id);
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: { userIds?: string[] } };
      setError(err.code === 'PARTICIPANT_HAS_NO_DEVICE' ? 'Someone in this chat has not set up private chats yet. They need to open Postbox once.' : err.message || 'Could not create the chat.');
      setBusy(false);
    }
  };

  const verb = isGroup ? `Create ${priv ? 'private ' : ''}group with ${picked.length}` : priv ? 'Start private chat' : 'Start chat';
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="nc-title">
        <header><h2 id="nc-title">New chat</h2><button className="ghost" onClick={onClose}>Close</button></header>
        <label className={`switch ${canPrivate ? '' : 'off'}`}>
          <input type="checkbox" role="switch" checked={priv} disabled={!canPrivate} onChange={(e) => turnOn(e.target.checked)} />
          <span className="switch-ui" aria-hidden="true" />
          <span className="switch-text">
            <strong><Lock size={14} /> Private chat <em>beta</em></strong>
            <small>{canPrivate ? 'End-to-end encrypted. Everyone in the chat is told it is private.' : WHY[privacy]}</small>
          </span>
        </label>
        <input className="search" placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <ul className="people">
          {users === null && !error && <li className="note">Loading people…</li>}
          {users?.length === 0 && <li className="note">{search ? `No one matches “${search}”.` : 'No one else has signed in yet. Open this app in another window and sign in with a different name.'}</li>}
          {users?.map((u) => {
            const on = picked.some((p) => p.id === u.id);
            const off = blocked(u);
            return (
              <li key={u.id}>
                <label className={`person ${on ? 'on' : ''} ${off ? 'disabled' : ''}`}>
                  <input type="checkbox" checked={on} disabled={off} onChange={() => toggle(u)} />
                  <Avatar name={nameOf(u)} size={34} /><span>{nameOf(u)}</span>
                  {off && <small>Has not set up private chats</small>}
                </label>
              </li>
            );
          })}
        </ul>
        {isGroup && <input className="search" placeholder="Group name" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />}
        {error && <p className="error" role="alert">{error}</p>}
        <footer>
          <button className="primary" disabled={busy || picked.length === 0 || (isGroup && !title.trim())} onClick={create}>{verb}</button>
        </footer>
      </div>
    </div>
  );
}
