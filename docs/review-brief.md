# Review brief: the two things to review before the first release

The first publish of `@messaging-express/server` is gated on an independent review of the **single-tenant authentication path** and the **migration runner**. This page is the brief for the reviewer: what to read, what must hold, how it is tested, and where the author is least sure. The reviewer should be someone who did not write the code and should be free to say "do not ship".

The server package is not cryptography (that is `client-crypto`, reviewed separately, see [releasing](releasing.md)); both areas here are about who may act, and what happens to someone's database.

## 1. Single-tenant authentication

**Read:** `packages/server/src/auth/single-tenant.ts` (the strategy and the project upsert), `auth/strategy.ts` (the interface), `auth/middleware.ts` (where it is called, rate limiting after it), `realtime/providers/socketio.ts` (the handshake uses `authenticateToken`), `options.ts` (`jwtSecret` length, `authenticate` validation).

**Must hold:**
1. A request is accepted only if it carries a JWT signed with the configured secret (HS256, unexpired, `type` in `user | api | admin`, `userId` present for `user`), or the customer's `authenticate(request)` returns a valid identity. Nothing else gets in; there is no default identity.
2. A token's `projectId` and `organizationId` are ignored: the module has one project, found by `projectName`, and every query is scoped to it. A token from another module instance with the same secret is valid, by design (the secret is the trust boundary); one with a different secret is not.
3. `authenticate` returning `null` is 401. A throw, a rejection, a timeout (`authenticateTimeoutMs`) or an invalid result is 503 with a generic body, never 401-then-allow and never an allow. Only our own JWT check runs first; the customer's function is not called for a valid JWT.
4. The realtime handshake accepts JWTs only (`authenticateToken`), never the customer function.
5. The project and its organization row are created once, at init, under a transaction-scoped advisory lock, so two instances starting together make one row. A second `projectName` makes a second, isolated project.
6. The participant rules (`participantAccess`) and the E2EE rules run after authentication in the shared core; the single-tenant path must not provide a way around them. They are the same code as the hosted server.

**Tests:** `auth/single-tenant.test.ts` (token cases, the `authenticate` contract), `conformance/module.test.ts` (isolation between schemas, secrets and projects), `server.test.ts` (init, concurrent init), `realtime/embedded.test.ts` (handshake, eviction), the golden HTTP comparison against the hosted server (`docs/embedding.md`).

**Where to push:** the `exp` handling for sockets (a token that expires while connected), a malformed `Authorization` header, a `userId` that is not a UUID or belongs to a deleted user, timing of the timeout versus a late resolution of `authenticate`, what the project upsert does when a second process uses the same schema with a different `projectName`.

## 2. The migration runner

**Read:** `packages/server/src/migrations/runner.ts` (about 150 lines), `steps.ts` (the numbered steps; only skim the SQL), `steps.snapshot.json` and `steps.test.ts` (shipped checksums), the `init` status check in `server.ts`, `cli.ts`.

**Must hold:**
1. Each step runs at most once, in order, and its record (`mx_schema_migrations`: name, applied_at, checksum) commits in the same transaction as the step (`BEGIN; step; record; COMMIT`), so a step is never applied but unrecorded. One exception by design: a step that starts with its own `BEGIN` (today only `0018`, which needs `SET LOCAL lock_timeout`) cannot be nested; it is idempotent (`IF NOT EXISTS`, a guarded `DO` block) and its record follows it, so a crash in that window means the step runs again, harmlessly. Is that exception acceptable?
2. Concurrent runners are serialised by a session advisory lock (`messaging-express:migrate:<schema>`); the status is read after the lock is held, so a second runner finds nothing to do.
3. A connection killed halfway leaves nothing committed from the unfinished step, and a re-run completes the work.
4. `--dry-run` creates nothing, not even the schema or the bookkeeping table.
5. Everything is qualified with the configured schema; a borrowed `pg.Pool` is never reconfigured and the migration connection is destroyed, not returned to the pool, so no `search_path` or lock state leaks into the customer's connections.
6. A database with a newer step than the code (`SchemaTooNewError`) or an edited shipped step (checksum mismatch) is refused at startup. Shipped steps are frozen by the snapshot test and are only ever appended.
7. The steps themselves are additive where possible and never drop customer data; none touches a schema other than the configured one.

**Tests:** `migrations/runner.test.ts` (order, idempotence, concurrency, a killed connection, dry run, newer and edited databases), `migrations/steps.test.ts` (snapshot), `conformance/module.test.ts` (an older database that already holds data upgrades in place), `core/package-rules.test.ts` (raw table names only in the allowed files).

**Where to push:** steps that take heavy locks on large tables (all current steps assume small or empty tables), behaviour behind a transaction-mode pooler (documented as unsupported for `migrate`), a role without `CREATE` on the database, `statement_timeout` / `lock_timeout` set on the role, and what a second major version of the runner would need to keep compatible.

## Known limits the reviewer should not have to rediscover

`close()` cannot remove the request and upgrade listeners the module adds to the customer's `http.Server`; there is no Redis rate-limit store; realtime events are not durable (webhooks retry, events do not); the module has no per-IP protection; `--adopt` (moving a hosted database into the module schema) is not built; local-disk uploads are per instance. The full list is in [compatibility.md](compatibility.md#not-supported-yet).

## How to run everything

```bash
npm install
DATABASE_URL=<throwaway db> TEST_SCHEMA_DATABASE_URL=<throwaway db> JWT_SECRET=<32+ chars> npx vitest run     # the full suite
node packages/server/scripts/build-package.mjs && SMOKE_DATABASE_URL=<throwaway db> node packages/server/scripts/smoke-pack.mjs
SMOKE_DATABASE_URL=<throwaway db> node packages/server/scripts/smoke-examples.mjs
```

Use a database you can lose: the tests create and drop their own schemas but run real migrations.
