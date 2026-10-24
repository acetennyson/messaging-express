#!/usr/bin/env bash
# Smoke test + response-shape baseline (Implementation Plan, Stage P.1).
#
# Purpose: prove "nothing else changed". It calls the existing API, reduces each
# response to its SHAPE (status, content-type, CORS header, JSON keys and value
# types; never the values) and diffs that against committed baselines in
# scripts/baselines/. Volatile data (ids, timestamps, urls) is ignored.
#
#   scripts/smoke.sh --record     write/overwrite baselines (do this ONCE on a known-good build)
#   scripts/smoke.sh              compare against baselines; exit 1 on any difference
#
# Setup (dev/staging only; this script WRITES messages, users, conversations and
# uploads a file, so it refuses non-local hosts unless SMOKE_ALLOW_REMOTE=1):
#
#   psql "$DATABASE_URL" -f scripts/smoke-seed.sql          # idempotent fixtures
#   JWT_SECRET=... DATABASE_URL=... npm run dev             # app running
#   JWT_SECRET=... bash scripts/smoke.sh --record           # first time only
#
# Env (all optional if JWT_SECRET is set and the seed file was used):
#   BASE_URL         default http://localhost:3000
#   TOKEN            JWT; if unset it is minted from JWT_SECRET (needs `npm ci` done)
#   JWT_SECRET       used to mint TOKEN
#   PROJECT_ID       default seeded project
#   ORGANIZATION_ID  default seeded org
#   CONVERSATION_ID  default seeded conversation
#   SENDER_ID        default seeded user (participant of that conversation)
#   OTHER_USER_ID    default second seeded user
#   SMOKE_ALLOW_REMOTE=1  allow a non-localhost BASE_URL
#   SMOKE_EXPECT_UPLOAD=1 (default) also run the upload steps; set 0 to skip them
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-4000-8000-0000000000a2}"
ORGANIZATION_ID="${ORGANIZATION_ID:-00000000-0000-4000-8000-0000000000a1}"
CONVERSATION_ID="${CONVERSATION_ID:-00000000-0000-4000-8000-0000000000c1}"
SENDER_ID="${SENDER_ID:-00000000-0000-4000-8000-0000000000b1}"
OTHER_USER_ID="${OTHER_USER_ID:-00000000-0000-4000-8000-0000000000b2}"
EXPECT_UPLOAD="${SMOKE_EXPECT_UPLOAD:-1}"
ORIGIN_HDR="http://smoke.test"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BASELINES="$HERE/baselines"

MODE=compare
case "${1:-}" in
  --record) MODE=record ;;
  "" ) ;;
  -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) echo "unknown argument: $1 (use --record or no argument)"; exit 2 ;;
esac

command -v jq   >/dev/null || { echo "jq is required"; exit 2; }
command -v curl >/dev/null || { echo "curl is required"; exit 2; }

case "$BASE_URL" in
  http://localhost*|http://127.0.0.1*|https://localhost*) ;;
  *) [ "${SMOKE_ALLOW_REMOTE:-0}" = 1 ] || { echo "Refusing to run against $BASE_URL (this script writes data). Set SMOKE_ALLOW_REMOTE=1 to override."; exit 2; } ;;
esac

if [ -z "${TOKEN:-}" ]; then
  : "${JWT_SECRET:?set TOKEN, or JWT_SECRET so a token can be minted}"
  TOKEN="$(cd "$ROOT" && PROJECT_ID="$PROJECT_ID" ORGANIZATION_ID="$ORGANIZATION_ID" node -e \
    "process.stdout.write(require('jsonwebtoken').sign({projectId:process.env.PROJECT_ID,organizationId:process.env.ORGANIZATION_ID,type:'api'},process.env.JWT_SECRET,{expiresIn:'1h'}))")" \
    || { echo "could not mint a token (run npm ci first)"; exit 2; }
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$BASELINES"
fail=0
checked=0

