#!/usr/bin/env bash
# The half-open bound, paired (m7-plan §6.1, criterion 5).
#
#   ./test/perf/halfopen.sh
#   NET_CONNS=500 ./test/perf/halfopen.sh      # the same comparison, cheaper
#
# Runs test/net/slowloris.sh twice against the same binary: once with the HTTP server, once with a
# raw TCP server that accepts and never answers. The difference is what the HTTP layer costs per
# half-open connection, and that difference is the criterion — the absolute number cannot be, because
# 2,000 idle sockets already cost ~29 MB before any JavaScript runs.
#
# Gate: http − raw <= 2 MB. Prints one RESULT line per run and a paired SUMMARY.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="${LITE:-$root/target/release/lite}"
conns="${NET_CONNS:-2000}"
limit_mb="${HALFOPEN_DELTA_MB:-2.0}"
soft="${NET_BENCH_SOFT:-0}"

# shellcheck source=../net/lib.sh
. "$here/../net/lib.sh"

if [ ! -x "$lite" ]; then
  echo "halfopen: no runtime at $lite (set LITE)" >&2
  exit 2
fi

machine_line

raw_log="$(mktemp "${TMPDIR:-/tmp}/ln-halfopen-raw.XXXXXX")"
http_log="$(mktemp "${TMPDIR:-/tmp}/ln-halfopen-http.XXXXXX")"
trap 'rm -f "$raw_log" "$http_log"' EXIT INT TERM

echo "halfopen: raw floor ($conns connections)"
if ! NET_CONNS="$conns" NET_SLOWLORIS_RAW=1 LITE="$lite" "$here/../net/slowloris.sh" >"$raw_log" 2>&1; then
  echo "halfopen: the raw floor run failed" >&2
  sed 's/^/  /' "$raw_log" >&2
  exit 1
fi
cat "$raw_log"
# TIME_WAIT entries from 2,000 just-closed sockets can stop the next run from opening its own,
# and comparing a full flood against a partial one reads as a huge negative delta. Settle first;
# slowloris.sh itself refuses to report a run that opened fewer than it asked for.
sleep 2

echo "halfopen: HTTP layer ($conns connections)"
if ! NET_CONNS="$conns" LITE="$lite" "$here/../net/slowloris.sh" >"$http_log" 2>&1; then
  # The HTTP run's own gate is the old 25 MB bound, which M4 recorded as a gap; its exit status is
  # not this script's verdict. Print what it said and decide on the delta.
  cat "$http_log"
else
  cat "$http_log"
fi

raw_mb="$(sed -n 's/.*mode=raw rss_mb=\([0-9.]*\).*/\1/p' "$raw_log" | head -n 1)"
http_mb="$(sed -n 's/.*mode=http rss_mb=\([0-9.]*\).*/\1/p' "$http_log" | head -n 1)"
if [ -z "$raw_mb" ] || [ -z "$http_mb" ]; then
  echo "halfopen: could not read both RSS numbers" >&2
  exit 1
fi

delta="$(awk -v h="$http_mb" -v r="$raw_mb" 'BEGIN { printf "%.1f", h - r }')"
if awk -v d="$delta" -v limit="$limit_mb" 'BEGIN { exit !(d <= limit) }'; then
  verdict="met"
else
  verdict="missed"
fi
printf 'RESULT workload=halfopen-conns=%s raw_mb=%s http_mb=%s delta_mb=%s limit_mb=%s (max) %s%s\n' \
  "$conns" "$raw_mb" "$http_mb" "$delta" "$limit_mb" "$verdict" \
  "$([ "$soft" = "1" ] && printf ' (soft)')"

if [ "$verdict" = "missed" ]; then
  if [ "$soft" = "1" ]; then
    echo "SUMMARY: delta ${delta}MB over the raw floor exceeds ${limit_mb}MB (soft, not enforced)"
    exit 0
  fi
  echo "SUMMARY: delta ${delta}MB over the raw floor exceeds ${limit_mb}MB"
  exit 1
fi
echo "SUMMARY: delta ${delta}MB over the raw floor (limit ${limit_mb}MB)"
