#!/usr/bin/env bash
# Differential test runner for the JavaScript stdlib (js/lib).
#
#   ./test/js/run.sh                 # every *.test.js under node and onde, compare stdout+exit
#   ONDE=/path/to/onde ./test/js/run.sh
#
# Two kinds of case:
#   * `*.test.js`   runtime-agnostic: requires our module by relative path and asserts literals.
#                   Run under both node and onde; their output must be identical.
#   * `*.oracle.js` Node-only differential against the corresponding Node builtin. These are the
#                   cases that keep our behaviour honest even before onde can run them.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/debug/onde}}"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found: the stdlib oracle cannot run" >&2
  exit 2
fi
if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi

pass=0
fail=0
failures=()

run_case() {
  local kind="$1" file="$2" runtime="$3" label
  label="$kind $(basename "$file") via $(basename "$runtime")"
  local out err code
  out="$(mktemp)"
  err="$(mktemp)"
  "$runtime" "$file" >"$out" 2>"$err"
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "FAIL      $label (exit $code)"
    # These tests print their failures to stdout and exit nonzero, so stdout is the diagnostic.
    sed 's/^/          /' "$out" | head -20
    sed 's/^/          /' "$err" | head -20
    failures+=("$label")
    fail=$((fail + 1))
  elif [ -s "$err" ]; then
    echo "FAIL      $label (unexpected stderr)"
    sed 's/^/          /' "$err" | head -20
    failures+=("$label")
    fail=$((fail + 1))
  else
    echo "ok        $label"
    pass=$((pass + 1))
  fi
  rm -f "$out" "$err"
}

for file in "$here"/lib/*.test.js; do
  [ -e "$file" ] || continue
  run_case test "$file" node
  run_case test "$file" "$onde"
done

for file in "$here"/lib/*.oracle.js; do
  [ -e "$file" ] || continue
  run_case oracle "$file" node
done

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failing: %s\n' "${failures[@]}" >&2
  exit 1
fi
