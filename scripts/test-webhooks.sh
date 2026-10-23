#!/usr/bin/env bash
# Implementation Plan Stage 4.3: the three staging tests for WEBHOOK_DISPATCH=on.
#
#   A. org WITHOUT webhook_url      -> identical response, no mx_webhook_logs row
#   B. org WITH a working receiver  -> events arrive on all three routes, signature
#                                      verifies, log rows show status 200 + completed
#   C. org with a failing receiver  -> REST call still 201 and fast; the failure is logged
#                                      (HTTP 500, dead port, and a 10 s hang)
#
# SETUP: the SERVER process must have WEBHOOK_DISPATCH=on in ITS OWN environment, set
# before it started (exporting it in the terminal that runs this script does nothing).
# The value must be exactly "on": "true" or "1" are treated as off (the server logs
# "invalid_flag_value"). DATABASE_URL here must point at the same database as the server.
#   export JWT_SECRET=... DATABASE_URL=... WEBHOOK_DISPATCH=on   # in the server's terminal
#   psql "$DATABASE_URL" -f scripts/smoke-seed.sql      # fixtures (idempotent)
#   npm run dev        # or your staging process
# Then, in a second terminal:
#   JWT_SECRET=... DATABASE_URL=... bash scripts/test-webhooks.sh
#
# If the server is NOT on this machine (Docker, remote staging), it cannot reach this
# machine's 127.0.0.1, so give it an address it can reach:
#   LISTENER_HOST=<this machine's address as seen by the server> bash scripts/test-webhooks.sh
#
# DEV/STAGING ONLY: it rewrites the seeded organization's webhook_url/webhook_secret and
# creates users, conversations and messages. It restores webhook_url/secret on exit.
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-4000-8000-0000000000a2}"
ORGANIZATION_ID="${ORGANIZATION_ID:-00000000-0000-4000-8000-0000000000a1}"
SENDER_ID="${SENDER_ID:-00000000-0000-4000-8000-0000000000b1}"
LISTENER_PORT="${LISTENER_PORT:-9400}"
LISTENER_HOST="${LISTENER_HOST:-127.0.0.1}"   # the host the SERVER will call
SECRET="test-secret-$$"
OUT="$(mktemp)"
FAST_MS="${FAST_MS:-2000}"          # what counts as "promptly" for the REST response

: "${JWT_SECRET:?export JWT_SECRET (same value the server uses)}"
: "${DATABASE_URL:?export DATABASE_URL (the database the server uses)}"
for c in jq curl psql node; do command -v $c >/dev/null || { echo "$c is required"; exit 2; }; done
case "$BASE_URL" in
  http://localhost*|http://127.0.0.1*) ;;
  *) [ "${SMOKE_ALLOW_REMOTE:-0}" = 1 ] || { echo "Refusing to run against $BASE_URL (writes data). Set SMOKE_ALLOW_REMOTE=1 to override."; exit 2; } ;;
esac

sql() { psql "$DATABASE_URL" -tAqc "$1"; }
ORIG="$(sql "SELECT coalesce(webhook_url,'<null>') || '|' || coalesce(webhook_secret,'<null>') FROM mx_organizations WHERE id='$ORGANIZATION_ID'")"
[ -n "$ORIG" ] || { echo "seed organization not found (run scripts/smoke-seed.sql)"; exit 2; }
restore() {
  local u="${ORIG%%|*}" s="${ORIG#*|}"
  [ "$u" = "<null>" ] && u="NULL" || u="'$u'"
  [ "$s" = "<null>" ] && s="NULL" || s="'$s'"
  sql "UPDATE mx_organizations SET webhook_url=$u, webhook_secret=$s WHERE id='$ORGANIZATION_ID'" >/dev/null
  [ -n "${LPID:-}" ] && kill "$LPID" 2>/dev/null
  rm -f "$OUT"
}
trap restore EXIT

setorg() { # $1 = url or NULL
  if [ "$1" = NULL ]; then sql "UPDATE mx_organizations SET webhook_url=NULL, webhook_secret='$SECRET' WHERE id='$ORGANIZATION_ID'" >/dev/null
  else sql "UPDATE mx_organizations SET webhook_url='$1', webhook_secret='$SECRET' WHERE id='$ORGANIZATION_ID'" >/dev/null; fi
}

TOKEN="$(PROJECT_ID="$PROJECT_ID" ORGANIZATION_ID="$ORGANIZATION_ID" node -e \
  "process.stdout.write(require('jsonwebtoken').sign({projectId:process.env.PROJECT_ID,organizationId:process.env.ORGANIZATION_ID,type:'api'},process.env.JWT_SECRET,{expiresIn:'1h'}))")" \
  || { echo "could not mint a token (run npm ci first)"; exit 2; }

