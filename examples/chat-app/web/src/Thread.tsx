import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Connection } from './api';
import { Avatar } from './Avatar';
import { Lock } from './Icons';
import { dayLabel, sizeOf, timeOf, titleOf, type Conv } from './util';
import { isPrivate, toView, type ViewAttachment, type ViewMsg } from './view';

const PAGE = 40;
const byTime = (a: ViewMsg, b: ViewMsg) => a.created_at.localeCompare(b.created_at);

export function Thread({ conn, me, conv, onBack }: { conn: Connection; me: { id: string; name: string }; conv: Conv; onBack: () => void }) {
  const id = conv.row.id;
  const priv = isPrivate(conv.row);
  const title = titleOf(conv.row, me.id);
  const [msgs, setMsgs] = useState<ViewMsg[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const page = await conn.client.messages.list({ conversationId: id, limit: PAGE });
      const view = await toView(conn, priv, page.data);
      setMsgs((cur) => merge(cur ?? [], view)); setMore(page.data.length === PAGE); setError('');
    } catch (e) { setError((e as Error).message || 'Could not load messages.'); }
  }, [conn, id, priv]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => conn.realtime.onStatusChange((s, info) => { if (s === 'connected' && info.reconnected) void load(); }), [conn, load]);
  useEffect(() => conn.realtime.on('message.created', async (m) => {
    if (m.conversation_id !== id) return;
    const view = await toView(conn, priv, [m]);
    setMsgs((cur) => merge(cur ?? [], view));
  }), [conn, id, priv]);

  // A private message that could not be opened yet (key still on its way) is retried every few seconds.
  const stuck = msgs?.some((m) => m.unreadable);
  useEffect(() => { if (!stuck) return; const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [stuck, load]);

  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs]);

  const older = async () => {
    if (!msgs?.length) return;
    const el = scroller.current, before = el?.scrollHeight ?? 0;
    try {
      const page = await conn.client.messages.list({ conversationId: id, limit: PAGE, before: msgs[0]!.created_at });
      const view = await toView(conn, priv, page.data);
      stick.current = false;
      setMsgs((cur) => merge(cur ?? [], view)); setMore(page.data.length === PAGE);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
    } catch (e) { setError((e as Error).message); }
  };

  const sent = (m: ViewMsg) => { stick.current = true; setMsgs((cur) => merge(cur ?? [], [m])); };

  return (
    <section className="thread">
      <header className="thread-head">
        <button className="back" onClick={onBack} aria-label="Back to chats">‹</button>
        <Avatar name={title} size={38} group={conv.row.type === 'group'} />
        <div>
          <h2>{title}</h2>
          <span className="sub">{priv ? <span className="sub-lock"><Lock size={12} />Private chat</span> : conv.row.type === 'group' ? `${conv.row.participant_count} people` : 'Direct chat'}</span>
        </div>
      </header>
      <div className="scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {priv && (
          <aside className="private-note" aria-label="About private chats">
            <Lock size={18} />
            <p><strong>This is a private chat.</strong> Messages and files are end-to-end encrypted: the server stores only scrambled data, and only people in this chat can read it. The server can still see who is chatting and when. This feature is in beta and its encryption code has not had an independent review.</p>
          </aside>
        )}
        {error && <p className="error banner" role="alert">{error} <button className="ghost" onClick={() => void load()}>Try again</button></p>}
        {more && <button className="ghost older" onClick={older}>Show earlier messages</button>}
        {msgs === null && !error && <p className="note">Loading messages…</p>}
        {msgs?.length === 0 && <p className="note">No messages yet. Say hello.</p>}
        {msgs?.map((m, i) => {
          const prev = msgs[i - 1];
          const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
          const mine = m.sender_id === me.id;
          const showName = conv.row.type === 'group' && !mine && !m.system && (newDay || prev?.sender_id !== m.sender_id || prev?.system);
          return (
            <Fragment key={m.id}>
              {newDay && <div className="postmark"><span>{dayLabel(m.created_at)}</span></div>}
              {m.system ? <div className="notice"><Lock size={13} />{m.text}</div> : <Bubble conn={conn} m={m} mine={mine} showName={showName} />}
            </Fragment>
          );
        })}
      </div>
      <Composer conn={conn} me={me} conv={conv} priv={priv} onSent={sent} />
    </section>
  );
}

function merge(a: ViewMsg[], b: ViewMsg[]): ViewMsg[] {
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) map.set(m.id, m);
  return [...map.values()].sort(byTime);
}

