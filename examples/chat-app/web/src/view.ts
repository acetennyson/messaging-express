import type { Message } from '@messaging-express/client';
import type { DecryptedAttachment } from '@messaging-express/client-crypto';
import type { Connection } from './api';

/** What the screens draw. Plain messages and decrypted private messages both become this. */
export interface ViewAttachment { id: string; kind: 'image' | 'video' | 'file'; name: string; size: number | null; url: string; secure?: DecryptedAttachment }
export interface ViewMsg {
  id: string; conversation_id: string; sender_id: string; sender: string; created_at: string;
  text: string; attachments: ViewAttachment[]; system: boolean; deleted: boolean;
  /** Set when a private message could not be decrypted on this device (yet). */
  unreadable?: string;
}

export const isPrivate = (row: unknown) => (row as { encryption_mode?: string }).encryption_mode === 'e2ee-v1';

export async function toView(conn: Connection, priv: boolean, msgs: Message[]): Promise<ViewMsg[]> {
  const base = (m: Message) => ({ id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id, sender: m.sender?.name ?? 'Someone', created_at: m.created_at, system: m.type === 'system', deleted: !!m.is_deleted });
  if (!priv) {
    return msgs.map((m) => ({
      ...base(m), text: m.content ?? '',
      attachments: (m.attachments ?? []).map((a) => ({ id: a.id, kind: a.type, name: a.filename ?? 'File', size: a.sizeBytes, url: a.url })),
    }));
  }
  const outcomes = await conn.client.crypto.secure!.decryptMessages(msgs as never);
  return msgs.map((m, i) => {
    const o = outcomes[i]!;
    if (!o.ok) return { ...base(m), text: '', attachments: [], unreadable: 'Waiting for the key to this chat. Check again in a minute.' };
    return {
      ...base(m), text: o.message.text,
      attachments: o.message.attachments.map((a, j) => ({ id: `${m.id}:${j}`, kind: a.descriptor.type.startsWith('image/') ? 'image' as const : 'file' as const, name: a.descriptor.name, size: a.descriptor.size, url: a.url, secure: a })),
    };
  });
}
