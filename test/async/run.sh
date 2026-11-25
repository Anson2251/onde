#!/usr/bin/env bash
# M6 acceptance: async_hooks and AsyncLocalStorage.
#
#   ./test/async/run.sh            # run every *.js under node and onde, diff stdout + exit code
#   ONDE=/path/to/onde ./test/async/run.sh
#
# These are differential tests, not recorded expectations: the matrix and the semantics checks
# print only values both runtimes must agree on, so a diff is a propagation bug rather than a
# formatting difference. Node is required — it is the reference, not a convenience.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/debug/onde}}"
case_timeout="${ASYNC_CASE_TIMEOUT:-180}"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found: async_hooks needs a reference runtime" >&2
  exit 2
fi
if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi

pass=0
fail=0
failed=()

for file in "$here"/*.js; do
  name="$(basename "$file")"
  node_out="$(mktemp)"
  lite_out="$(mktemp)"
  timeout "$case_timeout" node "$file" >"$node_out" 2>&1
  node_code=$?
  timeout "$case_timeout" "$onde" "$file" >"$lite_out" 2>&1
  lite_code=$?

  if [ "$node_code" -ne 0 ]; then
    echo "FAIL      node $name (exit $node_code)"
    tail -20 "$node_out" | sed 's/^/          /'
    fail=$((fail + 1))
    failed+=("node $name")
  elif [ "$lite_code" -ne 0 ]; then
    echo "FAIL      onde $name (exit $lite_code)"
    tail -20 "$lite_out" | sed 's/^/          /'
    fail=$((fail + 1))
    failed+=("onde $name")
  elif ! diff -q "$node_out" "$lite_out" >/dev/null; then
    echo "FAIL      $name (node and onde disagree)"
    diff -u "$node_out" "$lite_out" | sed 's/^/          /' | head -40
    fail=$((fail + 1))
    failed+=("$name")
  else
    echo "ok        $name"
    pass=$((pass + 1))
  fi
  rm -f "$node_out" "$lite_out"
done

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
