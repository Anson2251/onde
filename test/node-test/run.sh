#!/usr/bin/env bash
# The `node:test` pilot: run the same files under Node's runner and under `onde --test`, then
# compare the spec transcripts after normalising the parts that cannot match (timings).
#
#   ./test/node-test/run.sh            # build target/debug/onde if missing, then compare
#   ONDE=/path/to/onde ./test/node-test/run.sh
#
# This comparison is the compatibility criterion for the module (m7-plan §3.5, D71): if the same
# file cannot run on both runtimes, the module is a lookalike. The files are ordinary CommonJS
# `node:test` suites; nothing here is onde-specific except the invocation.
#
# The normalisation covers paths, `node:` prefixes and timing numbers. Paths only appear on a
# failure, and a failure is not the scenario this script asserts; they are normalised so a broken
# run prints a readable diff instead of an absolute-path mismatch.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/debug/onde}}"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found: the pilot needs Node's runner to compare against" >&2
  exit 2
fi
if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; building it"
  ( cd "$root" && cargo build -p ln-cli ) || {
    echo "cargo build -p ln-cli failed" >&2
    exit 2
  }
fi
if [ ! -x "$onde" ]; then
  echo "still no onde binary at '$onde'; set ONDE=" >&2
  exit 2
fi

files=("$here"/*.test.js)
if [ ! -e "${files[0]}" ]; then
  echo "no *.test.js files in $here" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `--test-concurrency=1` keeps Node's per-file output in argument order, which is the order the
# onde runner uses (it is sequential by design). Node runs each file in its own process, so no
# transcript line says which file a test came from; the two streams are directly comparable.
node --test --test-concurrency=1 "${files[@]}" >"$work/node.out" 2>"$work/node.err"
node_code=$?

"$onde" --test "${files[@]}" >"$work/onde.out" 2>"$work/onde.err"
lite_code=$?

normalize() {
  sed -E \
    -e 's/\([0-9]+(\.[0-9]+)?ms\)/(Xms)/g' \
    -e 's/^(ℹ duration_ms ).*$/\1X/' \
    -e "s#$root/##g" \
    -e 's#/private/[^ :]*/test/node-test/#test/node-test/#g' \
    -e 's#"?node:#node:#g' \
    "$1"
}
normalize "$work/node.out" >"$work/node.norm"
normalize "$work/onde.out" >"$work/onde.norm"

failed=0
if [ -s "$work/node.err" ]; then
  echo "FAIL      node wrote to stderr:" >&2
  sed 's/^/          /' "$work/node.err" >&2
  failed=1
fi
if [ -s "$work/onde.err" ]; then
  echo "FAIL      onde wrote to stderr:" >&2
  sed 's/^/          /' "$work/onde.err" >&2
  failed=1
fi

if ! diff -u "$work/node.norm" "$work/onde.norm" >"$work/diff"; then
  echo "FAIL      the transcripts differ (node vs onde)" >&2
  sed 's/^/          /' "$work/diff" >&2
  failed=1
fi
if [ "$node_code" -ne "$lite_code" ]; then
  echo "FAIL      exit codes differ: node $node_code, onde $lite_code" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  echo
  echo "node transcript:"
  sed 's/^/  /' "$work/node.norm"
  echo "onde transcript:"
  sed 's/^/  /' "$work/onde.norm"
  exit 1
fi

echo "ok        ${#files[@]} pilot files, transcripts match (node exit $node_code, onde exit $lite_code)"
sed 's/^/          /' "$work/onde.norm"
