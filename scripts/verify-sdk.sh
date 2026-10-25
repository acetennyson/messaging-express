#!/usr/bin/env bash
# One command to verify the client SDK against a real dev server.
#   bash scripts/verify-sdk.sh              start the server (if it is not running), run all checks, stop it again
#   bash scripts/verify-sdk.sh --restart    same, plus the reconnect test: the script restarts the server itself
# DEV / STAGING ONLY: it adds test users, conversations and messages to the database in .env.local.
# Works in Git Bash on Windows and in Linux/macOS shells.
set -u
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:3000}"
export REALTIME_PROVIDER="${REALTIME_PROVIDER:-socketio}"
export STORAGE_PROVIDER="${STORAGE_PROVIDER:-local}"
export APP_URL="${APP_URL:-$BASE_URL}"
export BASE_URL

RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

LOG=".verify-server.log"
OUT=".verify-output.log"
SERVER_PID=""
STARTED=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WINDOWS=1 ;; *) WINDOWS=0 ;; esac

healthy() { curl -s -m 3 -o /dev/null -f "$BASE_URL/api/health"; }

start_server() {
  echo ">> starting the server (log: $LOG)"
  if [ "$WINDOWS" = 0 ] && command -v setsid >/dev/null 2>&1; then
    setsid npm run dev:socket >"$LOG" 2>&1 &
  else
    npm run dev:socket >"$LOG" 2>&1 &
  fi
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null   # keeps bash from printing "Killed" when we stop it later
  for _ in $(seq 1 60); do
    healthy && { echo ">> server is up"; return 0; }
    sleep 2
  done
  echo ">> the server did not come up within 2 minutes. Last lines of $LOG:"
  tail -n 20 "$LOG"
  return 1
}

stop_server() {
  [ -z "$SERVER_PID" ] && return 0
  if [ "$WINDOWS" = 1 ]; then
    taskkill //PID "$SERVER_PID" //T //F >/dev/null 2>&1   # kills npm and the node processes under it
  else
    kill -9 -- "-$SERVER_PID" 2>/dev/null || kill -9 "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
  for _ in $(seq 1 20); do healthy || break; sleep 0.5; done
}

cleanup() { [ "$STARTED" = 1 ] && stop_server; rm -f "$OUT"; }
trap cleanup EXIT

if healthy; then
  echo ">> a server is already running at $BASE_URL: using it (it will be left running)"
  if [ "$RESTART" = 1 ]; then
    echo ">> --restart needs this script to start the server itself. Stop your server and run again."
    exit 2
  fi
else
  start_server || exit 1
  STARTED=1
fi

if [ "$RESTART" = 0 ]; then
  node scripts/verify-sdk.mjs
  exit $?
fi

# --restart: run the checks; when they ask for the server to be restarted, do it.
RESTART_TEST=1 node scripts/verify-sdk.mjs >"$OUT" 2>&1 &
NODE_PID=$!
tail -f "$OUT" --pid="$NODE_PID" 2>/dev/null &
TAIL_PID=$!
for _ in $(seq 1 600); do
  grep -q "Now STOP the server" "$OUT" 2>/dev/null && break
  kill -0 "$NODE_PID" 2>/dev/null || break
  sleep 0.5
done
if grep -q "Now STOP the server" "$OUT" 2>/dev/null; then
  sleep 2
  echo ">> [wrapper] stopping the server..."
  stop_server
  sleep 3
  echo ">> [wrapper] starting it again..."
  start_server || { kill "$NODE_PID" 2>/dev/null; exit 1; }
fi
wait "$NODE_PID"
CODE=$?
sleep 1
kill "$TAIL_PID" 2>/dev/null
exit $CODE