# jq program: reduce any JSON value to its shape (keys sorted, leaves -> type name).
# An array becomes ONE merged element shape ([] when empty), so the result does not depend on
# HOW MANY rows came back or WHICH rows: a nullable column that is null in some rows and a
# string in others is reported as "string" (null is absorbed by any other type), keys seen in
# any element are unioned, and differing scalar types are reported as "a|b". Adding, removing
# or renaming a key, or changing a column's type, still changes the shape.
SHAPE_JQ='def merge:
  (map(select(. != "null"))) as $nn
  | if ($nn|length) == 0 then "null"
    elif all($nn[]; type=="object") then
      ($nn | map(keys) | add | unique) as $ks
      | reduce $ks[] as $k ({}; .[$k] = ([ $nn[] | select(has($k)) | .[$k] ] | merge))
    elif all($nn[]; type=="array") then
      ($nn | map(.[]) ) as $els | if ($els|length) == 0 then [] else [ $els | merge ] end
    else ($nn | map(if type=="string" then . else "<"+type+">" end) | unique | join("|"))
    end;
def shape:
  if type=="object" then (to_entries | sort_by(.key) | map({key, value: (.value|shape)}) | from_entries)
  elif type=="array" then ([ .[] | shape ] | if length==0 then [] else [ merge ] end)
  else type end;
shape'

# record_or_compare <name> <method> <path> [curl args...]
# Leaves the parsed JSON body in $TMP/last.json (empty object if not JSON).
step() {
  local name="$1" method="$2" path="$3"; shift 3
  local code
  code="$(curl -sS -D "$TMP/h" -o "$TMP/b" -w '%{http_code}' -X "$method" "$BASE_URL$path" \
          -H "Origin: $ORIGIN_HDR" "$@" 2>"$TMP/$name.curlerr")" || code=000
  if [ "$code" = 000 ] && [ -s "$TMP/$name.curlerr" ]; then
    printf '  FAIL  %-28s curl error:\n' "$name"
    sed 's/^/        /' "$TMP/$name.curlerr"
  fi
  local ct acao body_shape
  ct="$(tr -d '\r' < "$TMP/h" | awk 'tolower($1)=="content-type:"{ $1=""; sub(/^ /,""); print tolower($0); exit }')"
  acao="$(tr -d '\r' < "$TMP/h" | awk 'tolower($1)=="access-control-allow-origin:"{ print $2; exit }')"
  if jq -e . "$TMP/b" >/dev/null 2>&1; then
    cp "$TMP/b" "$TMP/last.json"
    body_shape="$(jq -S "$SHAPE_JQ" "$TMP/b")"
  else
    echo '{}' > "$TMP/last.json"
    if [ -s "$TMP/b" ]; then body_shape='"non-json"'; else body_shape='"empty"'; fi
  fi
  jq -S -n --argjson status "${code:-0}" --arg ct "${ct:-}" --arg acao "${acao:-}" --argjson body "$body_shape" \
     '{status:$status, contentType:$ct, accessControlAllowOrigin:$acao, body:$body}' > "$TMP/$name.json"

  checked=$((checked+1))
  if [ "$MODE" = record ]; then
    cp "$TMP/$name.json" "$BASELINES/$name.json"
    printf '  REC   %-28s %s %s -> %s\n' "$name" "$method" "$path" "$code"
  elif [ ! -f "$BASELINES/$name.json" ]; then
    printf '  FAIL  %-28s no baseline (run with --record on a known-good build)\n' "$name"; fail=1
  elif diff -u <(tr -d '\r' < "$BASELINES/$name.json") <(tr -d '\r' < "$TMP/$name.json") > "$TMP/$name.diff"; then
    printf '  PASS  %-28s %s %s -> %s\n' "$name" "$method" "$path" "$code"
  else
    printf '  FAIL  %-28s %s %s -> %s\n' "$name" "$method" "$path" "$code"
    sed 's/^/        /' "$TMP/$name.diff"; fail=1
  fi
}

AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H 'Content-Type: application/json')

echo "Smoke ($MODE) against $BASE_URL"

step 01-health                GET  /api/health
step 02-no-token              GET  "/api/v1/messages?conversationId=$CONVERSATION_ID"
step 03-bad-token             GET  "/api/v1/messages?conversationId=$CONVERSATION_ID" -H "Authorization: Bearer not.a.token"
step 04-preflight-messages    OPTIONS /api/v1/messages -H 'Access-Control-Request-Method: POST'

