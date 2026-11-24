#!/usr/bin/env bash
# M7 exit criteria in one command (m7-plan §6).
#
#   ./test/perf/run.sh                     # hard on this machine
#   NET_BENCH_SOFT=1 ./test/perf/run.sh    # report only (shared CI runners)
#   PERF_BUILD=0 ./test/perf/run.sh        # reuse target/release/lite
#
# Measures, against Node on the same machine and the same fixture:
#
#   fs.readFile 10 MB   lite/node time ratio   <= 1.20    (criterion 2)
#   TCP echo            lite/node req/s ratio  >= 0.667   (criterion 3)
#   HTTP keep-alive     lite/node req/s ratio  >= 0.667   (criterion 4, at risk — reported, not gated)
#   cold start          delegated to test/net/coldstart.js (criterion 1)
#   binary size         <= 6.0 MB                          (criterion 10)
#
# Every line is a RESULT; the SUMMARY at the end is what a person reads. The machine state is
# printed first: a wall-clock ratio measured in low-power mode is a number about the power policy,
# and coldstart.js skips itself in that mode for exactly that reason.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="${PERF_LITE:-$root/target/release/lite}"
soft="${NET_BENCH_SOFT:-0}"
size_limit_mb=6.0

# shellcheck source=../net/lib.sh
. "$here/../net/lib.sh"

if [ "${PERF_BUILD:-1}" != "0" ]; then
  echo "perf: cargo build --release -p ln-cli"
  if ! (cd "$root" && cargo build --release -p ln-cli); then
    echo "perf: release build failed" >&2
    exit 2
  fi
fi
if [ ! -x "$lite" ]; then
  echo "perf: no release runtime at $lite (set PERF_LITE or PERF_BUILD=1)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "perf: node is required" >&2
  exit 2
fi

machine_line
node_bin="$(command -v node)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-perf.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

failures=0
warnings=0

note_failure() { failures=$((failures + 1)); }
note_warning() { warnings=$((warnings + 1)); }

# ratio gate: $1 = name, $2 = numerator, $3 = denominator, $4 = limit, $5 = how ("max" or "min")
ratio_line() {
  local name="$1" numerator="$2" denominator="$3" limit="$4" how="$5" ratio verdict
  ratio="$(awk -v n="$numerator" -v d="$denominator" 'BEGIN { if (d == 0) print "0"; else printf "%.3f", n / d }')"
  if awk -v r="$ratio" -v l="$limit" -v h="$how" 'BEGIN { exit !((h == "max" && r <= l) || (h == "min" && r >= l)) }'; then
    verdict="met"
  else
    verdict="missed"
  fi
  printf 'RESULT workload=%s node=%s lite=%s ratio=%s limit=%s (%s) %s%s\n' \
    "$name" "$denominator" "$numerator" "$ratio" "$limit" "$how" "$verdict" \
    "$([ "$soft" = "1" ] && printf ' (soft)')"
  [ "$verdict" = "missed" ] && return 1
  return 0
}

# ---------------------------------------------------------------- cold start (criterion 1)
echo "perf: cold start"
if ! node "$here/../net/coldstart.js" "$lite" 25 | tee "$tmp/coldstart.log"; then
  note_failure
fi

# ---------------------------------------------------------------- fs.readFile 10 MB (criterion 2)
echo "perf: fs.readFile 10 MB"
big="$tmp/ten-mb.bin"
node -e '
  const fs = require("fs");
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const out = fs.openSync(process.argv[1], "w");
  for (let i = 0; i < 10; i += 1) fs.writeSync(out, chunk);
  fs.closeSync(out);
' "$big"
if ! node "$here/fs-read.js" "$big" 30 | tee "$tmp/fs-node.log" >/dev/null; then
  echo "perf: the node baseline of fs-read failed" >&2
  note_failure
fi
if ! "$lite" "$here/fs-read.js" "$big" 30 | tee "$tmp/fs-lite.log" >/dev/null; then
  echo "perf: the lite fs-read failed" >&2
  note_failure
fi
fs_node="$(sed -n 's/.*median_ms=\([0-9.]*\).*/\1/p' "$tmp/fs-node.log" | head -n 1)"
fs_lite="$(sed -n 's/.*median_ms=\([0-9.]*\).*/\1/p' "$tmp/fs-lite.log" | head -n 1)"
if [ -n "$fs_node" ] && [ -n "$fs_lite" ]; then
  ratio_line "fs.readFile-10mb" "$fs_lite" "$fs_node" 1.20 max || note_failure
