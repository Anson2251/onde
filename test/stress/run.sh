#!/usr/bin/env bash
# Informational RSS check for the M1 timer criterion. This is a leak check (flat RSS across
# create/clear rounds), not a benchmark.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/release/onde}}"
[ -x "$onde" ] || onde="$root/target/debug/onde"
[ -x "$onde" ] || { echo "build onde first (cargo build --release)" >&2; exit 2; }

measure() {
  if /usr/bin/time -l true >/dev/null 2>&1; then
    # BSD/macOS
    /usr/bin/time -l "$@" 2>&1 |
      awk '/maximum resident set size/ { printf "max RSS: %.1f MB\n", $1 / 1048576 } /timers-10k ok/ { print }'
  else
    # GNU
    /usr/bin/time -v "$@" 2>&1 |
      awk '/Maximum resident set size/ { printf "max RSS: %.1f MB\n", $NF / 1024 } /timers-10k ok/ { print }'
  fi
}

echo "== baseline"
measure "$onde" -e '1+1'
echo "== 200k timer create/clear"
measure "$onde" "$here/timers-10k.js"
