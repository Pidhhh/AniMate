#!/usr/bin/env bash
# End-to-end verification for the AniMate Tauri shell.
#
# Boots the app against the loopback server (the production load path) and
# checks the routes, the guards, and the renderer bridge.
#
# Deliberately does NOT poll the port with curl before testing: Windows curl
# cannot write to /dev/null, so a polling loop never terminates and its own
# requests end up in the log we are trying to read.

set -u

# Repo root, derived from this script's location so the harness works from a
# fresh clone. cygpath converts the POSIX path Git Bash gives us into the
# Windows form the Tauri binary and the app-data lookup expect.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then
  REPO="$(cygpath -m "$REPO")"
fi
EXE="$REPO/src-tauri/target/debug/animate.exe"

# Serve the project's own dist rather than the copy Tauri stages into
# target/debug/dist.
#
# That staged copy is only refreshed when Tauri's build script re-runs, so
# `npm run vite:build && bash verify.sh` can silently exercise the PREVIOUS
# frontend — which is exactly how a stale bundle got diagnosed as a broken
# MMD backend. ANIMATE_STATIC_ROOT exists for this and takes precedence.
export ANIMATE_STATIC_ROOT="$REPO/dist"
if ! command -v cygpath >/dev/null 2>&1; then
  echo "FATAL: this harness requires Git Bash on Windows"; exit 1
fi
# The debug app uses this path for both data and logs, leaving the user's
# normal profile untouched.
SANDBOX="$(mktemp -d)"
TEST_PROFILE="$(cygpath -m "$SANDBOX")"
LOGDIR="$SANDBOX/logs"
PORT=8933
WAIT_SECS="${1:-14}"
APP_WIN_PID=""

listen_pid() {
  netstat -ano 2>/dev/null | awk -v endpoint="127.0.0.1:$1" \
    '$2 == endpoint && $4 == "LISTENING" { gsub(/\r/, "", $5); print $5; exit }'
}

