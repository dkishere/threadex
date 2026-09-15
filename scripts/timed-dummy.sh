#!/usr/bin/env bash

set -euo pipefail

duration_seconds="${1:-180}"

if [[ ! "$duration_seconds" =~ ^[0-9]+$ ]] || (( duration_seconds < 1 )); then
  echo "usage: $0 [positive-duration-seconds]" >&2
  exit 64
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "timed-dummy: started pid=$$ duration=${duration_seconds}s at=$started_at"

sleep "$duration_seconds"

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "timed-dummy: completed pid=$$ at=$finished_at"
