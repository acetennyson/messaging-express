#!/usr/bin/env bash
# Implementation Plan Stage 3.5 (cleanup half), compressed.
#
# Proves: the opportunistic ~1% cleanup in lib/rate-limit/providers/postgres.ts
# actually deletes long-expired mx_rate_limits rows, without waiting for real
# traffic to hit that 1% chance naturally. We plant one already-expired row,
# then fire enough rate-limited requests that NOT triggering the 1% chance at
# least once is astronomically unlikely (300 requests -> ~95% chance of at
# least one cleanup firing; rerun once if unlucky).
#
# Needs the server running with RATE_LIMIT_MODE=dry-run or enforce (cleanup
# only runs inside the limiter's check(), which only runs when mode != off):
#   export RATE_LIMIT_MODE=dry-run     # or enforce; either works for this test
#   export RATE_LIMITS_JSON='{"messages:GET":{"limit":100000,"windowMs":60000}}'
#   JWT_SECRET=... DATABASE_URL=... npm run dev
#
# Then: JWT_SECRET=... DATABASE_URL=... bash scripts/test-rate-limit-cleanup.sh
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-4000-8000-0000000000a2}"
ORGANIZATION_ID="${ORGANIZATION_ID:-00000000-0000-4000-8000-0000000000a1}"
CONVERSATION_ID="${CONVERSATION_ID:-00000000-0000-4000-8000-0000000000c1}"
REQUEST_COUNT="${REQUEST_COUNT:-300}"

: "${JWT_SECRET:?export JWT_SECRET (same value the dev server is using)}"
: "${DATABASE_URL:?export DATABASE_URL (same one the dev server is using)}"
command -v psql >/dev/null || { echo "psql is required"; exit 2; }

TOKEN="$(PROJECT_ID="$PROJECT_ID" ORGANIZATION_ID="$ORGANIZATION_ID" node -e \
  "process.stdout.write(require('jsonwebtoken').sign({projectId:process.env.PROJECT_ID,organizationId:process.env.ORGANIZATION_ID,type:'api'},process.env.JWT_SECRET,{expiresIn:'1h'}))")" \
  || { echo "could not mint a token (run npm ci first)"; exit 2; }

echo "1) Planting a probe row that's already 90 minutes expired..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
INSERT INTO mx_rate_limits (key, count, window_start, expires_at)
VALUES ('rl:test:cleanup-probe', 1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '90 minutes')
ON CONFLICT (key) DO UPDATE SET expires_at = NOW() - INTERVAL '90 minutes';
" || { echo "Could not insert probe row — check DATABASE_URL and that mx_rate_limits exists."; exit 2; }

echo "2) Firing $REQUEST_COUNT rate-limited requests (20 at a time) so the ~1%"
echo "   cleanup chance almost certainly fires at least once..."
i=0
while [ "$i" -lt "$REQUEST_COUNT" ]; do
  for _ in $(seq 1 20); do
    i=$((i+1))
    [ "$i" -gt "$REQUEST_COUNT" ] && break
    curl -s -o /dev/null "$BASE_URL/api/v1/messages?conversationId=$CONVERSATION_ID&limit=1" \
      -H "Authorization: Bearer $TOKEN" &
  done
  wait
  printf '\r   ...%d/%d' "$i" "$REQUEST_COUNT"
done
echo

echo "3) Checking whether the probe row survived..."
left="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM mx_rate_limits WHERE key='rl:test:cleanup-probe';")"

echo
if [ "$left" = "0" ]; then
  echo "PASS: the expired probe row is gone. Stage 3.5's cleanup confirmed."
else
  echo "Probe row still present after $REQUEST_COUNT requests. With a 1% chance"
  echo "per request this has roughly a (0.99)^$REQUEST_COUNT chance of happening"
  echo "by bad luck alone (~5% for 300 requests) — just rerun this script once."
  echo "If it's still there after 2-3 runs, paste me this output; the cleanup"
  echo "branch likely isn't being reached (check RATE_LIMIT_MODE isn't 'off')."
fi
