# Realtime, events and webhooks (embedded)

Three ways to get events to clients. Pick one realtime path; webhooks are independent.

## 1. Socket.IO on your http.Server

```ts
const server = http.createServer(app);
await chat.attachRealtime(server, { path: '/chat/socket.io' });   // default path
server.listen(3000);
// client: io(url, { path: '/chat/socket.io', auth: { token } })
```

Same wire contract as the hosted server: the handshake takes the same JWT; `join-conversation` succeeds only for a current participant of a conversation in this project; every socket with a `userId` joins its `user:<id>` room; events arrive under their own names (`message.created`, `device.added`, `participant.removed`, ...).

- Attaching twice to the same `http.Server` rejects. `onEvent` and `attachRealtime` exclude each other.
- **Your own Socket.IO server:** `attachRealtime(server, { io })`. We then live in a dedicated namespace (default `/messaging-express`, option `namespace`), so your own sockets never meet our authentication, and we never close your server. Clients connect to `url + '/messaging-express'`.
- **More than one instance needs Redis**, or an event published on instance A never reaches a socket on instance B (no error). `attachRealtime(server, { redisUrl })`; with your own `io`, configure the adapter on that server.
- `chat.close()` disconnects our sockets and refuses new handshakes. It does not close your `http.Server`; our request/upgrade listeners stay on it until you close it.

## 2. Your own transport: `chat.onEvent`

```ts
chat.onEvent(async (event) => {            // { type, data, audience }
  if (event.type === 'participant.removed') {
    rooms.get(event.data.conversationId)?.delete(event.data.userId);   // evict at once
  }
  const to = event.audience.kind === 'users' ? event.audience.userIds : [...(rooms.get(event.audience.conversationId) ?? [])];
  for (const userId of to) send(userId, event.type, event.data);
});

// when someone subscribes to a conversation:
if (await chat.authorizeJoin(userId, conversationId)) rooms.get(conversationId).add(userId);
else refuse();
```

**Authorize at subscribe time, not per event.** Two audience kinds:

- `{ kind: 'users', userIds }`: a small explicit list, for private events (a device event for one user, a key request).
- `{ kind: 'conversation', conversationId }`: no list, for conversation events such as `message.created`. Your room is the list. `chat.listAudience(event, { limit, cursor })` returns the full recipient list one page at a time, only when you ask.

`authorizeJoin(userId, conversationId)` is exactly the check behind `join-conversation`: the conversation belongs to this project and the user is a participant right now; unknown, malformed and removed all answer `false`.

**Removal:** removing a participant always emits `participant.removed` with `data: { conversationId, userId }` (also for unencrypted conversations), so you can take them out of that room immediately. For encrypted conversations the same event also goes to every remaining participant (with `minKeyVersion`); evicting is idempotent.

Honest limit: nothing can force your transport to call `authorizeJoin`. The built-in Socket.IO path is safe by default; a custom path is exactly as safe as the check you put in front of your rooms.

## 3. Webhooks

```ts
await MessagingServer.init({ ..., webhook: { url: 'https://api.example.com/chat-events', secret: 'whsec_...' } });
```

Each event is POSTed with `X-Webhook-Event` and `X-Webhook-Signature: sha256=<HMAC-SHA256 of the raw body with your secret>`. Failed deliveries are recorded (`mx_webhook_logs`) and retried with backoff by an in-process loop every `retryIntervalMs` (default 30 s; `retry: false` turns it off). `close()` stops the loop.

## Delivery guarantees (D12)

Webhooks and realtime events run **after** the response, in memory. If the process dies right after replying, that event can be lost, exactly as on the hosted server. Recorded webhook failures are retried. `close({ timeoutMs })` (default 10 s) waits for in-flight work, then gives up and logs `shutdown_forced`. A durable outbox is parked for a later release.
