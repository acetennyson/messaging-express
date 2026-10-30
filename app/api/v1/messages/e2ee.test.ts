/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

/** E2EE Stage 7.5: POST /messages in encrypted conversations. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'messages-e2ee-test-secret';
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Record every SQL statement the route runs inside its transaction.
const executed: string[] = [];
vi.mock('@/lib/db/pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/pool')>();
  return {
    ...actual,
    transaction: (cb: (c: any) => Promise<unknown>) =>
      actual.transaction((client) =>
        cb({
          query: (text: string, params?: unknown[]) => {
            executed.push(text);
            return client.query(text, params);
          },
        })
      ),
  };
});

const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const SENDER = '00000000-0000-4000-8000-0000000000b1'; // seeded user

const token = () => jwt.sign({ projectId: PROJECT, organizationId: ORG, type: 'api' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const ciphertext = (bytes = 60) => Buffer.concat([Buffer.from([0x01]), randomBytes(bytes - 1)]).toString('base64url');
const ORIGINAL_CONV_QUERY = 'SELECT id FROM mx_conversations WHERE id = $1 AND project_id = $2';

async function send(body: Record<string, unknown>) {
  const { POST } = await import('./route');
  const res = await POST(
    new NextRequest('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as { data?: any; error?: { code?: string; message: string; details?: any } } };
}

describe.skipIf(!hasDb)('POST /messages: encrypted conversations', () => {
  const convs: string[] = [];
  let query: typeof import('@/lib/db/pool').query;
  const on = () => {
    process.env.E2EE_ENABLED = 'on';
  };

  /** A conversation with the seeded sender as participant. */
  async function conversation(mode: 'none' | 'e2ee-v1' | 'e2ee-v2', opts: { keyVersions?: number[]; min?: number } = {}) {
    const id = (
      await query(`INSERT INTO mx_conversations (project_id, type, encryption_mode, min_key_version) VALUES ($1,'group',$2,$3) RETURNING id`, [PROJECT, mode, opts.min ?? 1])
    ).rows[0].id as string;
    convs.push(id);
    await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [id, SENDER]);
    if (opts.keyVersions?.length) {
      const device = (await query(`INSERT INTO mx_devices (project_id, user_id, public_key) VALUES ($1,$2,$3) RETURNING id`, [PROJECT, SENDER, randomBytes(32).toString('base64url')])).rows[0].id;
      for (const v of opts.keyVersions) {
        await query(`INSERT INTO mx_conversation_keys (conversation_id, device_id, key_version, wrapped_key) VALUES ($1,$2,$3,'x')`, [id, device, v]);
      }
    }
    return id;
  }
  const msg = (conversationId: string, over: Record<string, unknown> = {}) => ({
    conversationId,
    senderId: SENDER,
    content: ciphertext(),
    metadata: { scheme: 'ck-xchacha-v1', key_version: 1 },
    ...over,
  });
  const count = async (id: string) => (await query('SELECT count(*)::int AS n FROM mx_messages WHERE conversation_id = $1', [id])).rows[0].n as number;

  beforeAll(async () => {
    ({ query } = await import('@/lib/db/pool'));
  });
  afterEach(() => {
    delete process.env.E2EE_ENABLED;
    executed.length = 0;
  });
  afterAll(async () => {
    if (convs.length) await query('DELETE FROM mx_conversations WHERE id = ANY($1::uuid[])', [convs]);
    const { closePool } = await import('@/lib/db/pool');
    await closePool();
  });

  describe('flag off: the plaintext path is untouched', () => {
    it('runs the original conversation query and never touches the E2EE columns or the keys table', async () => {
      const id = await conversation('none');
      const r = await send({ conversationId: id, senderId: SENDER, content: 'hello' });
      expect(r.status).toBe(201);
      expect(executed[0]).toBe(ORIGINAL_CONV_QUERY);
      expect(executed.some((q) => /encryption_mode|min_key_version|mx_conversation_keys/.test(q))).toBe(false);
    });

    it('does not validate messages sent to an encrypted conversation (the check is part of the E2EE feature)', async () => {
      const id = await conversation('e2ee-v1', { keyVersions: [1] });
      const r = await send({ conversationId: id, senderId: SENDER, content: 'plain text' });
      expect(r.status).toBe(201);
      expect(executed[0]).toBe(ORIGINAL_CONV_QUERY);
    });
  });

  describe('flag on', () => {
    it('plain conversations behave as before; a stray metadata.scheme is refused', async () => {
      on();
      const id = await conversation('none');
      expect((await send({ conversationId: id, senderId: SENDER, content: 'hello' })).status).toBe(201);
      const stray = await send({ conversationId: id, senderId: SENDER, content: 'hello', metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } });
      expect([stray.status, stray.json.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect(await count(id)).toBe(1);
    });

    it('accepts a well-formed e2ee-v1 message', async () => {
      on();
      const id = await conversation('e2ee-v1', { keyVersions: [1] });
      const r = await send(msg(id));
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json.data.metadata).toEqual({ scheme: 'ck-xchacha-v1', key_version: 1 });
      expect(await count(id)).toBe(1);
    });

    it('refuses plaintext, with a message that points at sendSecureMessage', async () => {
      on();
      const id = await conversation('e2ee-v1', { keyVersions: [1] });
      for (const body of [
        { conversationId: id, senderId: SENDER, content: 'hello world' }, // no metadata at all
        msg(id, { content: 'hello world, this is plaintext that is long enough' }), // scheme right, content is plaintext
        msg(id, { content: undefined }),
        msg(id, { metadata: { key_version: 1 } }), // no scheme
        msg(id, { metadata: { scheme: 'other', key_version: 1 } }),
        msg(id, { metadata: { scheme: 'ck-xchacha-v1' } }), // no key_version
        msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: '1' } }),
        msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 0 } }),
        msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 1.5 } }),
        msg(id, { content: ciphertext() + '==' }), // padding is not base64url
        msg(id, { content: Buffer.concat([Buffer.from([0x02]), randomBytes(59)]).toString('base64url') }), // wrong version byte
        msg(id, { content: ciphertext(40) }), // shorter than nonce + tag + version
      ]) {
        const r = await send(body as Record<string, unknown>);
        expect([r.status, r.json.error?.code], JSON.stringify(body).slice(0, 80)).toEqual([400, 'VALIDATION_ERROR']);
      }
      const plain = await send({ conversationId: id, senderId: SENDER, content: 'hello world' });
      expect(plain.json.error?.message).toContain('sendSecureMessage');
      expect(await count(id)).toBe(0);
    });

    it('the smallest valid ciphertext (41 bytes) is accepted', async () => {
      on();
      const id = await conversation('e2ee-v1', { keyVersions: [1] });
      expect((await send(msg(id, { content: ciphertext(41) }))).status).toBe(201);
    });

    it('409 KEYS_NOT_READY before any key exists', async () => {
      on();
      const id = await conversation('e2ee-v1');
      const r = await send(msg(id));
      expect([r.status, r.json.error?.code]).toEqual([409, 'KEYS_NOT_READY']);
    });

    it('rejects a key version that does not exist yet; accepts any version up to the latest', async () => {
      on();
      const id = await conversation('e2ee-v1', { keyVersions: [1, 2] });
      expect((await send(msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 3 } }))).status).toBe(400);
      expect((await send(msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 2 } }))).status).toBe(201);
      expect((await send(msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } }))).status).toBe(201);
    });

    it('409 KEY_ROTATION_REQUIRED below min_key_version, with the minimum in details', async () => {
      on();
      const id = await conversation('e2ee-v1', { keyVersions: [1], min: 2 });
      const old = await send(msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } }));
      expect([old.status, old.json.error?.code, old.json.error?.details]).toEqual([409, 'KEY_ROTATION_REQUIRED', { minKeyVersion: 2 }]);
      // once version 2 exists, it works and version 1 is still refused
      const device = (await query('SELECT device_id FROM mx_conversation_keys WHERE conversation_id = $1', [id])).rows[0].device_id;
      await query(`INSERT INTO mx_conversation_keys (conversation_id, device_id, key_version, wrapped_key) VALUES ($1,$2,2,'x')`, [id, device]);
      expect((await send(msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 2 } }))).status).toBe(201);
      expect((await send(msg(id, { metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } }))).status).toBe(409);
    });

    it('attachments must be opaque blobs', async () => {
      on();
      const id = await conversation('e2ee-v1', { keyVersions: [1] });
      const blob = { type: 'file', url: 'http://x.test/a.bin', mimeType: 'application/octet-stream' };
      expect((await send(msg(id, { attachments: [blob] }))).status).toBe(201);
      expect((await send(msg(id, { attachments: [{ type: 'file', url: 'http://x.test/a.bin' }] }))).status).toBe(201); // mimeType omitted
      for (const bad of [{ mimeType: 'image/png' }, { width: 10 }, { height: 10 }, { durationSeconds: 3 }, { thumbnailUrl: 'http://x.test/t.png' }]) {
        const r = await send(msg(id, { attachments: [{ ...blob, ...bad }] }));
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
    });

    it('conversations in a mode this endpoint does not handle are refused', async () => {
      on();
      const id = await conversation('e2ee-v2', { keyVersions: [1] });
      expect((await send(msg(id))).status).toBe(400);
    });

    it('existing errors keep their order and codes (404 unknown conversation, 400 non-participant)', async () => {
      on();
      expect((await send({ conversationId: '00000000-0000-4000-8000-00000000ffff', senderId: SENDER, content: 'x' })).status).toBe(404);
      const id = await conversation('e2ee-v1', { keyVersions: [1] });
      const r = await send(msg(id, { senderId: '00000000-0000-4000-8000-00000000ffff' }));
      expect([r.status, r.json.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect(r.json.error?.message).toContain('not a participant');
    });
  });
});
