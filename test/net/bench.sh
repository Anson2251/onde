#!/usr/bin/env bash
# Release-build hello-world benchmark for the M4 exit criterion.
#
#   ./test/net/bench.sh                  # strict: > 20k req/s and p99 < 5 ms
#   NET_BENCH_SOFT=1 ./test/net/bench.sh # thresholds are informational
#   ONDE_RELEASE=/path/to/onde ./test/net/bench.sh
#
# The server is `target/release/onde` (built on demand with `cargo build --release -p ln-cli`),
# bound to 127.0.0.1:0. One node process drives 100 keep-alive connections: a warm-up phase, then
# a measured phase with per-request latency. The server is single-threaded (one isolate, one
# runtime), so it effectively runs on one core.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE_RELEASE:-${LITE_RELEASE:-${NET_ONDE_RELEASE:-${NET_LITE_RELEASE:-$root/target/release/onde}}}}"
soft="${NET_BENCH_SOFT:-0}"
server_js="$here/fixtures/hello-server.js"
loadgen="$here/loadgen.js"
connections="${NET_BENCH_CONNECTIONS:-100}"
warmup="${NET_BENCH_WARMUP:-20}"
requests="${NET_BENCH_REQUESTS:-200}"

# Build the release binary on every run (cargo is incremental): a stale target/release/onde must
# never be benchmarked, and the criterion is about the current tree. NET_BENCH_NO_BUILD=1 skips
# the build for repeat runs on an already-fresh binary.
if [ "${NET_BENCH_NO_BUILD:-0}" != "1" ]; then
  echo "bench: cargo build --release -p ln-cli"
  if ! (cd "$root" && cargo build --release -p ln-cli); then
    echo "bench: cargo build --release failed" >&2
    exit 2
  fi
fi
if [ ! -x "$onde" ]; then
  echo "bench: no release runtime at $onde (set ONDE_RELEASE)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "bench: node is required" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-bench.XXXXXX")"
port_file="$tmp/port"
server_log="$tmp/server.log"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$onde" "$server_js" "$port_file" >"$server_log" 2>&1 &
server_pid=$!

i=0
while [ ! -s "$port_file" ]; do
  i=$((i + 1))
  if [ "$i" -gt 500 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    echo "bench: server failed to start" >&2
    sed 's/^/  /' "$server_log" 2>/dev/null || true
    exit 2
  fi
  sleep 0.01
done

echo "bench: runtime=$onde connections=$connections warmup=$warmup requests/connection=$requests soft=$soft"
result="$(node "$loadgen" "$port_file" "$connections" "$warmup" "$requests")"
loadgen_code=$?
echo "$result"
if [ "$loadgen_code" -ne 0 ]; then
  echo "SUMMARY: load generator failed (see RESULT above)" >&2
  exit 1
fi

rps="$(printf '%s\n' "$result" | sed -n 's/.*rps=\([0-9.]*\).*/\1/p')"
p50="$(printf '%s\n' "$result" | sed -n 's/.*p50_ms=\([0-9.]*\).*/\1/p')"
p99="$(printf '%s\n' "$result" | sed -n 's/.*p99_ms=\([0-9.]*\).*/\1/p')"

failures=0
verdict="met"
if ! awk -v value="$rps" 'BEGIN { exit !(value > 20000) }'; then
  verdict="missed"
  failures=$((failures + 1))
  echo "bench: req/s $rps is not > 20000"
fi
if ! awk -v value="$p99" 'BEGIN { exit !(value < 5) }'; then
  verdict="missed"
  failures=$((failures + 1))
  echo "bench: p99 ${p99}ms is not < 5ms"
fi

if [ "$failures" -ne 0 ] && [ "$soft" = "1" ]; then
  echo "SUMMARY: rps=$rps p50=${p50}ms p99=${p99}ms connections=$connections (thresholds $verdict; soft mode, not enforced)"
  exit 0
fi
echo "SUMMARY: rps=$rps p50=${p50}ms p99=${p99}ms connections=$connections (thresholds $verdict)"
[ "$failures" -eq 0 ]
