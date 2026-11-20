# Examples

Each server example is about 25 lines. Before anything is published to npm, install the packages from tarballs (see below); the
repository's `packages/server/scripts/smoke-examples.mjs` does exactly this and runs all of it.

| folder | what it shows |
|---|---|
| `express-basic/` | the module inside an Express app: mount order, uploads, CORS, realtime, graceful shutdown |
| `http-basic/` | the same on a plain `http` server, no framework |
| `client/plain.mjs` | a client that creates users, a conversation and a message (`@messaging-express/client`) |
| `client/encrypted.mjs` | the same, end-to-end encrypted (`@messaging-express/client-crypto`, pre-release) |

```bash
cd examples/express-basic && npm install
DATABASE_URL=postgres://... CHAT_JWT_SECRET=a-secret-of-at-least-32-characters-long npm start
# in another terminal, in examples/client (after npm install jsonwebtoken @messaging-express/client [client-crypto])
CHAT_JWT_SECRET=a-secret-of-at-least-32-characters-long node plain.mjs
```

The client examples sign their own tokens with the shared secret to stay short. In a real app your backend does that after
logging the user in, and the secret never leaves it.
