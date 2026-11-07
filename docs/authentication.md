# Authentication

Every request to `/api/v1/*` carries a JWT in the `Authorization` header:

```
Authorization: Bearer <token>
```

There are no sessions, no cookies and no API-key headers. The token is signed by **your backend** with the `JWT_SECRET` you configured on the server (HS256, the `jsonwebtoken` default), and the server only verifies it.

## The token

| Claim | Required | Meaning |
|---|---|---|
| `projectId` | yes | Which project the token is for. Must be an active project in an active organization. |
| `type` | yes | `user`, `api` or `admin`. See [Concepts](concepts.md#three-kinds-of-token). |
| `userId` | for `user` tokens | The Messaging Express user id (the UUID, not your `externalId`). |
| `organizationId` | no | Accepted but ignored: the organization always comes from the project row. |
| `exp` | recommended | Expiry. The server rejects expired tokens but does not require an `exp`; **always set one**. |

Rules of thumb:

- **User tokens: short lifetime** (for example 1 hour), refreshed by your backend while the user is logged in.
- **api / admin tokens: only on your servers.** Never ship them in a mobile app, a web page or a repository. If one leaks, rotate `JWT_SECRET` (which invalidates every token) and issue new ones.
- The server never stores tokens and cannot revoke a single one; expiry is the revocation mechanism. Keep user tokens short for that reason.

## Minting a user token

The flow, end to end:

1. A user logs in to your app, the way you always do it.
2. Your backend finds (or creates) their Messaging Express user: `POST /api/v1/users` with `externalId` = your user id. The response contains the user `id`.
3. Your backend signs a `user` token for that `id` and returns it to the client app.
4. The client uses the token for REST calls and for the realtime connection.

### Node.js

```js
import jwt from 'jsonwebtoken';

export function chatTokenFor(messagingUserId) {
  return jwt.sign(
    { projectId: process.env.MX_PROJECT_ID, userId: messagingUserId, type: 'user' },
    process.env.MX_JWT_SECRET,            // the same value as JWT_SECRET on the server
    { expiresIn: '1h' }
  );
}
```

### Python

```python
import time, jwt  # pip install pyjwt

def chat_token_for(messaging_user_id: str) -> str:
    return jwt.encode(
        {"projectId": PROJECT_ID, "userId": messaging_user_id, "type": "user", "exp": int(time.time()) + 3600},
        JWT_SECRET, algorithm="HS256",
    )
```

### PHP

```php
use Firebase\JWT\JWT;  // composer require firebase/php-jwt

function chatTokenFor(string $messagingUserId): string {
    return JWT::encode([
        'projectId' => PROJECT_ID, 'userId' => $messagingUserId, 'type' => 'user', 'exp' => time() + 3600,
    ], JWT_SECRET, 'HS256');
}
```

### Command line (api token)

```bash
node --env-file=.env.local scripts/generate-token.js <PROJECT_ID> <ORGANIZATION_ID> api
```

The script makes a 7-day token of the type you give (`api` by default, or `admin`). It cannot make a `user` token, because it has no `userId` option; use the snippets above.

## What a backend token does that a user token does not

- It may call any route for any user in the project: create users, create conversations on behalf of people, send as any participant, read any conversation.
- It is not subject to [participant access rules](access-control.md).
- It is the only kind accepted by admin-only operations, such as `POST /users/:userId/devices/reset`.

## The realtime handshake

Socket.IO clients send the same token in the handshake: `io(url, { auth: { token } })`. See [Realtime](realtime.md#connecting).

## Authentication errors

| Situation | Status | `error.code` | `error.message` |
|---|---|---|---|
| No `Authorization: Bearer ...` header | 401 | `UNAUTHORIZED` | Missing authentication token |
| Bad signature, malformed or expired token | 401 | `UNAUTHORIZED` | Invalid or expired token |
| Project does not exist or is inactive | 401 | `UNAUTHORIZED` | Project not found or inactive |
| Organization is inactive | 401 | `UNAUTHORIZED` | Organization inactive |
| Database failed while checking the project | 500 | `INTERNAL_ERROR` | Internal server error (this is not the caller's fault; see [Troubleshooting](troubleshooting.md)) |

A `403 FORBIDDEN` is different: the token is valid but the action is not allowed for it (see [Access control](access-control.md)).

## Browsers and CORS

A browser app calls the API directly, so the server has to allow its origin. `CORS_ALLOWED_ORIGINS` controls this:

- **Not set (the default): any origin is allowed** (`Access-Control-Allow-Origin: *`). Convenient for development. Because authentication is a bearer token (no cookies), this is not a login hole, but set an explicit list in production so only your own web apps can call the API from a browser.
- **A comma-separated list of exact origins**, for example `CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com`. Write it **without spaces** after the commas and without a trailing slash; matching is exact. An origin that is not in the list gets no CORS headers, so the browser blocks the call.

Server-to-server calls (your backend, curl) are not affected by CORS. The same variable is read once at start-up; restart after changing it. More in [Configuration](configuration.md#cors).
