#!/usr/bin/env bash
# Conformance runner for the onde corpus.
#
#   ./run.sh                       # compare target/debug/lite against recorded .expected files
#   RUN=node ./run.sh              # prove the expectations still describe Node
#   REGEN=1 RUN=node ./run.sh      # re-record expectations from Node (never from onde)
#   DIFF=1 ./run.sh                # differential: node vs lite, same stdout + exit code
#   SUITES="timers loop" ./run.sh  # only some suites
#
# A suite is a directory under test/conformance containing `<case>.js` and
# `<case>.expected`. The expected file holds stdout lines followed by `exit:<code>`.
# `divergences/` holds deliberate, documented differences: it is excluded from the Node
# self-test because its expectations are recorded from onde, not Node.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

runner="${RUN:-$root/target/debug/lite}"
if ! command -v "$runner" >/dev/null 2>&1 && [ ! -x "$runner" ]; then
  echo "no runtime found at '$runner'; set RUN=/path/to/lite" >&2
  exit 2
fi
runner_path="$(command -v "$runner" 2>/dev/null || printf '%s' "$runner")"
runner_name="$(basename "$runner_path")"

default_suites=(microtasks timers loop nexttick uncaught rejections modules stdlib fs stream zlib http https net child_process workers readline async_hooks divergences)
suites=()
if [ -n "${SUITES:-}" ]; then
  read -r -a suites <<<"${SUITES}"
else
  for suite in "${default_suites[@]}"; do
    [ -d "$here/$suite" ] && suites+=("$suite")
  done
fi

pass=0
fail=0
skipped=0
failed_names=()

# Wall-clock bound for one case. Node keeps its event loop alive while a server is still listening,
# so a case that fails to close one never exits, and without a bound the corpus run hangs with no
# line explaining why. 20 s is far above the slowest case (the fs and net suites finish in ms).
CASE_TIMEOUT="${CONFORMANCE_CASE_TIMEOUT:-20}"

# Run `runtime src` into `out`, killing it after CASE_TIMEOUT. The watchdog writes to /dev/null:
# a background subshell that inherits the capture pipe makes the caller's `$(...)` wait for the
# sleep even after the case has exited, which is indistinguishable from a hang.
run_bounded() {
  local runtime="$1" src="$2" out="$3" marker="$4"
  "$runtime" "$src" >"$out" 2>/dev/null &
  local pid=$!
  (
    sleep "$CASE_TIMEOUT"
    : >"$marker"
    kill -9 "$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local watchdog=$!
  local code=0
  wait "$pid" 2>/dev/null || code=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$code"
}

run_case() {
  local runtime="$1" src="$2"
  local out marker code=0
  out="$(mktemp)"
  marker="$out.timeout"
  run_bounded "$runtime" "$src" "$out" "$marker" || code=$?
  if [ -f "$marker" ]; then
    printf 'killed by the %ss case timeout\n' "$CASE_TIMEOUT" >"$out"
    code=124
    rm -f "$marker"
    : >"$out.timedout"
  fi
  printf 'exit:%d\n' "$code" >>"$out"
  printf '%s' "$out"
}

for suite in "${suites[@]}"; do
  dir="$here/$suite"
  if [ ! -d "$dir" ]; then
    echo "skip      $suite (no such suite)" >&2
    continue
  fi

  # `divergences/` expectations are recorded from onde and asserted to *differ* from Node,
  # so they are excluded from Node self-tests and only recorded on explicit request.
  if [ "$suite" = "divergences" ] && { [ "${DIFF:-0}" = "1" ] || { [ "$runner_name" = "node" ] && [ "${REGEN:-0}" != "1" ]; }; }; then
    echo "skip      $suite (divergence suite is lite-only)" >&2
    continue
  fi
  if [ "$suite" = "divergences" ] && [ "${REGEN:-0}" = "1" ] && [ "${RECORD_DIVERGENCES:-0}" != "1" ]; then
    echo "skip      $suite (set RECORD_DIVERGENCES=1 to record lite-only expectations)" >&2
    continue
  fi

  for src in "$dir"/*.js "$dir"/*.mjs "$dir"/*.cjs; do
    [ -e "$src" ] || continue
    base="$(basename "$src")"
    case_name="${base%.*}"
    name="$suite/$case_name"

    marker="$dir/$case_name.nodiff"
    if [ -f "$marker" ] && { [ "$runner_name" = "node" ] || [ "${DIFF:-0}" = "1" ]; }; then
      # Node's own output for this case depends on wall-clock timing; the expectation is the
      # deterministic onde order. See ADR-0003 §5.
      printf 'skip      %s (Node timing-dependent; .nodiff)\n' "$name"
      continue
    fi

    if [ "${DIFF:-0}" = "1" ]; then
      [ "$suite" = "divergences" ] && { skipped=$((skipped + 1)); continue; }
      if ! command -v node >/dev/null 2>&1; then
        echo "no node on PATH; DIFF=1 needs it" >&2
        exit 2
      fi
      node_src="$(mktemp)"
      node_code=0
      run_bounded node "$src" "$node_src" "$node_src.timeout" || node_code=$?
      printf 'exit:%d\n' "$node_code" >>"$node_src"

      lite_src="$(mktemp)"
      lite_code=0
      run_bounded "$runner_path" "$src" "$lite_src" "$lite_src.timeout" || lite_code=$?
      printf 'exit:%d\n' "$lite_code" >>"$lite_src"

      if diff -u "$node_src" "$lite_src" >/dev/null 2>&1; then
        printf 'same      %s\n' "$name"
        pass=$((pass + 1))
      else
        printf 'DIFF      %s\n' "$name"
        diff -u "$node_src" "$lite_src" | sed 's/^/          /'
        fail=$((fail + 1))
        failed_names+=("$name")
      fi
      rm -f "$node_src" "$node_src.timeout" "$lite_src" "$lite_src.timeout"
      continue
    fi

    expected="$dir/$(basename "$src" .js).expected"
    actual="$(run_case "$runner_path" "$src")"

    if [ -f "$actual.timedout" ]; then
      printf 'TIMEOUT   %s (killed after %ss)\n' "$name" "$CASE_TIMEOUT"
      fail=$((fail + 1))
      failed_names+=("$name")
      rm -f "$actual" "$actual.timedout"
      continue
    fi

    if [ "${REGEN:-0}" = "1" ]; then
      cp "$actual" "$expected"
      printf 'recorded  %s\n' "$name"
      rm -f "$actual"
    elif [ ! -f "$expected" ]; then
      printf 'MISSING   %s (%s)\n' "$name" "$expected"
      fail=$((fail + 1))
      failed_names+=("$name")
      rm -f "$actual"
    elif diff -u "$expected" "$actual" >/dev/null 2>&1; then
      printf 'ok        %s\n' "$name"
      pass=$((pass + 1))
      rm -f "$actual"
    else
      printf 'FAIL      %s\n' "$name"
      diff -u "$expected" "$actual" | sed 's/^/          /'
      fail=$((fail + 1))
      failed_names+=("$name")
      rm -f "$actual"
    fi
  done
done

printf '\n%d passed, %d failed' "$pass" "$fail"
[ "$skipped" -ne 0 ] && printf ', %d skipped' "$skipped"
printf '\n'
if [ "$fail" -ne 0 ]; then
  printf 'failed: %s\n' "${failed_names[*]}" >&2
  exit 1
fi
