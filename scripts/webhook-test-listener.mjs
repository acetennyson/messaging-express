// Tiny webhook receiver for scripts/test-webhooks.sh (Implementation Plan Stage 4.3).
//   /ok    -> 200 immediately
//   /fail  -> 500
//   /slow  -> waits SLOW_MS (default 10000), then 200
// Every delivery is appended to OUT as one JSON line, including whether the
// X-Webhook-Signature matched an independently computed HMAC-SHA256 of the raw body
// (the way a customer's receiver would verify it).
import http from 'http';
import fs from 'fs';
import { createHmac, timingSafeEqual } from 'crypto';

const PORT = Number(process.env.PORT || 9400);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.WEBHOOK_SECRET || '';
const OUT = process.env.OUT || '/tmp/mx-webhooks.jsonl';
const SLOW_MS = Number(process.env.SLOW_MS || 10000);

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const expected = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
      const got = String(req.headers['x-webhook-signature'] || '');
      const sigValid = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
      let body = null;
      try { body = JSON.parse(raw.toString()); } catch {}
      fs.appendFileSync(OUT, JSON.stringify({ path: req.url, event: req.headers['x-webhook-event'], sigValid, body }) + '\n');

      if (req.url === '/fail') { res.writeHead(500); return res.end('{"error":"boom"}'); }
      if (req.url === '/slow') { return setTimeout(() => { res.writeHead(200); res.end('ok'); }, SLOW_MS); }
      res.writeHead(200); res.end('ok');
    });
  })
  .listen(PORT, HOST, () => console.log(`webhook test listener on ${HOST}:${PORT}`));
