# Compatibility

What has been run together, and what has not. "Tested" means the repository's own checks ran against it (the test suite, the golden HTTP comparison with the hosted server, the contract check, the browser tour and the pack-and-install smoke tests).

## Packages and contracts

| `@messaging-express/server` | `client` | `client-crypto` | E2EE contract | Schema version | Status |
|---|---|---|---|---|---|
| 0.x (unreleased) | 0.1.x | 0.x (pre-release, not independently reviewed) | 1 ([e2ee/api.md](e2ee/api.md)) | 19 | the first release |

`GET <root>/meta` returns `{ moduleVersion, contractVersion, schemaVersion }` so a client can check what it is talking to. `contractVersion` changes only when the HTTP contract changes in a way a client must know about; the server and `client-crypto` of the same contract version work together. A server package never goes backwards on the schema: a newer database than the code refuses to start (`SchemaTooNewError`).

## Runtime

| | Tested | Notes |
|---|---|---|
| Node.js | 22 locally; 20, 22 and 24 in CI (`.github/workflows/server-package.yml`) | `engines: node >=20` |
| Express | 4.22 and 5.3 | no Express dependency: any object with `use(path, handler)` works; plain `http` is supported |
| PostgreSQL | 18 locally; 16 in CI | uses plain SQL, `jsonb`, advisory locks and `ON CONFLICT`; managed services (Supabase, RDS, Neon) are expected to work but are not part of the automated checks. Behind a transaction-mode pooler (PgBouncer, the Supabase pooler on port 6543) migrations take a session advisory lock, so run `migrate` against a direct or session-mode connection |
| Socket.IO | 4.8 (a dependency) | your own `Server` can be passed to `attachRealtime`; several instances need Redis (`ioredis` and `@socket.io/redis-adapter`, optional peers) |
| S3-compatible storage | tested against a local S3 endpoint; the code uses the AWS SDK v3 | AWS, Cloudflare R2, Supabase Storage, MinIO and others are expected to work |
| Bundlers / serverless | not tested | the package is plain Node; Next.js, Fastify and Hono adapters are not included |

## Not supported yet

Multi-tenant mode inside the module (use the hosted server), a Redis rate-limit store, adopting an existing hosted database into the module's schema, per-IP limits, a durable event outbox (webhook retries are durable, realtime events are not), and a table prefix in place of a schema.
