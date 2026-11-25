#!/usr/bin/env bash
# M2 smoke set: 30 generated CJS packages + 10 ESM packages, run under node and onde, outputs
# compared. This is the "curated package set" exit criterion for M2, kept offline and
# dependency-free so it runs on every CI job.
#
#   ./test/smoke/run.sh
#   ONDE=/path/to/onde ./test/smoke/run.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/debug/onde}}"
tree="$root/target/smoke"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found: the smoke tree needs it to generate fixtures and as the oracle" >&2
  exit 2
fi
if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi

node "$here/generate.js" "$tree" >/dev/null || exit 1

pass=0
fail=0
failed=()

run() {
  local entry="$1"
  local node_out lite_out
  node_out="$(mktemp)"
  lite_out="$(mktemp)"

  ( cd "$tree" && node "$entry" ) >"$node_out" 2>/dev/null
  local node_code=$?
  ( cd "$tree" && "$onde" "$entry" ) >"$lite_out" 2>/dev/null
  local lite_code=$?

  if [ "$node_code" -ne 0 ] || [ "$lite_code" -ne 0 ]; then
    echo "FAIL      $entry (node exit $node_code, onde exit $lite_code)"
    diff -u "$node_out" "$lite_out" | head -20 | sed 's/^/          /'
    failed+=("$entry exit")
    fail=$((fail + 1))
  elif ! diff -q "$node_out" "$lite_out" >/dev/null; then
    echo "FAIL      $entry (output differs)"
    diff -u "$node_out" "$lite_out" | head -20 | sed 's/^/          /'
    failed+=("$entry output")
    fail=$((fail + 1))
  else
    echo "ok        $entry ($(wc -l < "$lite_out" | tr -d ' ') lines)"
    pass=$((pass + 1))
  fi

  rm -f "$node_out" "$lite_out"
}

echo "generated $tree"
run main.cjs
run main.mjs

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failing: %s\n' "${failed[@]}" >&2
  exit 1
fi
