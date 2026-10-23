import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHmac } from 'crypto';

/**
 * Real-Postgres tests for Stage 4.4. Need DATABASE_URL pointing at a migrated DB that
 * contains the seed org/project (scripts/smoke-seed.sql). Skipped when DATABASE_URL is unset.
 * Rewrites the seed organization's webhook_url/secret and restores them afterwards;
 * deletes only the mx_webhook_logs rows it created (url contains this run's tag).
 */
const hasDb = !!process.env.DATABASE_URL;
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a2';
const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 'retry-test-secret';
const TAG = `t${process.pid}x${Date.now()}`;

describe.skipIf(!hasDb)('webhook retries (real database)', () => {
  let server: http.Server;
  let base = '';
  let orig: { webhook_url: string | null; webhook_secret: string | null };
  // per-path scripted responses: shift one status per request, last one repeats
  const script = new Map<string, number[]>();
  const hits = new Map<string, { sigOk: boolean }[]>();

  let q: typeof import('../db/pool').query;
  let sendWebhook: typeof import('./sender').sendWebhook;
  let runWebhookRetryBatch: typeof import('./retry').runWebhookRetryBatch;

  const setOrgUrl = (url: string | null) =>
    q('UPDATE mx_organizations SET webhook_url=$1, webhook_secret=$2 WHERE id=$3', [url, SECRET, ORG_ID]);
  const row = async (path: string) =>
    (await q('SELECT response_status, attempts, next_retry_at, completed_at, response_body FROM mx_webhook_logs WHERE url LIKE $1', [`%${path}`])).rows[0];
  const makeDue = (path: string) =>
    q(`UPDATE mx_webhook_logs SET next_retry_at = NOW() - INTERVAL '1 second' WHERE url LIKE $1 AND completed_at IS NULL`, [`%${path}`]);

  beforeAll(async () => {
    ({ query: q } = await import('../db/pool'));
    ({ sendWebhook } = await import('./sender'));
    ({ runWebhookRetryBatch } = await import('./retry'));

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const expected = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
        const path = req.url || '';
        const list = hits.get(path) ?? [];
        list.push({ sigOk: req.headers['x-webhook-signature'] === expected });
        hits.set(path, list);
        const plan = script.get(path) ?? [200];
        const status = plan.length > 1 ? plan.shift()! : plan[0];
        res.writeHead(status);
        res.end('x');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    orig = (await q('SELECT webhook_url, webhook_secret FROM mx_organizations WHERE id=$1', [ORG_ID])).rows[0];
  });

  afterAll(async () => {
    delete process.env.WEBHOOK_RETRY;
    await q('DELETE FROM mx_webhook_logs WHERE url LIKE $1', [`%${TAG}%`]);
    await q('UPDATE mx_organizations SET webhook_url=$1, webhook_secret=$2 WHERE id=$3', [orig.webhook_url, orig.webhook_secret, ORG_ID]);
    await new Promise((r) => server.close(r));
    (await import('../db/pool')).getPool().end();
  });

  async function send(path: string) {
    await setOrgUrl(`${base}${path}`);
    await sendWebhook(PROJECT_ID, 'message.created', { hello: 'world', n: 1 });
  }

  it('flag off: a 500 completes the row exactly as before (500 / 1 / completed, no retry scheduled)', async () => {
    delete process.env.WEBHOOK_RETRY;
    const path = `/${TAG}-off`;
    script.set(path, [500]);
    await send(path);
    const r = await row(path);
    expect([r.response_status, r.attempts, r.completed_at !== null, r.next_retry_at]).toEqual([500, 1, true, null]);
  });

  it('flag on: 500, 500, then 200 ends with attempts=3 and completed_at set', async () => {
    process.env.WEBHOOK_RETRY = 'on';
    const path = `/${TAG}-ok3`;
    script.set(path, [500, 500, 200]);
    await send(path);

    let r = await row(path);
    expect([r.response_status, r.attempts, r.completed_at, r.next_retry_at !== null]).toEqual([500, 1, null, true]);

    // not due yet (backoff is 1 minute): a batch must leave it alone
    await runWebhookRetryBatch();
    expect((await row(path)).attempts).toBe(1);

    await makeDue(path);
    await runWebhookRetryBatch();
    r = await row(path);
    expect([r.response_status, r.attempts, r.completed_at]).toEqual([500, 2, null]);

    await makeDue(path);
    await runWebhookRetryBatch();
    r = await row(path);
    expect([r.response_status, r.attempts, r.completed_at !== null, r.next_retry_at]).toEqual([200, 3, true, null]);

    // every request, first attempt and retries, carried a signature valid for its own body
    expect(hits.get(path)!.map((h) => h.sigOk)).toEqual([true, true, true]);
  });

  it('flag on: always failing stops after 5 attempts and is then left alone', async () => {
    process.env.WEBHOOK_RETRY = 'on';
    const path = `/${TAG}-dead5`;
    script.set(path, [500]);
    await send(path);
    for (let i = 0; i < 6; i++) {
      await makeDue(path);
      await runWebhookRetryBatch();
    }
    const r = await row(path);
    expect([r.response_status, r.attempts, r.completed_at !== null, r.next_retry_at]).toEqual([500, 5, true, null]);
    expect(hits.get(path)!.length).toBe(5);
  });

  it('two concurrent workers never take the same row (SKIP LOCKED + lease)', async () => {
    process.env.WEBHOOK_RETRY = 'on';
    const path = `/${TAG}-race`;
    script.set(path, [500, 200]);
    await send(path);
    await makeDue(path);
    await Promise.all([runWebhookRetryBatch(), runWebhookRetryBatch(), runWebhookRetryBatch()]);
    const r = await row(path);
    expect(r.attempts).toBe(2); // 1 first attempt + exactly 1 retry
    expect(hits.get(path)!.length).toBe(2);
  });

  it('gives up cleanly when the customer removed their webhook_url', async () => {
    process.env.WEBHOOK_RETRY = 'on';
    const path = `/${TAG}-removed`;
    script.set(path, [500]);
    await send(path);
    await q('UPDATE mx_organizations SET webhook_url=NULL WHERE id=$1', [ORG_ID]);
    await makeDue(path);
    await runWebhookRetryBatch();
    const r = await row(path);
    expect(r.completed_at).not.toBeNull();
    expect(r.attempts).toBe(1);
    expect(r.response_body).toMatch(/no longer configured/);
    expect(hits.get(path)!.length).toBe(1);
  });
});
