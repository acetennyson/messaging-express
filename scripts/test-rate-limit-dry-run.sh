#!/usr/bin/env bash
# Implementation Plan Stage 3.3, compressed (no 3-day wait needed).
#
# Proves: with RATE_LIMIT_MODE=dry-run, a request that WOULD be blocked
# still succeeds — dry-run only observes, never blocks.
#
# SETUP (one-time, in the terminal that runs the dev server — flags are
# read at request time but the Node process only sees env vars that were
# set BEFORE it started, so restart the server after exporting these):
#   export JWT_SECRET='...'            # same value smoke.sh uses
#   export DATABASE_URL='...'
#   export RATE_LIMIT_MODE=dry-run
#   export RATE_LIMITS_JSON='{"messages:GET":{"limit":3,"windowMs":60000}}'
#   npm run dev
#
# Then, in a second terminal (this script), just: JWT_SECRET=... bash scripts/test-rate-limit-dry-run.sh
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-4000-8000-0000000000a2}"
ORGANIZATION_ID="${ORGANIZATION_ID:-00000000-0000-4000-8000-0000000000a1}"
CONVERSATION_ID="${CONVERSATION_ID:-00000000-0000-4000-8000-0000000000c1}"

: "${JWT_SECRET:?export JWT_SECRET (same value the dev server is using)}"
command -v jq >/dev/null || { echo "jq is required"; exit 2; }

TOKEN="$(PROJECT_ID="$PROJECT_ID" ORGANIZATION_ID="$ORGANIZATION_ID" node -e \
  "process.stdout.write(require('jsonwebtoken').sign({projectId:process.env.PROJECT_ID,organizationId:process.env.ORGANIZATION_ID,type:'api'},process.env.JWT_SECRET,{expiresIn:'1h'}))")" \
  || { echo "could not mint a token (run npm ci first)"; exit 2; }

echo "This proves dry-run mode: 5 requests against a route limited to 3/min"
echo "via RATE_LIMITS_JSON should ALL return 200 — dry-run never blocks."
echo

fail=0
for i in 1 2 3 4 5; do
  code="$(curl -s -o /tmp/mx-dryrun-body.json -w '%{http_code}' \
    "$BASE_URL/api/v1/messages?conversationId=$CONVERSATION_ID&limit=1" \
    -H "Authorization: Bearer $TOKEN")"
  if [ "$code" = 200 ]; then
    printf '  req %d -> %s   ok\n' "$i" "$code"
  else
    printf '  req %d -> %s   UNEXPECTED (dry-run must never block)\n' "$i" "$code"
    cat /tmp/mx-dryrun-body.json
    fail=1
  fi
done

echo
if [ $fail = 0 ]; then
  echo "PASS: all 5 requests returned 200."
  echo
  echo "Now look at the dev server's own terminal output. You should see 2 lines"
  echo "like this (one for request 4, one for request 5 — the ones past the"
  echo "limit of 3):"
  echo '  {"level":"warn","message":"rate_limit_would_block","meta":{"group":"messages:GET",...}}'
  echo
  echo "If those 2 warn lines are there, Stage 3.3 is confirmed. Paste me both"
  echo "this script's output AND those server log lines."
else
  echo "FAIL: a request was blocked while RATE_LIMIT_MODE=dry-run. Something is"
  echo "wrong — dry-run should never return anything but 200 here. Paste me the"
  echo "dev server's terminal output from around this run."
fi