BIND=127.0.0.1; [ "$LISTENER_HOST" != 127.0.0.1 ] && BIND=0.0.0.0
# On Git Bash/MSYS (Windows), node.exe is a native binary. MSYS auto-translates
# a bare path ARGUMENT to a native exe, and a small allowlist of well-known env
# vars (PATH, HOME, TMP, TEMP, ...) -- but NOT an arbitrary env var name like
# OUT. So node.exe would get the literal string "/tmp/tmp.xxxxx" and resolve it
# relative to the current drive root, which is a different file than the one
# mktemp actually created and this script reads with jq. cygpath converts it to
# the real native path; it doesn't exist on Linux/macOS, where $OUT already
# works as-is, so this is a no-op there.
NODE_OUT="$OUT"
if command -v cygpath >/dev/null 2>&1; then NODE_OUT="$(cygpath -w "$OUT")"; fi
HOST=$BIND PORT=$LISTENER_PORT WEBHOOK_SECRET=$SECRET OUT="$NODE_OUT" SLOW_MS=10000 node "$(dirname "$0")/webhook-test-listener.mjs" >/dev/null 2>&1 &
LPID=$!
sleep 1

fail=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fail=1; }

# POST helper: sets CODE, MS, BODY_FILE
BODY_FILE="$(mktemp)"
post() { # path json
  local r; r="$(curl -s -o "$BODY_FILE" -w '%{http_code} %{time_total}' -X POST "$BASE_URL/api/v1/$1" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2")"
  CODE="${r%% *}"; MS="$(awk -v t="${r##* }" 'BEGIN{printf "%d", t*1000}')"
}
RUN="$(date +%s)$$"
new_user()   { post users "{\"externalId\":\"wh-$RUN-$1\",\"name\":\"WH $1\"}"; USER_ID="$(jq -r '.data.id' "$BODY_FILE")"; }
new_conv()   { post conversations "{\"type\":\"direct\",\"participantIds\":[\"$USER_ID\",\"$SENDER_ID\"]}"; CONV_ID="$(jq -r '.data.id' "$BODY_FILE")"; }
new_msg()    { post messages "{\"conversationId\":\"$CONV_ID\",\"senderId\":\"$USER_ID\",\"content\":\"wh $1\"}"; }
rows_since() { sql "SELECT count(*) FROM mx_webhook_logs WHERE project_id='$PROJECT_ID' AND created_at >= '$START'"; }
# warm-up so first-compile time in dev doesn't count as "slow"
setorg NULL; new_user warm; new_conv; new_msg warm >/dev/null

echo "== A. organization without webhook_url"
setorg NULL
START="$(sql 'SELECT now()')"
new_user A1; [ "$CODE" = 201 ] && ok "POST /users -> 201" || bad "POST /users -> $CODE"
KEYS="$(jq -r '.data | keys | join(",")' "$BODY_FILE")"
echo "$KEYS" | grep -q inserted && bad "response leaks internal 'inserted' field" || ok "response has no internal fields"
SEEN="$(sql "SELECT count(*) FROM mx_users WHERE project_id='$PROJECT_ID' AND external_id='wh-$RUN-A1'")"
if [ "$SEEN" != 1 ]; then
  bad "the user the server just created is not in THIS script's database"
  echo "      DATABASE_URL here and the server's DATABASE_URL point at different databases."
  echo "      Every later check would be meaningless. Fix DATABASE_URL and re-run."
  exit 1
fi
ok "server and script share one database"
new_conv; new_msg A; [ "$CODE" = 201 ] && ok "POST /conversations + /messages -> 201" || bad "message POST -> $CODE"
sleep 2
N="$(rows_since)"; [ "$N" = 0 ] && ok "no mx_webhook_logs rows" || bad "$N rows written for an org with no webhook_url"

echo "== B. working receiver (signature + log row)"
setorg "http://$LISTENER_HOST:$LISTENER_PORT/ok"
START="$(sql 'SELECT now()')"; : > "$OUT"
new_user B1;  [ "$CODE" = 201 ] || bad "POST /users -> $CODE"
new_conv;     [ "$CODE" = 201 ] || bad "POST /conversations -> $CODE"
new_msg B;    [ "$CODE" = 201 ] || bad "POST /messages -> $CODE"
sleep 3
MISSING=0
for ev in user.created conversation.created message.created; do
  LINE="$(jq -c "select(.event==\"$ev\")" "$OUT" | head -1)"
  if [ -z "$LINE" ]; then bad "$ev never arrived"; MISSING=1; continue; fi
  [ "$(echo "$LINE" | jq -r .sigValid)" = true ] && ok "$ev arrived, signature valid" || bad "$ev arrived but signature INVALID"
  [ "$(echo "$LINE" | jq -r .body.projectId)" = "$PROJECT_ID" ] || bad "$ev has wrong projectId"
