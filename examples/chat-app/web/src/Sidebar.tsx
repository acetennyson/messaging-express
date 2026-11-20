import { Avatar } from './Avatar';
import { Lock } from './Icons';
import { isPrivate } from './view';
import { isUnread, listTime, previewOf, titleOf, type Conv } from './util';

interface Props {
  me: { id: string; name: string }; convs: Conv[] | null; loadError: string; selected: string | null; online: boolean;
  onOpen: (id: string) => void; onNew: () => void; onSignOut: () => void; onRetry: () => void;
}

export function Sidebar({ me, convs, loadError, selected, online, onOpen, onNew, onSignOut, onRetry }: Props) {
  return (
    <aside className="side">
      <header className="side-head">
        <Avatar name={me.name} size={36} />
        <div className="side-me">
          <strong>{me.name}</strong>
          <span className={online ? 'status ok' : 'status'}>{online ? 'Live' : 'Reconnecting…'}</span>
        </div>
        <button className="ghost" onClick={onSignOut}>Sign out</button>
      </header>
      <button className="new" onClick={onNew}>New chat</button>
      <nav className="list" aria-label="Chats">
        {loadError && <div className="note"><p>{loadError}</p><button className="ghost" onClick={onRetry}>Try again</button></div>}
        {!loadError && convs === null && <p className="note">Loading chats…</p>}
        {convs?.length === 0 && <p className="note">You have no chats. Use “New chat” to start one.</p>}
        {convs?.map((c) => {
          const unread = c.row.id !== selected && isUnread(c, me.id);
          const title = titleOf(c.row, me.id);
          return (
            <button key={c.row.id} className={`row ${c.row.id === selected ? 'active' : ''}`} onClick={() => onOpen(c.row.id)}>
              <Avatar name={title} size={42} group={c.row.type === 'group'} />
              <span className="row-body">
                <span className="row-top"><span className={`row-title ${unread ? 'unread' : ''}`}>{isPrivate(c.row) && <Lock size={13} />}{title}</span>{c.last && <time>{listTime(c.last.created_at)}</time>}</span>
                <span className="row-bottom"><span className="row-preview">{c.last ? previewOf(c.last, me.id) : 'No messages yet'}</span>{unread && <span className="dot" aria-label="Unread" />}</span>
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
