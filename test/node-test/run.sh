#!/usr/bin/env bash
# The `node:test` pilot: run the same files under Node's runner and under `lite --test`, then
# compare the spec transcripts after normalising the parts that cannot match (timings).
#
#   ./test/node-test/run.sh            # build target/debug/lite if missing, then compare
#   LITE=/path/to/lite ./test/node-test/run.sh
#
# This comparison is the compatibility criterion for the module (m7-plan §3.5, D71): if the same
# file cannot run on both runtimes, the module is a lookalike. The files are ordinary CommonJS
# `node:test` suites; nothing here is lite-specific except the invocation.
#
# The normalisation covers paths, `node:` prefixes and timing numbers. Paths only appear on a
# failure, and a failure is not the scenario this script asserts; they are normalised so a broken
# run prints a readable diff instead of an absolute-path mismatch.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="${LITE:-$root/target/debug/lite}"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found: the pilot needs Node's runner to compare against" >&2
  exit 2
fi
if [ ! -x "$lite" ]; then
  echo "no lite binary at '$lite'; building it"
  ( cd "$root" && cargo build -p ln-cli ) || {
    echo "cargo build -p ln-cli failed" >&2
    exit 2
  }
fi
if [ ! -x "$lite" ]; then
  echo "still no lite binary at '$lite'; set LITE=" >&2
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
# lite runner uses (it is sequential by design). Node runs each file in its own process, so no
# transcript line says which file a test came from; the two streams are directly comparable.
node --test --test-concurrency=1 "${files[@]}" >"$work/node.out" 2>"$work/node.err"
node_code=$?

"$lite" --test "${files[@]}" >"$work/lite.out" 2>"$work/lite.err"
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
normalize "$work/lite.out" >"$work/lite.norm"

failed=0
if [ -s "$work/node.err" ]; then
  echo "FAIL      node wrote to stderr:" >&2
  sed 's/^/          /' "$work/node.err" >&2
  failed=1
fi
if [ -s "$work/lite.err" ]; then
  echo "FAIL      lite wrote to stderr:" >&2
  sed 's/^/          /' "$work/lite.err" >&2
  failed=1
fi

if ! diff -u "$work/node.norm" "$work/lite.norm" >"$work/diff"; then
  echo "FAIL      the transcripts differ (node vs lite)" >&2
  sed 's/^/          /' "$work/diff" >&2
  failed=1
fi
if [ "$node_code" -ne "$lite_code" ]; then
  echo "FAIL      exit codes differ: node $node_code, lite $lite_code" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  echo
  echo "node transcript:"
  sed 's/^/  /' "$work/node.norm"
  echo "lite transcript:"
  sed 's/^/  /' "$work/lite.norm"
  exit 1
fi

echo "ok        ${#files[@]} pilot files, transcripts match (node exit $node_code, lite exit $lite_code)"
sed 's/^/          /' "$work/lite.norm"
