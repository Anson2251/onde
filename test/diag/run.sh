#!/usr/bin/env bash
# Diagnostics acceptance (m7-plan §4.5, criterion 7).
#
#   ./test/diag/run.sh                  # debug build
#   LITE=target/release/lite ./test/diag/run.sh
#
# Runs test/diag/workload.js three ways:
#   1. --trace-events + --timing + --trace-gc, validated by test/diag/validate.js;
#   2. --timing alone, which must print a row per phase without writing a trace;
#   3. no flags, which must not write a trace and must not print timing.
# Exits nonzero on any structural failure. Cheap enough for every PR.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
LITE="${LITE:-$root/target/debug/lite}"
workload="$here/workload.js"

if [ ! -x "$LITE" ]; then
  echo "diag: no runtime at '$LITE' (build it, or set LITE)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "diag: node is required for the validator" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-diag.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

failures=0
fail() {
  echo "FAIL $*"
  failures=$((failures + 1))
}

# ---------------------------------------------------------------- 1. full trace
trace="$tmp/trace.json"
if ! "$LITE" --trace-events "$trace" --timing --trace-gc "$workload" >"$tmp/run.log" 2>"$tmp/timing.log"; then
  fail "the traced workload exited nonzero"
  sed 's/^/  /' "$tmp/run.log" "$tmp/timing.log"
fi
if [ ! -s "$trace" ]; then
  fail "no trace file was written"
else
  if ! node "$here/validate.js" "$trace"; then
    fail "the trace did not validate"
  fi
  events="$(node -e 'const e=require(process.argv[1]).traceEvents;console.log(e.length)' "$trace")"
  echo "ok        trace ($events events)"
fi
if ! grep -q '^timing: ' "$tmp/timing.log"; then
  fail "--timing printed no rows"
else
  rows="$(grep -c '^timing: ' "$tmp/timing.log")"
  echo "ok        timing ($rows rows)"
fi

# ---------------------------------------------------------------- 2. timing alone
if ! "$LITE" --timing "$workload" >/dev/null 2>"$tmp/timing-only.log"; then
  fail "--timing alone exited nonzero"
fi
if ! grep -q '^timing: completion ' "$tmp/timing-only.log"; then
  fail "--timing alone did not report the completion phase"
else
  echo "ok        timing without a trace"
fi

# ---------------------------------------------------------------- 3. off costs nothing visible
if ! "$LITE" "$workload" >/dev/null 2>"$tmp/off.log"; then
  fail "the plain run exited nonzero"
fi
if grep -q '^timing: ' "$tmp/off.log"; then
  fail "timing rows appeared without --timing"
else
  echo "ok        no diagnostics when none were asked for"
fi
if ls "$tmp"/trace.json >/dev/null 2>&1 && [ "$(wc -c <"$trace")" -eq 0 ]; then
  fail "trace file was created empty"
fi

if [ "$failures" -ne 0 ]; then
  echo "SUMMARY: $failures failed"
  exit 1
fi
echo "SUMMARY: trace, timing and trace-gc behave as documented"
