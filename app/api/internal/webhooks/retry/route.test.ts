import { afterEach, describe, expect, it, vi } from 'vitest';

const batch = vi.fn().mockResolvedValue({ claimed: 2, delivered: 1, rescheduled: 1, gaveUp: 0, errors: 0 });
vi.mock('@/lib/webhooks/retry', () => ({ runWebhookRetryBatch: () => batch() }));

import { GET, POST } from './route';

const req = (auth?: string, method = 'POST') =>
  new Request('http://x/api/internal/webhooks/retry', {
    method,
    headers: auth ? { authorization: auth } : {},
  });

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.WEBHOOK_RETRY;
  batch.mockClear();
});

describe('POST /api/internal/webhooks/retry', () => {
  it('refuses everything (503) when CRON_SECRET is not set', async () => {
    expect((await POST(req('Bearer anything'))).status).toBe(503);
    expect(batch).not.toHaveBeenCalled();
  });

  it('401 without or with a wrong secret', async () => {
    process.env.CRON_SECRET = 's3cret';
    process.env.WEBHOOK_RETRY = 'on';
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req('Bearer nope'))).status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
  });

  it('does nothing while WEBHOOK_RETRY is off', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await POST(req('Bearer s3cret'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.skipped).toBe(true);
    expect(batch).not.toHaveBeenCalled();
  });

  it('runs one batch and returns the counts (POST and GET)', async () => {
    process.env.CRON_SECRET = 's3cret';
    process.env.WEBHOOK_RETRY = 'on';
    const res = await POST(req('Bearer s3cret'));
    expect((await res.json()).data).toMatchObject({ claimed: 2, delivered: 1 });
    expect((await GET(req('Bearer s3cret', 'GET'))).status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(2);
  });
});