done
if [ "$MISSING" = 1 ]; then
  NROWS="$(rows_since)"
  echo
  if [ "$NROWS" = 0 ]; then
    echo "  DIAGNOSIS: the server never even attempted a webhook (0 rows in mx_webhook_logs)."
    echo "    1. WEBHOOK_DISPATCH is not exactly 'on' in the SERVER process. It must be in the server's"
    echo "       own environment before it started (.env.local / platform settings), then restart."
    echo "       'true' or '1' do not work: search the server log for \"invalid_flag_value\"."
    echo "    2. Or the server cannot find this org's webhook_url (different database: see the check in A)."
  else
    echo "  DIAGNOSIS: the server tried ($NROWS log rows) but the receiver at"
    echo "    http://$LISTENER_HOST:$LISTENER_PORT never got the request. If the server is not on this machine,"
    echo "    127.0.0.1 is the wrong address: re-run with LISTENER_HOST=<an address the server can reach>,"
    echo "    and check that no firewall blocks port $LISTENER_PORT. Last log rows:"
    sql "SELECT event_type, coalesce(response_status::text,'no response'), attempts FROM mx_webhook_logs WHERE project_id='$PROJECT_ID' AND created_at >= '$START' ORDER BY created_at LIMIT 5" | sed 's/^/      /'
  fi
  echo
  echo "Stopping here: section C is meaningless until section B passes."
  exit 1
fi
OKROWS="$(sql "SELECT count(*) FROM mx_webhook_logs WHERE project_id='$PROJECT_ID' AND created_at >= '$START' AND response_status=200 AND completed_at IS NOT NULL")"
[ "$OKROWS" = 3 ] && ok "3 log rows with status 200 and completed_at set" || bad "expected 3 completed 200 rows, found $OKROWS"

echo "== C. failing receivers (REST must stay 201 and fast; failure must be logged)"
START="$(sql 'SELECT now()')"
setorg "http://$LISTENER_HOST:$LISTENER_PORT/fail"
new_user C500; [ "$CODE" = 201 ] && [ "$MS" -lt "$FAST_MS" ] && ok "receiver returns 500: REST 201 in ${MS}ms" || bad "receiver 500: REST $CODE in ${MS}ms"
setorg "http://127.0.0.1:9/dead"
new_user Cdead; [ "$CODE" = 201 ] && [ "$MS" -lt "$FAST_MS" ] && ok "dead port: REST 201 in ${MS}ms" || bad "dead port: REST $CODE in ${MS}ms"
setorg "http://$LISTENER_HOST:$LISTENER_PORT/slow"
new_user Cslow; [ "$CODE" = 201 ] && [ "$MS" -lt "$FAST_MS" ] && ok "receiver hangs 10s: REST 201 in ${MS}ms" || bad "slow receiver: REST $CODE in ${MS}ms (webhook blocking the response?)"
echo "      waiting for the webhook timeout (WEBHOOK_TIMEOUT_MS, default 5s) ..."
sleep 8
R500="$(sql "SELECT response_status||'/'||attempts||'/'||(completed_at IS NOT NULL) FROM mx_webhook_logs WHERE project_id='$PROJECT_ID' AND created_at >= '$START' AND url LIKE '%/fail'")"
[ "$R500" = "500/1/true" ] && ok "500 logged: status 500, attempts 1, completed" || bad "500 row: '$R500' (want 500/1/true)"
RDEAD="$(sql "SELECT coalesce(response_status::text,'null')||'/'||attempts||'/'||(completed_at IS NOT NULL)||'/'||(next_retry_at IS NOT NULL) FROM mx_webhook_logs WHERE project_id='$PROJECT_ID' AND created_at >= '$START' AND url LIKE '%:9/dead'")"
[ "$RDEAD" = "null/1/false/true" ] && ok "dead port logged: no status, attempts 1, open, next_retry_at set" || bad "dead-port row: '$RDEAD' (want null/1/false/true)"
RSLOW="$(sql "SELECT coalesce(response_status::text,'null')||'/'||attempts||'/'||(next_retry_at IS NOT NULL) FROM mx_webhook_logs WHERE project_id='$PROJECT_ID' AND created_at >= '$START' AND url LIKE '%/slow'")"
[ "$RSLOW" = "null/1/true" ] && ok "timeout logged: aborted, attempts 1, next_retry_at set" || bad "slow row: '$RSLOW' (want null/1/true)"

echo
[ $fail = 0 ] && echo "STAGE 4.3 CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
echo "Next (production): flip WEBHOOK_DISPATCH=on, then watch the logs for an hour for:"
echo "  \"Webhook failed\" (non-2xx), \"Webhook request failed\" (network/timeout),"
echo "  \"Failed to send webhook\" and \"emit_event_webhook_failed\" (unexpected errors)."