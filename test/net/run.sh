#!/usr/bin/env bash
# Acceptance orchestrator for the M4 network work (WP7). One line per check; a functional failure
# makes the script exit nonzero. Performance thresholds are enforced unless NET_BENCH_SOFT=1.
#
#   ./test/net/run.sh                     # dev machine: strict perf thresholds
#   NET_BENCH_SOFT=1 ./test/net/run.sh    # CI: perf numbers are informational
#   ONDE=/path/to/onde ./test/net/run.sh
#
# Checks:
#   interop    test/net/interop.sh       (4 plaintext legs + TLS legs when available)
#   bench      test/net/bench.sh         (release build, 100 keep-alive connections)
#   fdleak     test/net/fdleak.sh        (10k connect/disconnect, fd + RSS growth)
#   slowloris  test/net/slowloris.sh     (NET_CONNS half-open connections, 431)
#   coldstart  test/net/coldstart.js     (25 release runs, two expressions)
#
# The corpus itself is recorded and graded by ./test/conformance/run.sh (see m4-plan §7).

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/debug/onde}}"
release="${ONDE_RELEASE:-${LITE_RELEASE:-${NET_ONDE_RELEASE:-${NET_LITE_RELEASE:-$root/target/release/onde}}}}"
soft="${NET_BENCH_SOFT:-0}"

if [ ! -x "$onde" ]; then
  echo "no onde runtime at '$onde'; build it (cargo build) or set ONDE=/path/to/onde" >&2
  exit 2
fi

export ONDE="$onde" NET_BENCH_SOFT="$soft"
echo "net acceptance: onde=$onde release=$release soft=$soft"

# Cold start is a release measurement, so the release binary must correspond to the current tree.
if [ "${NET_BENCH_NO_BUILD:-0}" != "1" ] && command -v cargo >/dev/null 2>&1; then
  if ! (cd "$root" && cargo build --release -p ln-cli >/dev/null); then
    echo "net acceptance: cargo build --release failed" >&2
    exit 2
  fi
fi

passed=0
failed=0
skipped=0
declare -a failures=()

# run_check <name> <command...>: captures output, prints one line, records the failure.
run_check() {
  local name="$1"
  shift
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/ln-check.XXXXXX")"
  if "$@" >"$log" 2>&1; then
    local summary
    summary="$(grep '^SUMMARY:' "$log" | tail -n 1 | sed 's/^SUMMARY: //')"
    printf 'ok        %-10s %s\n' "$name" "$summary"
    passed=$((passed + 1))
  else
    local code=$?
    if [ "$code" -eq 77 ]; then
      printf 'skip      %-10s %s\n' "$name" "$(grep '^SKIP:' "$log" | tail -n 1 | sed 's/^SKIP: //')"
      skipped=$((skipped + 1))
    else
      printf 'FAIL      %-10s\n' "$name"
      sed 's/^/            /' "$log"
      failures+=("$name")
      failed=$((failed + 1))
    fi
  fi
  rm -f "$log"
}

# Cold start runs first: it is a latency measurement, so it must not follow the benchmark and the
# connection churn (CPU frequency and scheduler state would dominate the 12 ms signal).
if [ -x "$release" ]; then
  run_check coldstart node "$here/coldstart.js" "$release" 25
else
  printf 'skip      %-10s %s\n' "coldstart" "no release runtime at $release (cargo build --release)"
  skipped=$((skipped + 1))
fi

run_check interop "$here/interop.sh"
run_check bench "$here/bench.sh"
run_check fdleak "$here/fdleak.sh"
run_check slowloris "$here/slowloris.sh"

printf '\n%d passed, %d failed' "$passed" "$failed"
[ "$skipped" -ne 0 ] && printf ', %d skipped' "$skipped"
printf '\n'
if [ "$failed" -ne 0 ]; then
  printf 'failed: %s\n' "${failures[*]}" >&2
  exit 1
fi
