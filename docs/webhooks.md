# Webhooks

Messaging Express can call **your** server when things happen (a message was sent, a user was created). Use webhooks to send push notifications, keep your own database in sync, moderate content, or trigger email.

Webhooks are **off by default**: set `WEBHOOK_DISPATCH=on`. Each organization has one webhook URL and one secret, stored on the `mx_organizations` row (if an organization has no secret, the server-wide `WEBHOOK_SECRET` variable is used instead) (set with SQL; there is no endpoint for it, see [Getting started](getting-started.md#5-create-an-organization-and-a-project)).

```sql
UPDATE mx_organizations
SET webhook_url = 'https://api.example.com/hooks/chat', webhook_secret = 'a-long-random-string'
WHERE id = '<organization id>';
```

## What gets sent

| Event | When |
|---|---|
| `message.created` | After `POST /messages` |
| `conversation.created` | After `POST /conversations` |
| `user.created`, `user.updated` | After `POST /users` (created, or replaced) |
| `device.added`, `device.removed` | A user's device list changed (E2EE on) |

Membership and key events (`participant.added`, `participant.removed`, `keys.updated`, `keys.requested`) go to [realtime](realtime.md) only, never to webhooks. Other names that appear in the code (`message.updated`, `message.deleted`, `user.online`, ...) are reserved and not sent today.

Every request is a `POST` with a JSON body:

```json
{
  "event": "message.created",
  "timestamp": "2026-11-05T12:01:45.238Z",
  "projectId": "d26373b8-...",
  "data": { "id": "6e08b0c6-...", "conversation_id": "...", "sender_id": "...", "content": "Hello Bob", "...": "..." }
}
```

`data` is the same object the API returned for the call that caused the event. Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Webhook-Event` | The event name, e.g. `message.created` |
| `X-Webhook-Signature` | `sha256=<hex HMAC-SHA256 of the raw body, keyed with the organization's secret>` |

Your endpoint must reply `2xx` within `WEBHOOK_TIMEOUT_MS` (default 5000 ms). Anything else counts as a failure.

## Verifying the signature

Always verify. Anyone can POST to your URL; only Messaging Express can compute this signature. Use the **raw** request body, before any JSON parsing, and a constant-time comparison.

```js
// Express
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();
app.post('/hooks/chat', express.raw({ type: 'application/json' }), (req, res) => {
  const expected = 'sha256=' + createHmac('sha256', process.env.CHAT_WEBHOOK_SECRET).update(req.body).digest('hex');
  const got = req.get('X-Webhook-Signature') || '';
  const ok = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);

  const { event, data } = JSON.parse(req.body);
  if (event === 'message.created') notifyRecipients(data);   // your logic
  res.sendStatus(200);                                       // reply fast, work async
});
```

```python
# Python (Flask)
import hmac, hashlib, os
from flask import request, abort

@app.post("/hooks/chat")
def hook():
    raw = request.get_data()
    expected = "sha256=" + hmac.new(os.environ["CHAT_WEBHOOK_SECRET"].encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-Webhook-Signature", "")):
        abort(401)
    event = request.get_json()
    return "", 200
```

## Retries

With `WEBHOOK_RETRY=off` (default) each event is tried **once**. A failure is logged and forgotten.

With `WEBHOOK_RETRY=on`, a failed delivery (non-2xx, timeout, network error) is retried with growing delays. Attempts: the first, then after 1 minute, 5 minutes, 30 minutes and 2 hours: five attempts in all, then it is given up. Every retry sends the byte-identical body with a valid signature, so your handler can treat it like the first.

Retries are driven by a worker you call on a schedule:

```
POST https://chat.example.com/api/internal/webhooks/retry
Authorization: Bearer <CRON_SECRET>
```

Call it every minute from cron, a Kubernetes CronJob, GitHub Actions or any scheduler. Several workers at once are safe (a row is only ever taken by one of them). Set `CRON_SECRET` to a long random string; without it the route refuses.

```cron
* * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://chat.example.com/api/internal/webhooks/retry
```

If you remove the organization's `webhook_url` while retries are pending, they are closed with "no longer configured".

## Design your handler for duplicates

Delivery is **at least once**. A retry can arrive after your server did process the first call (for example, you answered after the timeout). Make handlers idempotent: store the message `data.id` and skip if you have seen it.

## Delivery log

Every attempt is a row in `mx_webhook_logs` (event, URL, payload, status, attempts, next retry). Query it to debug:

```sql
SELECT event_type, response_status, attempts, completed_at, response_body
FROM mx_webhook_logs ORDER BY created_at DESC LIMIT 20;
```

Columns: `id, project_id, event_type, payload, url, response_status, response_body, attempts, next_retry_at, created_at, completed_at`.

## Webhooks vs realtime

| | Webhooks | [Realtime](realtime.md) |
|---|---|---|
| Receiver | your server | your users' browsers/apps |
| Delivery | at least once, retried | best effort, live only |
| Typical use | push notifications, sync, moderation | showing the message on screen |

Use both: realtime for people with the chat open, a webhook to notify the ones who do not.
