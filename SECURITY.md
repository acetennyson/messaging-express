# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email the maintainer (see the repository owner's GitHub profile) or use GitHub's "Report a vulnerability" on the repository's Security tab. Include what you found, how to reproduce it and the version. You will get an acknowledgement; fixes are released as patch versions and noted in the [CHANGELOG](CHANGELOG.md).

## Using the embedded module (`@messaging-express/server`) safely

- **Whoever knows `jwtSecret` can act as anyone.** It signs every token: user, api and admin. Keep it in your server's secret store, never in a browser, a mobile app, a repository or a log. Use 32+ random characters (the module refuses shorter ones) and rotate it like a password: changing it signs every client out.
- **API and admin tokens are server-side only.** They are never limited by participant rules. Give clients user tokens, minted by your backend after it has logged the user in. A user token's `userId` decides who they are, so mint it only for the user who authenticated.
- **If you use `authenticate(request)`,** it is your login. Return `null` for anything you do not recognise; never return `{ type: 'api' }` or `{ type: 'admin' }` for a request a browser can make. A throw or a timeout becomes a 503, never an allow.
- **Use HTTPS** in front of the app. Tokens travel in the `Authorization` header and in the Socket.IO handshake.
- **CORS is off by default.** Set `cors: ['https://app.example.com']` to the origins you mean; `['*']` is for development.
- **Uploads:** an S3 bucket (or CDN) that serves attachments must be readable by your clients, so treat file URLs as unguessable-but-public. Anything private belongs in an end-to-end-encrypted conversation: the file is encrypted before upload and the server stores an opaque blob. Set `limits` to the sizes and types you accept.
- **Your database.** The module creates its tables in its own schema (`messaging` by default) and never reads or changes yours. Use a database role that can create that schema for `migrate`; the running app needs only read and write on it. Back up before a release that adds migration steps.
- **Rate limits** are per user, off by default, and `memory` counters are per process. Per-IP limits and protection of unauthenticated routes belong in your reverse proxy.
- **Errors never leak:** an unexpected failure is a generic 500; the cause is logged on your side. Do not forward the logs to clients.
- **Realtime on your own transport.** The built-in Socket.IO path authenticates the handshake and puts users only in rooms they belong to. If you use `onEvent` to deliver events through your own transport, you must check membership yourself: use `authorizeJoin` when a client subscribes, and act on `participant.removed` events by dropping that user from the conversation. The module cannot force you to.

## What end-to-end encryption does and does not protect

With E2EE on for a conversation, message text and attachments are encrypted on the clients and the server stores ciphertext. The server and your database administrators cannot read them. It does not hide metadata: who is in a conversation, who sends when, message sizes and timing, device records and public keys remain visible to the server and to you. The server cannot verify that a ciphertext is well formed beyond its envelope, so a malicious client can store garbage that other members fail to decrypt. Key backup is only as strong as the passphrase the user chooses. The client library `@messaging-express/client-crypto` is pre-release and has not had an independent cryptographic review; see [E2EE overview](docs/e2ee/overview.md) for the threat model and its limits.
