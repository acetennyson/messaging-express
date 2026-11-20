import type { ConversationListItem } from '@messaging-express/client';
import type { ViewMsg } from './view';

export interface Conv { row: ConversationListItem; last: ViewMsg | null }
interface Member { id: string; name: string }

export const membersOf = (c: ConversationListItem): Member[] => {
  const m = (c.metadata as { members?: Member[] } | null)?.members;
  return Array.isArray(m) ? m : [];
};

export function titleOf(c: ConversationListItem, myId: string): string {
  if (c.type === 'group') return c.title || 'Group';
  return membersOf(c).find((m) => m.id !== myId)?.name || c.title || 'Chat';
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

const HUES = ['#3F5E9A', '#2F8F6B', '#8A5A9E', '#B2701F', '#3A8197', '#A24B63'];
export const hueFor = (s: string) => HUES[[...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length]!;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
export function listTime(iso: string): string {
  const d = new Date(iso);
  return sameDay(d, new Date()) ? timeOf(iso) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
export const previewOf = (m: ViewMsg, myId: string) => {
  if (m.system) return m.text;
  const who = m.sender_id === myId ? 'You: ' : '';
  if (m.deleted) return `${who}Message deleted`;
  if (m.unreadable) return 'Private message';
  if (m.text) return who + m.text;
  const a = m.attachments[0];
  return a ? `${who}${a.kind === 'image' ? 'Sent a photo' : a.name || 'Sent a file'}` : '';
};
export const sizeOf = (n: number | null) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const seenKey = (me: string, conv: string) => `postbox-seen:${me}:${conv}`;
export const getSeen = (me: string, conv: string) => { try { return localStorage.getItem(seenKey(me, conv)) || ''; } catch { return ''; } };
export const markSeen = (me: string, conv: string, iso: string) => { try { localStorage.setItem(seenKey(me, conv), iso); } catch { /* ignore */ } };
export const isUnread = (c: Conv, me: string) => !!c.last && c.last.sender_id !== me && c.last.created_at > getSeen(me, c.row.id);

const announcedKey = (me: string) => `postbox-announced:${me}`;
export const getAnnounced = (me: string): string[] => { try { return JSON.parse(localStorage.getItem(announcedKey(me)) || '[]'); } catch { return []; } };
export const addAnnounced = (me: string, ids: string[]) => { try { localStorage.setItem(announcedKey(me), JSON.stringify([...new Set([...getAnnounced(me), ...ids])])); } catch { /* ignore */ } };
export const creatorOf = (c: ConversationListItem): string | undefined => (c.metadata as { createdBy?: string } | null)?.createdBy;
