#!/usr/bin/env bash
# End-to-end test of the chat chain, without a human at the keyboard.
#
# Starts a mock OpenAI-compatible endpoint, points AniMate's settings at it,
# boots the app with ?selftest=chat so it sends one canned turn, and reports
# what came back. Exercises the proxy, SSE streaming, tag parsing, character
# reaction and speech in one pass.

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
# Give the debug app its own data and log directories. Windows known folders
# ignore APPDATA overrides, so Rust reads ANIMATE_TEST_PROFILE explicitly.
if ! command -v cygpath >/dev/null 2>&1; then
  echo "FATAL: this harness requires Git Bash on Windows"; exit 1
fi
SANDBOX="$(mktemp -d)"
TEST_PROFILE="$(cygpath -m "$SANDBOX")"
APP_DIR="$SANDBOX/data"
APP_DIR_WIN="$(cygpath -m "$APP_DIR")"
LOGDIR="$SANDBOX/logs"
MOCK_LOG="$SANDBOX/mock-openai.log"
MOCK_PORT=8123
APP_PORT=8933
PY="${PYTHON:-python}"
APP_WIN_PID=""
MOCK_WIN_PID=""

listen_pid() {
  netstat -ano 2>/dev/null | awk -v endpoint="127.0.0.1:$1" \
    '$2 == endpoint && $4 == "LISTENING" { gsub(/\r/, "", $5); print $5; exit }'
}

cleanup() {
  if [ -n "$APP_WIN_PID" ]; then
    MSYS_NO_PATHCONV=1 taskkill /PID "$APP_WIN_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$MOCK_WIN_PID" ]; then
    MSYS_NO_PATHCONV=1 taskkill /F /PID "$MOCK_WIN_PID" >/dev/null 2>&1 || true
  fi
  for _ in 1 2 3 4 5; do
    if [ -z "$(listen_pid "$APP_PORT")" ] && [ -z "$(listen_pid "$MOCK_PORT")" ]; then
      break
    fi
    sleep 1
  done
}
trap cleanup EXIT

cd "$REPO" || exit 1
echo "data dir: $APP_DIR"
echo "log dir : $LOGDIR"

if [ ! -f "$EXE" ]; then
  echo "FATAL: debug app missing; run npm run dev once or cargo build in src-tauri"; exit 1
fi
for port in "$APP_PORT" "$MOCK_PORT"; do
  if netstat -ano 2>/dev/null | grep -q ":$port .*LISTENING"; then
    echo "FATAL: port $port is already in use"; exit 1
  fi
done
echo "ports clear"

echo ""
echo "=== settings pointed at the mock ==="
"$PY" - "$APP_DIR_WIN" "$MOCK_PORT" <<'PYEOF'
import json, pathlib, sys
app_dir, port = pathlib.Path(sys.argv[1]), sys.argv[2]
app_dir.mkdir(parents=True, exist_ok=True)
settings = {
    "llm": {"baseUrl": f"http://127.0.0.1:{port}/v1", "apiKey": "test-key", "model": "mock-chat"},
    "tts": {"enabled": True, "baseUrl": "", "apiKey": "", "model": "mock-tts", "voice": "alloy"},
}
(app_dir / "settings.json").write_text(json.dumps(settings, indent=2))
print(f"wrote {app_dir / 'settings.json'}")
PYEOF

echo ""
echo "=== starting mock provider ==="
"$PY" "$REPO/tools/mock-openai.py" "$MOCK_PORT" >"$MOCK_LOG" 2>&1 &
sleep 2
MOCK_WIN_PID="$(listen_pid "$MOCK_PORT")"
if [ -z "$MOCK_WIN_PID" ]; then
  echo "FATAL: mock server did not start"; exit 1
fi
curl -s -o NUL -w "mock reachable -> HTTP %{http_code}\n" --max-time 5 \
  -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" \
  -H 'Content-Type: application/json' -d '{"model":"x","stream":false}'

echo ""
echo "=== booting app with ?selftest=chat ==="
ANIMATE_TEST_PROFILE="$TEST_PROFILE" \
  ANIMATE_FRONTEND_URL="http://127.0.0.1:$APP_PORT/?selftest=chat" \
  "$EXE" >"$SANDBOX/animate-chat.log" 2>&1 &
sleep 2
APP_WIN_PID="$(listen_pid "$APP_PORT")"
if [ -z "$APP_WIN_PID" ]; then
  echo "FATAL: app did not start"; exit 1
fi
sleep 18

echo ""
echo "=== app log ==="
cat "$LOGDIR"/*.log 2>/dev/null || echo "(no log)"

echo ""
echo "=== mock server saw ==="
grep -E "chat:|speech:" "$MOCK_LOG" 2>/dev/null || echo "(nothing)"

echo ""
echo "=== result ==="
if ! grep -q 'smoke result: busy=false error=- emotion=happy failed=false' "$LOGDIR"/*.log 2>/dev/null; then
  echo "FAIL: the app did not complete the chat turn"; exit 1
fi
if ! grep -q 'chat: .*stream=True' "$MOCK_LOG" || ! grep -q 'speech:' "$MOCK_LOG"; then
  echo "FAIL: the mock did not receive streaming chat and speech"; exit 1
fi
echo "OK: chat, streaming, emotion, and speech completed"