else
  note_failure
fi

# ---------------------------------------------------------------- TCP echo (criterion 3)
echo "perf: TCP echo"
if ! "$here/echo.sh" "$node_bin" | tee "$tmp/echo-node.log" >/dev/null; then
  echo "perf: the node baseline of the echo bench failed" >&2
  note_failure
fi
if ! "$here/echo.sh" "$lite" | tee "$tmp/echo-lite.log" >/dev/null; then
  echo "perf: the lite echo bench failed" >&2
  note_failure
fi
echo_node="$(sed -n 's/.*rps=\([0-9.]*\).*/\1/p' "$tmp/echo-node.log" | head -n 1)"
echo_lite="$(sed -n 's/.*rps=\([0-9.]*\).*/\1/p' "$tmp/echo-lite.log" | head -n 1)"
if [ -n "$echo_node" ] && [ -n "$echo_lite" ]; then
  ratio_line "tcp-echo" "$echo_lite" "$echo_node" 0.667 min || note_failure
else
  note_failure
fi

# ---------------------------------------------------------------- HTTP keep-alive (criterion 4)
# At risk by design (m7-plan §9, R9): the tail is one isolate queueing every connection, which
# allocation work cannot fix. The number is published; the gate only fires when PERF_HTTP_HARD=1.
echo "perf: HTTP keep-alive"
if ! NET_BENCH_NO_BUILD=1 NET_BENCH_SOFT=1 LITE_RELEASE="$node_bin" \
  "$here/../net/bench.sh" | tee "$tmp/http-node.log" >/dev/null; then
  echo "perf: the node baseline of the HTTP bench failed" >&2
  note_failure
fi
if ! NET_BENCH_NO_BUILD=1 NET_BENCH_SOFT=1 LITE_RELEASE="$lite" \
  "$here/../net/bench.sh" | tee "$tmp/http-lite.log" >/dev/null; then
  echo "perf: the lite HTTP bench failed" >&2
  note_failure
fi
http_node="$(sed -n 's/.*rps=\([0-9.]*\).*/\1/p' "$tmp/http-node.log" | head -n 1)"
http_lite="$(sed -n 's/.*rps=\([0-9.]*\).*/\1/p' "$tmp/http-lite.log" | head -n 1)"
if [ -n "$http_node" ] && [ -n "$http_lite" ]; then
  if ! ratio_line "http-keepalive" "$http_lite" "$http_node" 0.667 min; then
    if [ "${PERF_HTTP_HARD:-0}" = "1" ]; then note_failure; else note_warning; fi
  fi
else
  note_failure
fi

# ---------------------------------------------------------------- half-open (criterion 5)
# Paired against the raw-TCP floor; the absolute 25 MB target is unreachable (m7-plan §6.1). This
# one is slow (two 2,000-connection floods), so a quick local loop can skip it.
if [ "${PERF_SKIP_HALFOPEN:-0}" != "1" ]; then
  echo "perf: half-open connections (paired with the raw floor)"
  if ! NET_CONNS="${PERF_HALFOPEN_CONNS:-2000}" "$here/halfopen.sh" | tee "$tmp/halfopen.log"; then
    note_failure
  fi
fi

# ---------------------------------------------------------------- binary size (criterion 10)
bytes="$(wc -c <"$lite" | tr -d ' ')"
size_mb="$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b / 1048576 }')"
if awk -v mb="$size_mb" -v limit="$size_limit_mb" 'BEGIN { exit !(mb <= limit) }'; then
  printf 'RESULT workload=binary-size lite=%sMB limit=%sMB (max) met\n' "$size_mb" "$size_limit_mb"
else
  printf 'RESULT workload=binary-size lite=%sMB limit=%sMB (max) missed\n' "$size_mb" "$size_limit_mb"
  note_failure
fi

if [ "$failures" -ne 0 ] && [ "$soft" = "1" ]; then
  echo "SUMMARY: $failures missed, $warnings warn — soft mode, not enforced (lowpowermode=$(power_mode) load=$(load_average))"
  exit 0
fi
echo "SUMMARY: $failures missed, $warnings warn (lowpowermode=$(power_mode) load=$(load_average))"
[ "$failures" -eq 0 ]
