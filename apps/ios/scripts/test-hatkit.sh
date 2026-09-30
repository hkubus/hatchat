#!/usr/bin/env bash
# Run HatKit's tests, including `ServerTests`, which drive the Swift client and
# chat store against a real hat server (fake provider) and runner booted here
# with throwaway state. Needs `pnpm install` at the repo root and a Swift 6
# toolchain; works on macOS and Linux.
#
#   apps/ios/scripts/test-hatkit.sh            # everything
#   apps/ios/scripts/test-hatkit.sh --filter ServerTests
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${HAT_TEST_PORT:-8790}"
TOKEN="hatkit-test-token"
DATA="$(mktemp -d)"
PIDS=()

cleanup() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$DATA"
}
trap cleanup EXIT

# Print the tails of the server and runner logs, then exit non-zero.
fail() {
  echo "error: $*" >&2
  if [[ -f "$DATA/server.log" ]]; then echo "--- server log" >&2; tail -50 "$DATA/server.log" >&2; fi
  if [[ -f "$DATA/runner.log" ]]; then echo "--- runner log" >&2; tail -20 "$DATA/runner.log" >&2; fi
  exit 1
}

cd "$ROOT"
# `node --import tsx` rather than the tsx binary, so each is one process that
# `kill` stops outright.
HAT_PORT="$PORT" HAT_HOST=127.0.0.1 HAT_ENROLL_TOKEN=hatkit-enroll \
  HAT_AUTH_PASSWORD= HAT_AUTH_PASSWORD_HASH= HAT_AUTH_TOKEN="$TOKEN" \
  HAT_DB_PATH="$DATA/hat.db" HAT_MASTER_KEY_FILE="$DATA/master.key" \
  HAT_UPLOAD_DIR="$DATA/uploads" HAT_WORKSPACE_ROOT="$DATA/workspaces" \
  node --import tsx packages/server/src/index.ts >"$DATA/server.log" 2>&1 &
PIDS+=($!)

ready=0
for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$PORT/api/health" -H "Authorization: Bearer $TOKEN" >/dev/null && { ready=1; break; }
  sleep 0.2
done
[[ "$ready" == 1 ]] || fail "hat server did not become healthy on port $PORT within 20s"

HAT_SERVER_URL="ws://127.0.0.1:$PORT/link" HAT_ENROLL_TOKEN=hatkit-enroll \
  HAT_RUNNER_ID=hatkit-runner HAT_WORKSPACE_ROOT="$DATA/workspaces" \
  node --import tsx packages/runner/src/index.ts >"$DATA/runner.log" 2>&1 &
PIDS+=($!)

# The approval test needs the runner to execute the tool.
ready=0
for _ in $(seq 1 100); do
  # Captured rather than piped to `grep -q`, which can SIGPIPE curl under pipefail.
  health="$(curl -sf "http://127.0.0.1:$PORT/api/health" -H "Authorization: Bearer $TOKEN" || true)"
  [[ "$health" == *hatkit-runner* ]] && { ready=1; break; }
  sleep 0.2
done
[[ "$ready" == 1 ]] || fail "runner hatkit-runner did not connect to the server within 20s"

cd "$ROOT/apps/ios/HatKit"
EXTRA=()
# Swift 6.1 on Linux ships a libswiftObservation that references a symbol it
# does not link; the flag lets the test binary link regardless.
if [[ "$(uname)" == "Linux" ]]; then EXTRA+=(-Xlinker --allow-shlib-undefined); fi
# `${EXTRA[@]+...}`: macOS bash 3.2 treats an empty array as unset under `set -u`.
HAT_TEST_SERVER="http://127.0.0.1:$PORT" HAT_TEST_TOKEN="$TOKEN" \
  swift test ${EXTRA[@]+"${EXTRA[@]}"} "$@" || fail "swift test failed"
