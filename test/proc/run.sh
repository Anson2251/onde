#!/usr/bin/env bash
# M5 acceptance: child_process, worker threads, shared memory, termination and signals.
#
#   ./test/proc/run.sh                 # 20k echo round-trips
#   FULL=1 ./test/proc/run.sh          # the roadmap's 1M round-trip benchmark
#
# Every case runs under node first and then under lite. The assertions are on exit status, not on
# timing output (rates differ by design); the scripts print one line per check.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="${LITE:-$root/target/debug/lite}"
node_bin="${NODE:-node}"

if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "node not found: the M5 harness compares node and lite" >&2
  exit 2
fi
if [ ! -x "$lite" ]; then
  echo "no lite binary at '$lite'; run 'cargo build' or set LITE=" >&2
  exit 2
fi

pass=0
fail=0
failed_names=()

run_case() {
  local name="$1" script="$2" runtime="$3" label
  label="$name via $(basename "$runtime")"
  local out
  out="$(mktemp)"
  RUNTIME="$runtime" WORKER_ECHO_FULL="${FULL:-0}" "$runtime" "$script" >"$out" 2>&1
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "FAIL      $label (exit $code)"
    sed 's/^/          /' "$out" | tail -20
    failed_names+=("$label")
    fail=$((fail + 1))
  elif grep -q "^not ok\|^FAIL" "$out"; then
    echo "FAIL      $label"
    grep -n "^not ok\|^FAIL" "$out" | sed 's/^/          /'
    failed_names+=("$label")
    fail=$((fail + 1))
  else
    echo "ok        $label"
    pass=$((pass + 1))
    # Show the aggregate lines from the interesting cases.
    grep -E "round-trips:|counter|wait woke|terminate" "$out" | sed 's/^/          /' || true
  fi
  rm -f "$out"
}

for script in child-process.js ordering.js worker-echo.js atomics.js terminate.js signals.js; do
  run_case "${script%.js}" "$here/$script" "$node_bin"
  run_case "${script%.js}" "$here/$script" "$lite"
done

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failing: %s\n' "${failed_names[@]}" >&2
  exit 1
fi
