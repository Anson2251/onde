#!/usr/bin/env bash
# RSS over time for the hello-world server (M7 criterion 6: < 25 MB, no growth).
#
#   ./test/soak/run.sh                        # 1 h, the nightly run
#   SOAK_SECONDS=120 ./test/soak/run.sh       # a smoke run
#   ./test/soak/run.sh --hard                 # fail on a slope instead of reporting it
#
# The server is the same fixture test/net/bench.sh uses, driven by a steady load so the process is
# doing work rather than sitting idle: an idle process that does not grow proves nothing. RSS is
# sampled every SOAK_INTERVAL seconds; the slope is a least-squares fit over the second half of the
# samples, because the first minutes are warm-up (page tables, JIT-less engine caches, allocator
# buckets) and a fit that includes them would call every run a leak.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="${LITE:-$root/target/release/lite}"
seconds="${SOAK_SECONDS:-3600}"
interval="${SOAK_INTERVAL:-10}"
rss_limit_mb="${SOAK_RSS_MB:-25}"
slope_limit="${SOAK_SLOPE_MB_PER_HOUR:-1.0}"
hard=0
[ "${1:-}" = "--hard" ] && hard=1
[ "${NET_BENCH_SOFT:-0}" = "1" ] && hard=0

# shellcheck source=../net/lib.sh
. "$here/../net/lib.sh"

if [ ! -x "$lite" ]; then
  echo "soak: no runtime at $lite (set LITE)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "soak: node is required for the load generator" >&2
  exit 2
fi
# A backstop: this is the one harness that can outlive a CI job. A very long run is a mistake, not
# a stronger claim.
if [ "$seconds" -gt 7200 ]; then
  echo "soak: SOAK_SECONDS=$seconds is beyond the 2 h cap" >&2
  exit 2
fi

machine_line
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-soak.XXXXXX")"
server_pid=""
loadgen_pid=""

cleanup() {
  [ -n "$loadgen_pid" ] && kill "$loadgen_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$lite" "$here/../net/fixtures/hello-server.js" "$tmp/port" >"$tmp/server.log" 2>&1 &
server_pid=$!

i=0
while [ ! -s "$tmp/port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 500 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    echo "soak: server failed to start" >&2
    sed 's/^/  /' "$tmp/server.log" 2>/dev/null || true
    exit 2
  fi
  sleep 0.01
done
port="$(cat "$tmp/port")"

# The load: one keep-alive run after another, each small enough that the generator restarts often
# and a generator stall cannot be mistaken for a quiet server.
load() {
  while kill -0 "$server_pid" 2>/dev/null; do
    node "$here/../net/loadgen.js" "$tmp/port" 32 5 100 >>"$tmp/load.log" 2>&1 || true
  done
}
load &
loadgen_pid=$!

samples="$tmp/samples"
: >"$samples"
started="$(date +%s)"
echo "soak: runtime=$lite seconds=$seconds interval=${interval}s rss_limit=${rss_limit_mb}MB slope_limit=${slope_limit}MB/h"

while :; do
  now="$(( $(date +%s) - started ))"
  if [ "$now" -ge "$seconds" ]; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "soak: the server died after ${now}s" >&2
    sed 's/^/  /' "$tmp/server.log" | tail -n 20 >&2
    exit 1
  fi
  kb="$(rss_kb "$server_pid")"
  [ -n "$kb" ] && printf '%s %s\n' "$now" "$kb" >>"$samples"
  sleep "$interval"
done

# One final sample, so a run with two samples still has an endpoint.
kb="$(rss_kb "$server_pid")"
[ -n "$kb" ] && printf '%s %s\n' "$(( $(date +%s) - started ))" "$kb" >>"$samples"

count="$(wc -l <"$samples" | tr -d ' ')"
if [ "$count" -lt 3 ]; then
  echo "soak: only $count samples; raise SOAK_SECONDS or lower SOAK_INTERVAL" >&2
  exit 2
fi

read -r first_mb last_mb peak_mb slope_mb_h <<EOF
$(awk -v limit="$slope_limit" '
  { t[NR] = $1; y[NR] = $2 / 1024 }
  END {
    n = NR
    peak = 0
    for (i = 1; i <= n; i++) if (y[i] > peak) peak = y[i]
    # Fit the second half only: the first minutes are allocator and page-table warm-up.
    start = int(n / 2) + 1
    m = 0; sx = 0; sy = 0; sxy = 0; sxx = 0
    for (i = start; i <= n; i++) {
      x = t[i] - t[start]
      m++; sx += x; sy += y[i]; sxy += x * y[i]; sxx += x * x
    }
    denom = m * sxx - sx * sx
    slope = (denom == 0) ? 0 : (m * sxy - sx * sy) / denom    # MB per second
    printf "%.2f %.2f %.2f %.2f\n", y[1], y[n], peak, slope * 3600
  }' "$samples")
EOF

printf 'RESULT samples=%s first_mb=%s last_mb=%s peak_mb=%s slope_mb_per_hour=%s rss_limit_mb=%s slope_limit_mb_per_hour=%s\n' \
  "$count" "$first_mb" "$last_mb" "$peak_mb" "$slope_mb_h" "$rss_limit_mb" "$slope_limit"

failures=0
if ! awk -v v="$peak_mb" -v l="$rss_limit_mb" 'BEGIN { exit !(v < l) }'; then
  echo "soak: peak RSS ${peak_mb}MB is not below ${rss_limit_mb}MB"
  failures=$((failures + 1))
fi
if ! awk -v v="$slope_mb_h" -v l="$slope_limit" 'BEGIN { exit !(v <= l) }'; then
  echo "soak: RSS grew ${slope_mb_h}MB/h (limit ${slope_limit}MB/h)"
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  if [ "$hard" -eq 0 ]; then
    echo "SUMMARY: $failures missed (report only; use --hard to enforce)"
    exit 0
  fi
  echo "SUMMARY: $failures missed"
  exit 1
fi
echo "SUMMARY: peak ${peak_mb}MB, slope ${slope_mb_h}MB/h over ${count} samples"
