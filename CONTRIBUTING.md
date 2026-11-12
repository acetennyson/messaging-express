# Contributing

Thanks for helping. This page covers how to set up, how the code is organised, the rules the project follows, and how to send a change.

## Set up

```bash
git clone https://github.com/acetennyson/messaging-express.git
cd messaging-express
nvm use                       # Node 22 (see .nvmrc)
npm ci
cp .env.example .env.local    # set DATABASE_URL and JWT_SECRET
npx tsx --env-file=.env.local scripts/migrate.ts
npm run dev:socket            # API + Socket.IO on http://localhost:3000
```

A throwaway Postgres (and Redis) is one command: `docker compose --env-file .env.docker up -d db redis` (see [Deployment](docs/deployment.md#docker)). [Getting started](docs/getting-started.md) shows how to create an organization, a project and a token.

## Layout

```
app/api/v1/        REST routes (users, conversations, messages, uploads, devices)
app/api/health     health check;  app/api/internal  cron-only routes;  app/uploads  serves local files
lib/               auth, db, rate-limit, realtime, webhooks, storage, e2ee, events, errors, config/flags
server.ts          custom entrypoint: Next + Socket.IO + graceful shutdown
scripts/           migrate, token helper, smoke and soak tests, verification scripts
packages/client    @messaging-express/client (TypeScript SDK)
packages/client-crypto   @messaging-express/client-crypto (end-to-end encryption for the SDK)
docs/              documentation (start at docs/README.md)
```

Read [Architecture](docs/architecture.md) first; it explains how a request flows and where each piece lives.

## Rules the project follows

1. **New behaviour goes behind a switch that defaults to off**, and with the switch off the route must behave exactly as before, including response bodies. Switches are read from the environment per request (`lib/config/flags.ts`), never at import time, so they can be rolled back without a deploy.
2. **Migrations only add.** Add a new entry at the end of `scripts/migrate.ts`; make it idempotent (`IF NOT EXISTS`). Never edit or reorder an existing entry.
3. **Every query is scoped to the project** from the verified token. A route that reads or writes a row without checking its project is a tenant leak.
4. **Errors use the typed errors in `lib/errors.ts`.** Never return internal error text to a client; the mapper returns a generic `500`.
5. **Side effects go through `emitEvent`** (webhook and realtime), after the data is ready. It never throws into the request.
6. **Do not edit frozen test vectors** (`packages/client-crypto/test/vectors`) to make a test pass. A failing vector means the code changed the wire format; fix the code, or add a new format version.
7. **Update the docs in the same change** (see below).

## Tests

```bash
npm test                    # server unit and integration tests (vitest)
npm run lint
npm run test:sdk            # client SDK
npm run test:crypto         # encryption package
```

Some server suites need `DATABASE_URL` pointing at a database that has the seed data (`psql "$DATABASE_URL" -f scripts/smoke-seed.sql`); the Redis suite needs `REDIS_URL`. They are skipped when the variable is missing. Behaviour scripts you can run against a running server: `scripts/smoke.sh` (response shapes), `scripts/test-webhooks.sh`, `scripts/test-realtime.mjs`, `scripts/test-realtime-cluster.mjs` (two instances sharing Redis), `scripts/test-rate-limit-*.sh`, `scripts/verify-e2ee.mjs` and `scripts/smoke-e2ee.mjs`. For long runs see [Load testing](docs/load-testing.md).

**Golden HTTP test.** `scripts/golden-http.mjs` drives every REST route with the full token matrix (no token, bad, expired, api, admin, a member, a non-member) and compares status, headers and the normalised response **values** with a recorded baseline in `scripts/baselines-golden/`. Run it after any refactor of server code, against a server started with the same settings as the baseline's label:

```bash
# server started with PARTICIPANT_ACCESS_MODE=off E2EE_ENABLED=off RATE_LIMIT_MODE=off
JWT_SECRET=... GOLDEN_LABEL=access-off node scripts/golden-http.mjs
# server started with PARTICIPANT_ACCESS_MODE=enforce E2EE_ENABLED=on RATE_LIMIT_MODE=off
JWT_SECRET=... GOLDEN_LABEL=access-enforce node scripts/golden-http.mjs
```

It prints every difference and exits 1 on any. Re-record (`--record`) only for an intended, reviewed behaviour change, in the same change as the code.

A change that alters a response shape needs the smoke baselines in `scripts/baselines/` re-recorded in the same change, with a note in the changelog.

## Documentation

- User-facing behaviour changes: update the page in `docs/` (API reference, configuration, and the feature's own page) and add a line to `CHANGELOG.md`.
- New environment variable: add it to `docs/configuration.md` and `.env.example`.
- New route: add it to `docs/api-reference.md` with a real request and response.
- Write for someone who has never seen the project: say what it is for, show a working example, then list the details. Keep release-process notes out of the docs; describe what the system does now.

## Sending a change

1. Branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Keep the change focused; explain what and why in the pull request.
3. Use conventional commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
4. Make sure `npm run lint` and the tests pass.

Reporting a bug? Include the request, the response, the relevant log lines (with secrets removed), your Node version and how you run the server. Found a security problem? Do not open a public issue; contact the maintainer directly.

## Releasing

Maintainers: see [Releasing](docs/releasing.md).
