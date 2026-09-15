#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
DB_PATH="${SESSION_DB_PATH:-$ROOT_DIR/data/threadex.duckdb}"
SHUTDOWN_TIMEOUT_SECONDS="${SHUTDOWN_TIMEOUT_SECONDS:-15}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-60}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-0.25}"
LOG_PATH="$ROOT_DIR/data/server.log"
PID_PATH="$ROOT_DIR/data/server.pid"

deadline_reached() {
  [[ "$(date +%s)" -ge "$1" ]]
}

server_pids() {
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

db_holder_pids() {
  lsof -t "$DB_PATH" "$DB_PATH.wal" 2>/dev/null | sort -u || true
}

wait_until_empty() {
  local description="$1"
  local command_name="$2"
  local timeout_seconds="$3"
  local deadline=$(( $(date +%s) + timeout_seconds ))

  while [[ -n "$($command_name)" ]]; do
    if deadline_reached "$deadline"; then
      echo "Timed out waiting for $description." >&2
      return 1
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

cd "$ROOT_DIR"

listeners=( $(server_pids) )
if (( ${#listeners[@]} > 0 )); then
  for pid in "${listeners[@]}"; do
    process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    if [[ "$process_cwd" != "$ROOT_DIR" ]]; then
      echo "Refusing to stop PID $pid on port $PORT: cwd is $process_cwd, not $ROOT_DIR." >&2
      exit 1
    fi
  done

  process_groups=( $(
    for pid in "${listeners[@]}"; do
      ps -p "$pid" -o pgid= | tr -d ' '
    done | sort -u
  ) )

  echo "Stopping server process group(s): ${process_groups[*]}"
  for pgid in "${process_groups[@]}"; do
    kill -TERM -- "-$pgid" 2>/dev/null || true
  done

  if ! wait_until_empty "port $PORT to close" server_pids "$SHUTDOWN_TIMEOUT_SECONDS"; then
    echo "Grace period expired; forcing remaining server processes to stop."
    for pgid in "${process_groups[@]}"; do
      kill -KILL -- "-$pgid" 2>/dev/null || true
    done
    wait_until_empty "port $PORT to close after SIGKILL" server_pids 5
  fi
fi

wait_until_empty "DuckDB handles to close" db_holder_pids "$SHUTDOWN_TIMEOUT_SECONDS"

echo "Truncating oversized stored JSON payloads in $DB_PATH"
node scripts/truncate-duckdb-long-payloads.mjs --db "$DB_PATH"

echo "Starting server; log: $LOG_PATH"
npm run dev:server >>"$LOG_PATH" 2>&1 &
server_pid=$!
echo "$server_pid" >"$PID_PATH"
trap 'rm -f "$PID_PATH"' EXIT

startup_deadline=$(( $(date +%s) + STARTUP_TIMEOUT_SECONDS ))
until curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Server exited before becoming healthy. Recent log output:" >&2
    tail -n 80 "$LOG_PATH" >&2
    exit 1
  fi
  if deadline_reached "$startup_deadline"; then
    echo "Timed out waiting for server health. Recent log output:" >&2
    tail -n 80 "$LOG_PATH" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

echo "Server is healthy on http://127.0.0.1:$PORT (launcher PID $server_pid)."
echo "The restart command will remain attached so the dev server stays running."
wait "$server_pid"
