#!/usr/bin/env bash
# Provider check: upload -> fetch the URL -> attach to a message, via the proxy
# route and (if the selected provider supports it) the presigned direct route.
#
#   BASE_URL=http://localhost:3000 TOKEN=<jwt> CONVERSATION_ID=<uuid> SENDER_ID=<uuid> \
#     bash scripts/verify-uploads.sh
#
# Start the server with STORAGE_PROVIDER=<name> + that provider's env first.
set -u
: "${TOKEN:?set TOKEN (jwt from scripts/generate-token.js)}"
: "${CONVERSATION_ID:?set CONVERSATION_ID}"
: "${SENDER_ID:?set SENDER_ID (a participant of that conversation)}"
BASE_URL="${BASE_URL:-http://localhost:3000}"
API="$BASE_URL/api/v1"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fail=1; }

# 1x1 PNG
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/t.png"
SIZE=$(wc -c < "$TMP/t.png")

attach() { # $1=url  -> http code of POST /messages
  curl -s -o "$TMP/msg.json" -w '%{http_code}' -X POST "$API/messages" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"conversationId\":\"$CONVERSATION_ID\",\"senderId\":\"$SENDER_ID\",\"type\":\"image\",\"attachments\":[{\"type\":\"image\",\"url\":\"$1\",\"mimeType\":\"image/png\",\"filename\":\"t.png\"}]}"
}

echo "[1] proxy upload  POST /uploads"
R=$(curl -s -X POST "$API/uploads" -H "Authorization: Bearer $TOKEN" -F "file=@$TMP/t.png;type=image/png")
URL=$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"][0]; print(d.get("url",""))' 2>/dev/null)
if [ -n "$URL" ]; then ok "uploaded -> $URL"; else bad "upload failed: $R"; fi
if [ -n "$URL" ]; then
  C=$(curl -s -o /dev/null -w '%{http_code}' "$URL"); [ "$C" = 200 ] && ok "URL is publicly readable (200)" || bad "GET url -> $C (bucket public? CORS/ACL?)"
  C=$(attach "$URL"); [ "$C" = 201 ] || [ "$C" = 200 ] && ok "attached to message ($C)" || bad "POST /messages -> $C: $(cat "$TMP/msg.json" | cut -c1-200)"
fi

echo "[2] direct upload  POST /uploads/presign -> PUT"
P=$(curl -s -w '\n%{http_code}' -X POST "$API/uploads/presign" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"filename\":\"t.png\",\"mimeType\":\"image/png\",\"sizeBytes\":$SIZE}")
CODE=$(echo "$P" | tail -1); BODY=$(echo "$P" | sed '$d')
if [ "$CODE" = 501 ]; then
  echo "  SKIP  provider does not support presign (expected for local/php)"
elif [ "$CODE" != 200 ]; then
  bad "presign -> $CODE: $BODY"
else
  UP=$(echo "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["uploadUrl"])')
  PUB=$(echo "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["publicUrl"])')
  mapfile -t H < <(echo "$BODY" | python3 -c 'import json,sys; [print("-H\n%s: %s"%(k,v)) for k,v in (json.load(sys.stdin)["data"].get("headers") or {}).items()]')
  C=$(curl -s -o "$TMP/put.out" -w '%{http_code}' -X PUT "${H[@]}" --data-binary "@$TMP/t.png" "$UP")
  [[ "$C" == 2* ]] && ok "PUT to storage ($C)" || bad "PUT -> $C: $(head -c 200 "$TMP/put.out")"
  C=$(curl -s -o /dev/null -w '%{http_code}' "$PUB"); [ "$C" = 200 ] && ok "publicUrl readable (200)" || bad "GET publicUrl -> $C"
  C=$(attach "$PUB"); [ "$C" = 201 ] || [ "$C" = 200 ] && ok "attached to message ($C)" || bad "POST /messages -> $C"
fi

echo
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
