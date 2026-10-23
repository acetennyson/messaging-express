#!/usr/bin/env bash
# Implementation Plan Stage 3.4, compressed (no "watch for an hour" needed).
#
# Proves: with RATE_LIMIT_MODE=enforce, a request over the limit gets a real
# 429 with Retry-After, CORS headers are still present on that 429, and
# (Stage 3.5) X-RateLimit-* headers show the budget on every response.
#
# SETUP (one-time, in the terminal that runs the dev server — restart it
# after exporting these, same reason as the dry-run script):
#   export JWT_SECRET='...'
#   export DATABASE_URL='...'
#   export RATE_LIMIT_MODE=enforce
#   export RATE_LIMITS_JSON='{"messages:GET":{"limit":3,"windowMs":60000}}'
#   npm run dev
#
# Then: JWT_SECRET=... bash scripts/test-rate-limit-enforce.sh
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-4000-8000-0000000000a2}"
ORGANIZATION_ID="${ORGANIZATION_ID:-00000000-0000-4000-8000-0000000000a1}"
CONVERSATION_ID="${CONVERSATION_ID:-00000000-0000-4000-8000-0000000000c1}"
ORIGIN_HDR="http://smoke.test"

: "${JWT_SECRET:?export JWT_SECRET (same value the dev server is using)}"

TOKEN="$(PROJECT_ID="$PROJECT_ID" ORGANIZATION_ID="$ORGANIZATION_ID" node -e \
  "process.stdout.write(require('jsonwebtoken').sign({projectId:process.env.PROJECT_ID,organizationId:process.env.ORGANIZATION_ID,type:'api'},process.env.JWT_SECRET,{expiresIn:'1h'}))")" \
  || { echo "could not mint a token (run npm ci first)"; exit 2; }

echo "This proves enforce mode: 5 requests against a route limited to 3/min."
echo "Expected: req 1-3 -> 200, req 4-5 -> 429 with Retry-After. CORS and"
echo "X-RateLimit-* headers should be present on every line."
echo

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
for i in 1 2 3 4 5; do
  code="$(curl -s -D "$TMP/h" -o "$TMP/b" -w '%{http_code}' \
    "$BASE_URL/api/v1/messages?conversationId=$CONVERSATION_ID&limit=1" \
    -H "Authorization: Bearer $TOKEN" -H "Origin: $ORIGIN_HDR")"
  limit_hdr="$(tr -d '\r' < "$TMP/h" | awk -F': ' 'tolower($1)=="x-ratelimit-limit"{print $2}')"
  remaining_hdr="$(tr -d '\r' < "$TMP/h" | awk -F': ' 'tolower($1)=="x-ratelimit-remaining"{print $2}')"
  retry_hdr="$(tr -d '\r' < "$TMP/h" | awk -F': ' 'tolower($1)=="retry-after"{print $2}')"
  acao_hdr="$(tr -d '\r' < "$TMP/h" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"

  printf '  req %d -> %-3s  limit=%-4s remaining=%-4s retry-after=%-4s acao=%s\n' \
    "$i" "$code" "${limit_hdr:-?}" "${remaining_hdr:-?}" "${retry_hdr:-'-'}" "${acao_hdr:-MISSING}"

  if [ "$i" -le 3 ] && [ "$code" != 200 ]; then
    echo "    UNEXPECTED: request $i should be under the limit (got $code)"; fail=1
  fi
  if [ "$i" -gt 3 ]; then
    if [ "$code" != 429 ]; then
      echo "    UNEXPECTED: request $i should be blocked (got $code, want 429)"; fail=1
    fi
    if [ -z "$retry_hdr" ]; then
      echo "    UNEXPECTED: 429 response has no Retry-After header"; fail=1
    fi
  fi
  if [ -z "$acao_hdr" ] || [ "$acao_hdr" = MISSING ]; then
    echo "    UNEXPECTED: no access-control-allow-origin header on this response"; fail=1
  fi
done

echo
if [ $fail = 0 ]; then
  echo "PASS: requests 1-3 went through, 4-5 were blocked with 429 + Retry-After,"
  echo "CORS headers were present throughout. Stage 3.4 confirmed."
  if [ -n "${limit_hdr:-}" ]; then
    echo "X-RateLimit-* headers were present too, so Stage 3.5's header part is"
    echo "confirmed as well."
  else
    echo "NOTE: X-RateLimit-* headers were not present — Stage 3.5's header change"
    echo "may not be deployed on this server yet."
  fi
else
  echo "FAIL: see the UNEXPECTED lines above. Paste me this output plus the dev"
  echo "server's terminal output from this run."
fi