function Bubble({ conn, m, mine, showName }: { conn: Connection; m: ViewMsg; mine: boolean; showName: boolean }) {
  return (
    <div className={`msg ${mine ? 'mine' : 'theirs'}`}>
      {showName && <span className="msg-name">{m.sender}</span>}
      <div className="bubble">
        {m.deleted ? <em>Message deleted</em> : m.unreadable ? <em>{m.unreadable}</em> : (
          <>
            {m.attachments.map((a) => <Attachment key={a.id} conn={conn} a={a} />)}
            {m.text && <p>{m.text}</p>}
          </>
        )}
        <time>{timeOf(m.created_at)}</time>
      </div>
    </div>
  );
}

const MAX_INLINE = 12 * 1024 * 1024;
function Attachment({ conn, a }: { conn: Connection; a: ViewAttachment }) {
  const [src, setSrc] = useState<string | null>(a.secure ? null : a.url);
  const [failed, setFailed] = useState(false);
  const inline = a.kind === 'image' && (!a.secure || (a.size ?? 0) <= MAX_INLINE);

  // Private photos are downloaded and decrypted here, then shown from a local blob.
  useEffect(() => {
    if (!a.secure || !inline) return;
    let url = '', stop = false;
    conn.client.crypto.secure!.openAttachment(a.secure).then((r) => {
      if (stop) return;
      url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.type }));
      setSrc(url);
    }).catch(() => setFailed(true));
    return () => { stop = true; if (url) URL.revokeObjectURL(url); };
  }, [conn, a.secure, inline]);

  const download = async () => {
    try {
      const r = await conn.client.crypto.secure!.openAttachment(a.secure!);
      const url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: 'application/octet-stream' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: r.name });
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { setFailed(true); }
  };

  if (failed) return <p className="file-fail">Could not open {a.name}.</p>;
  if (inline) return src ? <a href={src} target="_blank" rel="noreferrer"><img className="shot" src={src} alt={a.name} loading="lazy" /></a> : <div className="shot-wait" aria-label={`Opening ${a.name}`} />;
  const body = <><span className="file-ico" aria-hidden="true">▤</span><span><strong>{a.name}</strong><small>{sizeOf(a.size)}</small></span></>;
  return a.secure
    ? <button className="file" onClick={download}>{body}</button>
    : <a className="file" href={a.url} target="_blank" rel="noreferrer" download={a.name}>{body}</a>;
}

function Composer({ conn, me, conv, priv, onSent }: { conn: Connection; me: { id: string; name: string }; conv: Conv; priv: boolean; onSent: (m: ViewMsg) => void }) {
  const conversationId = conv.row.id;
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { area.current?.focus(); }, [conversationId]);
  useLayoutEffect(() => { const el = area.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; } }, [text]);

  const send = async () => {
    const content = text.trim();
    if (busy || (!content && files.length === 0)) return;
    setBusy(true); setError('');
    try {
      let m;
      if (priv) {
        m = await conn.client.crypto.secure!.sendSecureMessage({
          conversationId, text: content,
          attachments: files.map((f) => ({ data: f, name: f.name, type: f.type || 'application/octet-stream' })),
        });
      } else {
        const outcomes = files.length ? await conn.client.uploads.upload(files, { category: 'chat', direct: 'never' }) : [];
        const failed = outcomes.filter((o) => !o.ok);
        if (failed.length) throw new Error(`Could not upload ${failed.map((f) => (f.file instanceof File ? f.file.name : 'a file')).join(', ')}: ${(failed[0] as { error: string }).error}`);
        const attachments = outcomes.flatMap((o) => (o.ok ? [o.attachment] : []));
        m = await conn.client.messages.send({ conversationId, senderId: me.id, content: content || undefined, type: content ? 'text' : attachments[0]!.type, attachments: attachments.length ? attachments : undefined });
      }
      const [v] = await toView(conn, priv, [m as never]);
      setText(''); setFiles([]); onSent(v!);
    } catch (e) { setError((e as Error).message || 'Could not send. Your message is still here.'); }
    finally { setBusy(false); area.current?.focus(); }
  };

  // Copy the FileList NOW: the input is cleared right after, and a state updater runs later.
  const add = (list: FileList | File[]) => { const picked = Array.from(list); setFiles((cur) => [...cur, ...picked].slice(0, 5)); };

  return (
    <footer className={`composer ${drag ? 'drag' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
      {files.length > 0 && (
        <ul className="chips">{files.map((f, i) => <li key={i}>{f.name}<button aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></li>)}</ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="compose-row">
        <input ref={input} type="file" multiple hidden accept={priv ? undefined : 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,application/pdf'} onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
        <button className="clip" onClick={() => input.current?.click()} aria-label="Attach files" title="Attach files">+</button>
        <textarea ref={area} rows={1} value={text} placeholder={priv ? 'Write a private message' : 'Write a message'} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="primary send" onClick={() => void send()} disabled={busy || (!text.trim() && files.length === 0)}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </footer>
  );
}
