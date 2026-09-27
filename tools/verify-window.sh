#!/usr/bin/env bash
# Verifies window geometry survives a restart — and, more importantly, that it
# does not *drift*.
#
# That second part is the real test. `set_size` takes the client area while
# `outer_size` includes the frame, so pairing them compounds the border on
# every launch: save outer, restore as inner, capture one frame larger. On
# Windows that was +16px per start, which is unbounded growth — and it looks
# fine on any single launch, so only a repeated cycle catches it.
#
# Requires a *graceful* close. `taskkill /F` is a hard kill and never fires
# the CloseRequested handler the save hangs off, so the harness deliberately
# omits it.
#
# Usage: bash tools/verify-window.sh [cycles]

set -u

# Repo root, derived from this script's location so the harness works from a
# fresh clone. cygpath converts the POSIX path Git Bash gives us into the
# Windows form the Tauri binary and the app-data lookup expect.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then
  REPO="$(cygpath -m "$REPO")"
fi
EXE="$REPO/src-tauri/target/debug/animate.exe"
PY="${PYTHON:-python}"
if ! command -v cygpath >/dev/null 2>&1; then
  echo "FATAL: this harness requires Git Bash on Windows"; exit 1
fi
# Use the debug app's test profile. A harness must never delete the user's
# saved window position.
SANDBOX="$(mktemp -d)"
TEST_PROFILE="$(cygpath -m "$SANDBOX")"
GEOMETRY="$SANDBOX/data/window.json"
LOGDIR="$SANDBOX/logs"
APP_PORT=8933
CYCLES="${1:-3}"
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

if [ ! -f "$EXE" ]; then
  echo "FATAL: debug app missing; run npm run dev once or cargo build in src-tauri"; exit 1
fi
if netstat -ano 2>/dev/null | grep -q ":$APP_PORT .*LISTENING"; then
  echo "FATAL: port $APP_PORT is already in use"; exit 1
fi
echo "starting from no saved geometry"

read_geometry() {
  "$PY" - "$GEOMETRY" <<'PYEOF'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
if not p.exists():
    print("MISSING")
    raise SystemExit
d = json.loads(p.read_text())
print(f"{d.get('width')}x{d.get('height')}@({d.get('x')},{d.get('y')})")
PYEOF
}

echo ""
echo "=== $CYCLES launch/close cycles ==="
first=""
drift=0
for i in $(seq 1 "$CYCLES"); do
  ANIMATE_TEST_PROFILE="$TEST_PROFILE" \
    ANIMATE_STATIC_ROOT="$REPO/dist" \
    ANIMATE_FRONTEND_URL="http://127.0.0.1:$APP_PORT/" \
    "$EXE" >"$SANDBOX/animate-window-$i.log" 2>&1 &
  sleep 2
  APP_WIN_PID="$(listen_pid "$APP_PORT")"
  if [ -z "$APP_WIN_PID" ]; then
    echo "FATAL: app did not start on cycle $i"; exit 1
  fi
  sleep 7

  if ! netstat -ano 2>/dev/null | grep -q ":$APP_PORT .*LISTENING"; then
    echo "FATAL: app did not start on cycle $i"; exit 1
  fi

  # No /F — a graceful close is what triggers the save.
  MSYS_NO_PATHCONV=1 taskkill /PID "$APP_WIN_PID" >/dev/null 2>&1
  sleep 3

  if [ -n "$(listen_pid "$APP_PORT")" ]; then
    echo "FATAL: app did not close on cycle $i"; exit 1
  fi
  APP_WIN_PID=""

  geometry=$(read_geometry)
  printf '  cycle %s: %s\n' "$i" "$geometry"

  if [ -z "$first" ]; then
    first="$geometry"
  elif [ "$geometry" != "$first" ]; then
    drift=1
  fi
done

echo ""
echo "=== result ==="
if [ "$first" = "MISSING" ]; then
  echo "FAIL  geometry was never saved — the close handler is not firing"
  exit 1
fi
if [ "$drift" -eq 1 ]; then
  echo "FAIL  geometry drifted across launches (first was $first)"
  echo "      set_size takes the client area; outer_size includes the frame."
  exit 1
fi
echo "OK    stable at $first across $CYCLES launches"

echo ""
echo "=== restore actually applied? ==="
grep -h "window restored" "$LOGDIR/"*.log 2>/dev/null | tail -1 \
  || echo "!! no restore line in the log"