cleanup() {
  if [ -n "$APP_WIN_PID" ]; then
    MSYS_NO_PATHCONV=1 taskkill /PID "$APP_WIN_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cd "$REPO" || exit 1

port_held() {
  netstat -ano 2>/dev/null | grep -q ":$PORT .*LISTENING"
}

if [ ! -f "$EXE" ]; then
  echo "FATAL: debug app missing; run npm run dev once or cargo build in src-tauri"; exit 1
fi
if port_held; then
  echo "FATAL: port $PORT is already in use"
  netstat -ano 2>/dev/null | grep ":$PORT .*LISTENING"
  exit 1
fi
echo "port $PORT free"

echo ""
echo "=== boot (production load path: window points at the loopback server) ==="
ANIMATE_TEST_PROFILE="$TEST_PROFILE" \
  ANIMATE_FRONTEND_URL="http://127.0.0.1:$PORT/" \
  "$EXE" >"$SANDBOX/animate-verify.log" 2>&1 &
sleep 2
APP_WIN_PID="$(listen_pid "$PORT")"
if [ -z "$APP_WIN_PID" ]; then
  echo "FATAL: app did not start"; exit 1
fi
echo "pid=$APP_WIN_PID  waiting ${WAIT_SECS}s with no competing HTTP traffic"
sleep "$WAIT_SECS"

echo ""
echo "=== renderer bridge + character ==="
grep -E "renderer|mounted|character" "$LOGDIR"/*.log 2>/dev/null || echo "!! NO RENDERER LINES"

echo ""
echo "=== model library (nothing bundled; empty is the expected state) ==="
printf 'GET /models/          -> HTTP %s (no directory listing expected)\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/models/")"
printf 'GET /models/nope/x    -> HTTP %s (want 404)\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/models/nope/x.skel")"
printf 'traversal under models -> HTTP %s (want 400)\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 --path-as-is "http://127.0.0.1:$PORT/models/../../../Windows/win.ini")"
printf 'settings.json must NOT be served -> HTTP %s (want 404)\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/models/../settings.json")"

echo ""
echo "=== spine runtime is still vendored (needed for imported models) ==="
printf 'GET /vendor/spine-webgl.js -> HTTP %s  %s bytes\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/vendor/spine-webgl.js")" \
  "$(curl -s --max-time 20 "http://127.0.0.1:$PORT/vendor/spine-webgl.js" | wc -c)"

echo ""
echo "=== routes (byte counts piped, so curl cannot mis-report) ==="
# Bundles live in dist/_vite, character data in dist/assets (see vite.config.ts).
ASSET=$(ls dist/_vite/*.js | head -1 | sed 's|dist/||')
CSS=$(ls dist/_vite/*.css | head -1 | sed 's|dist/||')
echo "index.html -> $(curl -s --max-time 10 "http://127.0.0.1:$PORT/" | wc -c) bytes"
echo "asset js   -> $(curl -s --max-time 10 "http://127.0.0.1:$PORT/$ASSET" | wc -c) bytes (disk: $(stat -c %s "dist/$ASSET"))"
echo "asset css  -> $(curl -s --max-time 10 "http://127.0.0.1:$PORT/$CSS" | wc -c) bytes (disk: $(stat -c %s "dist/$CSS"))"
echo "missing    -> HTTP $(curl -s -o NUL -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/definitely-not-here.js")"

echo ""
echo "=== range request ==="
curl -s -o NUL -D - --max-time 10 -H "Range: bytes=0-9" "http://127.0.0.1:$PORT/$ASSET" \
  | grep -iE "^(HTTP|content-range|content-length|accept-ranges)"

echo ""
echo "=== authentication guards (every privileged route is token-gated) ==="
# An unauthenticated request is refused before any other validation runs, so
# these all return 403 regardless of the URL they carry. URL-level policy —
# scheme rules, the private-address allowlist, traversal — is covered by the
# Rust unit tests, which call the validators directly instead of going through
# the auth wall first.
for pair in \
  "proxy, no token|/_proxy?u=https%3A%2F%2Fexample.com%2F|403" \
  "proxy, malformed url|/_proxy?u=not-a-valid-url|403" \
  "proxy, missing u|/_proxy|403" \
  "proxy, cross-origin|/_proxy?u=https%3A%2F%2Fexample.com%2F|403" \
  "diag, no token|/_diag?m=spoofed|403"; do
  IFS='|' read -r label path want <<< "$pair"
  got=$(curl -s -o NUL -w '%{http_code}' --max-time 10 --path-as-is "http://127.0.0.1:$PORT$path")
  printf '%-22s -> HTTP %s (want %s)\n' "$label" "$got" "$want"
done
printf '%-22s -> HTTP %s (want 403)\n' "cross-origin origin hdr" \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 -H 'Origin: https://evil.example' "http://127.0.0.1:$PORT/_proxy?u=https%3A%2F%2Fexample.com%2F")"
printf '%-22s -> HTTP %s (want 400)\n' "path traversal" \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 --path-as-is "http://127.0.0.1:$PORT/../../../Windows/win.ini")"

# The ws route needs a genuine upgrade handshake to reach its handler: axum's
# WebSocketUpgrade extractor rejects anything else with 400 *before* the auth
# check runs. A plain curl therefore proves nothing here — it has to send the
# upgrade headers to exercise the real path.
printf '%-22s -> HTTP %s (want 403)\n' "ws-proxy, no token" \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      "http://127.0.0.1:$PORT/_ws-proxy?u=wss%3A%2F%2Fexample.com%2F")"
printf '%-22s -> HTTP %s (want 403)\n' "ws-proxy, bad token" \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      -H 'x-animate-token: wrongtoken' \
      "http://127.0.0.1:$PORT/_ws-proxy?u=wss%3A%2F%2Fexample.com%2F")"

echo ""
echo "=== DNS-rebinding guard: a foreign Host must be refused ==="
printf 'static, Host: evil.com  -> HTTP %s (want 403)\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 -H 'Host: evil.com' "http://127.0.0.1:$PORT/")"
printf 'static, Host: loopback  -> HTTP %s (want 200)\n' \
  "$(curl -s -o NUL -w '%{http_code}' --max-time 10 -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/")"

echo ""
echo "=== the token works (proved by the renderer's own diag lines) ==="
# The renderer can only write to the log through /_diag, which requires the
# token. If injection or presentation were broken this would be silence rather
# than an error, which is exactly why it is asserted here.
DIAG=$(grep -c "\[renderer\]" "$LOGDIR"/*.log 2>/dev/null || echo 0)
if [ "${DIAG:-0}" -gt 0 ]; then
  echo "renderer diag lines accepted: $DIAG  (token injection works end to end)"
else
  echo "!! NO RENDERER DIAG LINES — the session token is not reaching the server"
fi

echo ""
echo "=== authenticated proxy path ==="
echo "Covered by verify-chat.sh: the app makes real proxied LLM and TTS calls"
echo "with the injected token. A bare curl cannot reproduce it by design."

echo ""
echo "=== full app log ==="
cat "$LOGDIR"/*.log 2>/dev/null || echo "(no log file)"

echo ""
echo "=== shutdown ==="
MSYS_NO_PATHCONV=1 taskkill /PID "$APP_WIN_PID" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5; do
  port_held || break
  sleep 1
done
if ! port_held; then APP_WIN_PID=""; fi
port_held && echo "WARNING: port still held after shutdown" || echo "port released cleanly"
echo "--- app stderr ---"
cat "$SANDBOX/animate-verify.log"