# Writes first, so the reads below always have data and the same shape.
step 10-users-post            POST /api/v1/users "${AUTH[@]}" "${JSON[@]}" \
  -d '{"externalId":"smoke-extra-user","name":"Smoke Extra"}'
step 11-conversations-post    POST /api/v1/conversations "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"type\":\"group\",\"title\":\"smoke\",\"participantIds\":[\"$SENDER_ID\",\"$OTHER_USER_ID\"]}"
step 12-messages-post-text    POST /api/v1/messages "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"conversationId\":\"$CONVERSATION_ID\",\"senderId\":\"$SENDER_ID\",\"content\":\"smoke\"}"
step 13-messages-post-invalid POST /api/v1/messages "${AUTH[@]}" "${JSON[@]}" -d '{"conversationId":"not-a-uuid"}'
# Track H3: an unknown conversation is a 404 (it used to be a 400).
step 14-messages-post-no-conv POST /api/v1/messages "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"conversationId\":\"00000000-0000-4000-8000-00000000ffff\",\"senderId\":\"$SENDER_ID\",\"content\":\"x\"}"

if [ "$EXPECT_UPLOAD" = 1 ]; then
  # 1x1 PNG
  printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/t.png"
  # On Git Bash/MSYS (Windows), curl.exe is a native binary, but a POSIX path
  # embedded inside a compound -F value (file=@/tmp/xxx/t.png;type=...) is NOT
  # auto-translated the way a bare path argument would be, so curl.exe can't
  # open it ("Failed to open/read local data from file/application"). cygpath
  # converts it to a real Windows path; it doesn't exist on Linux/macOS, where
  # the POSIX path already works, so this is a no-op there.
  PNG_PATH="$TMP/t.png"
  if command -v cygpath >/dev/null 2>&1; then PNG_PATH="$(cygpath -w "$PNG_PATH")"; fi
  step 20-uploads-post        POST /api/v1/uploads "${AUTH[@]}" -F "file=@$PNG_PATH;type=image/png"
  UPLOAD_URL="$(jq -r '.data[0].url // empty' "$TMP/last.json")"
  # The local provider returns a site-relative URL, but the message schema wants an absolute one.
  case "$UPLOAD_URL" in /*) UPLOAD_URL="http://smoke.test$UPLOAD_URL" ;; esac
  if [ -n "$UPLOAD_URL" ]; then
    step 21-messages-post-attach POST /api/v1/messages "${AUTH[@]}" "${JSON[@]}" \
      -d "{\"conversationId\":\"$CONVERSATION_ID\",\"senderId\":\"$SENDER_ID\",\"type\":\"image\",\"attachments\":[{\"type\":\"image\",\"url\":\"$UPLOAD_URL\",\"mimeType\":\"image/png\",\"filename\":\"t.png\"}]}"
  else
    # Upload didn't return a URL; the 20-step diff above already reports why.
    echo "  SKIP  21-messages-post-attach   (no url from upload)"; fail=1
  fi
  step 22-uploads-no-files    POST /api/v1/uploads "${AUTH[@]}" -F "category=x"
  step 23-presign             POST /api/v1/uploads/presign "${AUTH[@]}" "${JSON[@]}" \
    -d '{"filename":"t.png","mimeType":"image/png","sizeBytes":70}'
fi

step 30-messages-get          GET  "/api/v1/messages?conversationId=$CONVERSATION_ID&limit=5" "${AUTH[@]}"
step 31-conversations-get     GET  "/api/v1/conversations?limit=5" "${AUTH[@]}"
step 32-users-get             GET  "/api/v1/users?limit=5" "${AUTH[@]}"

echo
if [ "$MODE" = record ]; then
  echo "Recorded $checked baselines in scripts/baselines/. Review and commit them."
  exit 0
fi
if [ $fail = 0 ]; then echo "SMOKE PASSED ($checked checks)"; else echo "SMOKE FAILED"; exit 1; fi