# Realtime

Live delivery over Socket.IO, so a client sees a new message as soon as it is saved instead of polling.

Realtime is **off by default**. Turn it on with `REALTIME_PROVIDER=socketio` (see [Configuration](configuration.md)). It needs the custom server in `server.ts`: `npm run dev:socket` while developing, `npm run build && npm start` in production. Plain `npm run dev` (`next dev`) and `npm run nextstart` serve the REST API only, with no `/socket.io`.

## How it works

```
Your backend  ─POST /messages─►  Messaging Express  ─save─►  Postgres
                                        │
                                        └─ event "message.created" ─► room conversation:<id>
                                                                          │
Browser / app ◄───── Socket.IO (same host and port as the API) ──────────┘
```

Events are published after the HTTP response has been sent, so a slow socket never slows an API call. A message is always stored first; realtime is a delivery path, not storage. Clients should still fetch history with `GET /messages` on load and after reconnecting.

## Connecting

The socket server lives on the same origin as the REST API, path `/socket.io`. Authenticate with the same JWT you use for REST.

```js
import { io } from 'socket.io-client';

const socket = io('https://chat.example.com', {
  auth: { token: userToken },   // a user token for this user
});

socket.on('connect_error', (err) => console.log(err.data?.code)); // AUTH_REQUIRED | INVALID_TOKEN | PROJECT_INACTIVE

// Join a conversation to receive its events. The ack tells you if it worked.
socket.emit('join-conversation', { conversationId }, (res) => {
  if (!res.ok) console.log('could not join:', res.code);
});

socket.on('message.created', (msg) => {
  console.log(msg.sender.name, msg.content);
});
```

If you use the TypeScript SDK (`@messaging-express/client`), it wraps all of this, including reconnecting with a fresh token. See [its README](../packages/client/README.md).

### Client → server events

| Event | Payload | Ack |
|---|---|---|
| `join-conversation` | `{ conversationId }` | `{ ok: true }` or `{ ok: false, code }` |
| `leave-conversation` | `{ conversationId }` | same |

Ack codes: `INVALID_PAYLOAD` (not a UUID), `FORBIDDEN` (not a participant, not in this project, or the token has no user), `RATE_LIMITED` (more than 20 join or leave calls per 10 seconds on one socket), `INTERNAL_ERROR`.

An api or admin token can connect (for monitoring), but it has no `userId`, so it cannot join conversation rooms.

### Server → client events

Each event arrives under its own name, with the event data as the payload.

| Event | Sent to | Payload |
|---|---|---|
| `message.created` | Everyone in room `conversation:<id>` | The same object `POST /messages` returns |
| `conversation.created` | Not sent to realtime today (webhook only) | |
| `participant.added`, `participant.removed` | Each participant's personal room, `user:<userId>` | Encrypted conversations only, see the [E2EE API](e2ee/api.md#realtime-events) |
| `device.added`, `device.removed`, `keys.updated`, `keys.requested` | `user:<userId>` | Encrypted conversations only |

After a verified handshake, every socket whose token has a `userId` automatically joins `user:<userId>`. No client event is involved, so there is nothing to forge.

## Tokens and expiry

A socket never outlives its token: the server disconnects it at the moment the token expires. Reconnect with a fresh token (the SDK does this for you through its `auth` callback). Tokens for sockets should be minted by your backend like any other user token ([Authentication](authentication.md)).

## Scenario: a group chat

1. Your backend creates users and a conversation (`POST /users`, `POST /conversations`).
2. Alice opens the chat page. Your backend gives her a user token. Her browser connects and emits `join-conversation` for that conversation.
3. Bob does the same.
4. Bob sends a message (browser → your backend or directly `POST /messages` with his token).
5. The server saves it, then emits `message.created` to the room: Alice's open page shows it instantly.
6. Carol is removed from the group. Her sockets leave the room at once, so she stops receiving messages even before she reloads.

## Several server instances

By default, rooms live in the memory of one process. With more than one instance behind a load balancer, set `REDIS_URL` so events published on instance A reach sockets connected to instance B. Without Redis, a client connected to another instance never sees the event. The TypeScript SDK connects with WebSocket only by default, which needs no sticky sessions; with the Socket.IO long-polling fallback enabled you need them. See [Deployment](deployment.md#scaling-out).

## CORS

Socket.IO uses the same `CORS_ALLOWED_ORIGINS` as the REST API (default `*`). See [Authentication](authentication.md#browsers-and-cors).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `connect_error` with `INVALID_TOKEN` | Token expired, wrong `JWT_SECRET`, or not a JWT from this server |
| Connected but nothing arrives | Forgot `join-conversation`, or the ack returned `FORBIDDEN` (user is not a participant) |
| Works locally, not with two instances | `REDIS_URL` not set |
| No `/socket.io` endpoint | `REALTIME_PROVIDER` not set to `socketio`, or you started with `npm run dev` / `npm run nextstart` instead of `npm run dev:socket` / `npm start` |

More in [Troubleshooting](troubleshooting.md).
