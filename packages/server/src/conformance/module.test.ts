/**
 * M10: what HTTP equivalence with the hosted server cannot show. Real Postgres, throwaway schemas, the module's own handler.
 * Covers: instances never touch each other's data, a removal blocks the very next read, concurrent writes, a failure in the
 * middle of a transaction leaves nothing behind, a webhook retry redelivers the identical event, and upgrading an older
 * database that already holds data. (Migration killed halfway: migrations/runner.test.ts. Eviction from realtime: realtime/embedded.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { MessagingServer } from '../server';
import { migrate } from '../migrations/runner';
import { steps } from '../migrations/steps';
import type { ModuleEvent } from '../realtime/audience';

const URL_ = process.env.TEST_SCHEMA_DATABASE_URL || process.env.DATABASE_URL;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const secretFor = (tag: string) => `m10-${tag}-secret-m10-${tag}-secret-xxxxxxxx`;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!URL_)('module conformance', () => {
  const admin = new Pool({ connectionString: URL_, max: 4 });
  const open: MessagingServer[] = [];
  const schemas: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  const newSchema = async (migrated = true) => {
    const schema = `m10_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    await admin.query(`CREATE SCHEMA ${schema}`);
    if (migrated) await MessagingServer.migrate({ database: URL_!, schema });
    return schema;
  };
  const init = async (schema: string, secret: string, extra: object = {}) => {
    const s = await MessagingServer.init({ database: URL_!, jwtSecret: secret, schema, logger: silent, ...extra } as never);
    open.push(s);
    return s;
  };
  const tokenFor = (secret: string, claims: object) => jwt.sign(claims, secret, { expiresIn: '1h' });
  const call = async (s: MessagingServer, method: string, path: string, token: string | null, body?: unknown) => {
    const res = await s.handler(
      new Request(`http://chat.test${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    );
    return { status: res.status, json: (await res.json().catch(() => null)) as Json };
  };
  const mkUser = async (s: MessagingServer, api: string, name: string) =>
    (await call(s, 'POST', '/api/v1/users', api, { externalId: `${name}-${randomBytes(3).toString('hex')}`, name })).json.data as { id: string };

  afterAll(async () => {
    await Promise.all(open.map((s) => s.close({ timeoutMs: 1000 }).catch(() => undefined)));
    for (const c of closers) await c();
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  describe('isolation', () => {
    it('two instances with different schemas and secrets never touch each other', async () => {
      const [sa, sb] = [await newSchema(), await newSchema()];
      const [secA, secB] = [secretFor('a'), secretFor('b')];
      const [a, b] = [await init(sa, secA), await init(sb, secB)];
      const [apiA, apiB] = [tokenFor(secA, { type: 'api' }), tokenFor(secB, { type: 'api' })];

      const alice = await mkUser(a, apiA, 'alice');
      const bob = await mkUser(a, apiA, 'bob');
      const conv = (await call(a, 'POST', '/api/v1/conversations', apiA, { type: 'group', participantIds: [alice.id, bob.id] })).json.data;
      await call(a, 'POST', '/api/v1/messages', tokenFor(secA, { type: 'user', userId: alice.id }), { conversationId: conv.id, senderId: alice.id, content: 'secret in A' });

      // B cannot use A's tokens, and cannot see A's data even with the ids
      expect((await call(b, 'GET', '/api/v1/users', apiA)).status).toBe(401);
      expect((await call(b, 'GET', '/api/v1/users', apiB)).json.data).toHaveLength(0);
      // an unknown conversation answers with an empty page (the hosted behaviour), never with A's messages
      expect((await call(b, 'GET', `/api/v1/messages?conversationId=${conv.id}`, apiB)).json.data ?? []).toHaveLength(0);
      expect((await call(b, 'GET', `/api/v1/conversations/${conv.id}`, apiB)).status).toBe(404);
      // and A still has exactly its own rows
      expect((await call(a, 'GET', '/api/v1/users', apiA)).json.data).toHaveLength(2);
      const stray = await admin.query(`SELECT count(*)::int n FROM ${sb}.mx_messages`);
      expect(stray.rows[0].n).toBe(0);
    });

    it('two projects in one schema, even with the same secret, never see each other’s rows', async () => {
      const schema = await newSchema();
      const secret = secretFor('shared');
      const [x, y] = [await init(schema, secret, { projectName: 'x' }), await init(schema, secret, { projectName: 'y' })];
      expect(x.projectId).not.toBe(y.projectId);
      const api = tokenFor(secret, { type: 'api' }); // the same token is valid for both: the secret is the trust boundary

      const ux = await mkUser(x, api, 'xavier');
      const conv = (await call(x, 'POST', '/api/v1/conversations', api, { type: 'group', participantIds: [ux.id] })).json.data;
      expect((await call(y, 'GET', '/api/v1/users', api)).json.data).toHaveLength(0);
      expect((await call(y, 'GET', `/api/v1/messages?conversationId=${conv.id}`, api)).json.data ?? []).toHaveLength(0);
      expect((await call(y, 'GET', `/api/v1/conversations/${conv.id}`, api)).status).toBe(404);
      expect((await call(y, 'POST', '/api/v1/messages', tokenFor(secret, { type: 'user', userId: ux.id }), { conversationId: conv.id, senderId: ux.id, content: 'cross project' })).status).not.toBe(201);
      const rows = await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_messages`);
      expect(rows.rows[0].n).toBe(0);
    });
  });

  describe('one instance, one conversation', () => {
    let s: MessagingServer;
    let schema: string;
    let secret: string;
    let api: string;
    const events: ModuleEvent[] = [];
    beforeAll(async () => {
      schema = await newSchema();
      secret = secretFor('conv');
      s = await init(schema, secret);
      api = tokenFor(secret, { type: 'api' });
      s.onEvent((e) => void events.push(e));
    });
    const group = async (names: string[]) => {
      const users = await Promise.all(names.map((n) => mkUser(s, api, n)));
      const conv = (await call(s, 'POST', '/api/v1/conversations', api, { type: 'group', participantIds: users.map((u) => u.id) })).json.data;
      return { users, conv };
    };
    const asUser = (id: string) => tokenFor(secret, { type: 'user', userId: id });

    it('a removed member is blocked on the very next read and write', async () => {
      const { users: [alice, bob], conv } = await group(['alice', 'bob']);
      expect((await call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}`, asUser(bob.id))).status).toBe(200);
      expect((await call(s, 'DELETE', `/api/v1/conversations/${conv.id}/participants/${bob.id}`, api)).status).toBe(200);
      expect((await call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}`, asUser(bob.id))).status).toBe(403);
      expect((await call(s, 'POST', '/api/v1/messages', asUser(bob.id), { conversationId: conv.id, senderId: bob.id, content: 'still here?' })).status).toBeGreaterThanOrEqual(400);
      expect((await call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}`, asUser(alice.id))).status).toBe(200);
    });

    it('concurrent writes: every message lands exactly once, with its own id, readable in order', async () => {
      const { users: [alice, bob], conv } = await group(['alice', 'bob']);
      const N = 30;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => {
          const u = i % 2 ? bob : alice;
          return call(s, 'POST', '/api/v1/messages', asUser(u.id), { conversationId: conv.id, senderId: u.id, content: `msg-${i}` });
        })
      );
      expect(results.map((r) => r.status)).toEqual(Array(N).fill(201));
      expect(new Set(results.map((r) => r.json.data.id)).size).toBe(N);
      const rows = await admin.query(`SELECT content FROM ${schema}.mx_messages WHERE conversation_id = $1`, [conv.id]);
      expect(rows.rows.map((r) => r.content).sort()).toEqual(Array.from({ length: N }, (_, i) => `msg-${i}`).sort());
      const page = await call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}&limit=100`, asUser(alice.id));
      expect(page.json.data).toHaveLength(N);
    });

    it('a failure in the middle of a transaction leaves nothing half-written and announces nothing', async () => {
      const { users: [alice, bob], conv } = await group(['alice', 'bob']);
      // a real database failure, not a mock: the second attachment makes Postgres raise inside the open transaction
      await admin.query(`
        CREATE FUNCTION ${schema}.m10_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.filename = 'boom.bin' THEN RAISE EXCEPTION 'm10 injected failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER m10_boom BEFORE INSERT ON ${schema}.mx_message_attachments FOR EACH ROW EXECUTE FUNCTION ${schema}.m10_boom();`);
      const eventsBefore = events.length;
      const att = (filename: string) => ({ type: 'file', url: `https://files.test/${filename}`, filename, mimeType: 'application/octet-stream', sizeBytes: 3 });
      const res = await call(s, 'POST', '/api/v1/messages', asUser(alice.id), {
        conversationId: conv.id, senderId: alice.id, content: 'with two attachments', attachments: [att('ok.bin'), att('boom.bin')],
      });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).not.toMatch(/m10|injected|stack|trigger/i); // no internals leak
      const msgs = await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_messages WHERE conversation_id = $1`, [conv.id]);
      const atts = await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_message_attachments a JOIN ${schema}.mx_messages m ON m.id = a.message_id WHERE m.conversation_id = $1`, [conv.id]);
      expect(msgs.rows[0].n).toBe(0);
      expect(atts.rows[0].n).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(events.slice(eventsBefore).filter((e) => e.type === 'message.created')).toHaveLength(0);
      // and the system is fine afterwards
      expect((await call(s, 'POST', '/api/v1/messages', asUser(bob.id), { conversationId: conv.id, senderId: bob.id, content: 'after' })).status).toBe(201);
    });
  });

  describe('webhooks', () => {
    it('a retry redelivers the same event with a valid signature, so receivers can deduplicate on data.id', async () => {
      const got: { body: string; sig: string | undefined; event: string | undefined }[] = [];
      let status = 500;
      const rx: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          got.push({ body: Buffer.concat(chunks).toString(), sig: req.headers['x-webhook-signature'] as string, event: req.headers['x-webhook-event'] as string });
          res.writeHead(status).end();
        });
      });
      await new Promise<void>((r) => rx.listen(0, '127.0.0.1', r));
      closers.push(() => new Promise<void>((r) => { rx.closeAllConnections(); rx.close(() => r()); }));
      const url = `http://127.0.0.1:${(rx.address() as AddressInfo).port}/hook`;

      const schema = await newSchema();
      const secret = secretFor('hook');
      const s = await init(schema, secret, { webhook: { url, secret: 'whsec_m10', retryIntervalMs: 1000 } });
      const api = tokenFor(secret, { type: 'api' });
      const [alice, bob] = [await mkUser(s, api, 'alice'), await mkUser(s, api, 'bob')];
      const conv = (await call(s, 'POST', '/api/v1/conversations', api, { type: 'group', participantIds: [alice.id, bob.id] })).json.data;
      await call(s, 'POST', '/api/v1/messages', tokenFor(secret, { type: 'user', userId: alice.id }), { conversationId: conv.id, senderId: alice.id, content: 'once' });

      const until = async (f: () => boolean | Promise<boolean>, ms: number) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); }
        throw new Error('timed out');
      };
      await until(() => got.some((g) => g.event === 'message.created'), 5000); // the receiver answered 500: a failure is recorded
      await admin.query(`UPDATE ${schema}.mx_webhook_logs SET next_retry_at = NOW() WHERE completed_at IS NULL`);
      status = 200;
      await until(() => got.filter((g) => g.event === 'message.created').length >= 2, 8000);
      const [first, second] = got.filter((g) => g.event === 'message.created');
      // Same event, same data and timestamp. The BYTES can differ: the retry re-reads the payload from jsonb, which reorders keys.
      // Each body carries a signature valid for exactly that body, so a receiver verifies what it got and keys on data.id.
      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
      for (const g of [first, second]) expect(g.sig).toBe(`sha256=${createHmac('sha256', 'whsec_m10').update(g.body).digest('hex')}`);
      expect(JSON.parse(first.body).data.content).toBe('once');
    }, 30_000);
  });

  describe('upgrade', () => {
    it('an older database that already holds data upgrades in place and keeps working', async () => {
      const schema = await newSchema(false);
      const oldSteps = steps.slice(0, 16); // before the E2EE columns (0018) and their constraint (0019)
      expect(oldSteps.at(-1)!.name).not.toMatch(/e2ee/);
      await migrate(URL_!, { schema, steps: oldSteps });

      const q = (sql: string, p: unknown[] = []) => admin.query(sql.replace(/mx_/g, `${schema}.mx_`), p);
      const org = (await q(`INSERT INTO mx_organizations (name, slug, api_key, api_secret_hash) VALUES ('old', 'embedded', 'k-${schema}', 'h') RETURNING id`)).rows[0].id;
      const proj = (await q(`INSERT INTO mx_projects (organization_id, name, api_key) VALUES ($1, 'legacy', 'pk-${schema}') RETURNING id`, [org])).rows[0].id;
      const [u1, u2] = await Promise.all(['ann', 'ben'].map(async (n) => (await q(`INSERT INTO mx_users (project_id, external_id, name) VALUES ($1, $2, $2) RETURNING id`, [proj, n])).rows[0].id as string));
      const conv = (await q(`INSERT INTO mx_conversations (project_id, type, title) VALUES ($1, 'group', 'old chat') RETURNING id`, [proj])).rows[0].id;
      for (const u of [u1, u2]) await q(`INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1, $2)`, [conv, u]);
      for (let i = 0; i < 5; i++) await q(`INSERT INTO mx_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)`, [conv, u1, `old-${i}`]);

      const secret = secretFor('upg');
      // before upgrading, init refuses; after `migrate` it takes over the existing project by name
      await expect(MessagingServer.init({ database: URL_!, jwtSecret: secret, schema, projectName: 'legacy', logger: silent })).rejects.toThrow(/migrate/);
      const result = await MessagingServer.migrate({ database: URL_!, schema });
      expect(result.applied.length).toBeGreaterThan(0);

      const s = await init(schema, secret, { projectName: 'legacy' });
      expect(s.projectId).toBe(proj);
      const page = await call(s, 'GET', `/api/v1/messages?conversationId=${conv}&limit=50`, tokenFor(secret, { type: 'user', userId: u2 }));
      expect(page.status).toBe(200);
      expect(page.json.data.map((m: Json) => m.content).sort()).toEqual(['old-0', 'old-1', 'old-2', 'old-3', 'old-4']);
      const mode = await q(`SELECT encryption_mode, min_key_version FROM mx_conversations WHERE id = $1`, [conv]);
      expect(mode.rows[0]).toEqual({ encryption_mode: 'none', min_key_version: 1 });
      expect((await call(s, 'POST', '/api/v1/messages', tokenFor(secret, { type: 'user', userId: u2 }), { conversationId: conv, senderId: u2, content: 'new' })).status).toBe(201);
      expect((await q(`SELECT count(*)::int n FROM mx_messages WHERE conversation_id = $1`, [conv])).rows[0].n).toBe(6);
    });
  });
});
