# M0: golden HTTP safety net (embedded-server plan)

Adds files only. No server code, route, flag or dependency changes.

## What
- `scripts/golden-http.mjs`: 97 calls over every REST route with the token matrix (none, bad, expired, wrong secret, unknown project, api, admin, member, non-member). Records status, content-type, CORS, cache-control, retry-after presence, rate-limit header names and the **normalised body with values** (ids to `<id:N>`, timestamps to `<ts>`, run id to `<run>`).
- `scripts/baselines-golden/access-off.json`: today's default behaviour (`PARTICIPANT_ACCESS_MODE=off`, `E2EE_ENABLED=off`).
- `scripts/baselines-golden/access-enforce.json`: `PARTICIPANT_ACCESS_MODE=enforce`, `E2EE_ENABLED=on`.
- `CONTRIBUTING.md`: how to run it.

## Evidence
- Reproducible: three consecutive `--print` runs on the same server are byte-identical.
- Sensitive: running the `access-off` baseline against the enforce server reports 33 differences (impersonation, outsider reads, foreign listing and the encryption routes all change).
- Existing bars still green on the same code: server suite 264 passed / 5 skipped; `verify-crypto` PASSED against the enforce server.

## Notes
- Needs a server with rate limiting off or dry-run (a 429 aborts the run). It writes data: dev/staging only (refuses non-localhost unless `GOLDEN_ALLOW_REMOTE=1`).
- It only needs the org and project rows from `scripts/smoke-seed.sql`; every user and conversation it uses is created per run, so repeated runs never collide.
- Deep encryption behaviour stays with `verify-e2ee.mjs`, `smoke-e2ee.mjs` and `verify-crypto`; the golden script freezes each encryption route's status and body.
- `next dev` allows one dev server per checkout, so run the two configurations one after the other.

Optional root script line (yours to add): `"golden": "node scripts/golden-http.mjs"`

## Rollback
Delete the files.
