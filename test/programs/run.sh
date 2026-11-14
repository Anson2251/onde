#!/usr/bin/env bash
# M3 acceptance programs: `cat`, `wc -l`, `cp -r` implemented in JS over `fs` + `stream`.
#
# Every program is run under `node` and under `lite`; stdout, stderr and the exit code must match.
# This is the roadmap's M3 exit criterion, not a unit test: the programs use only public API, so
# they exercise streams, backpressure, fd handling and error messages at once.
#
#   ./test/programs/run.sh
#   LITE=/path/to/lite NODE=/path/to/node ./test/programs/run.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="${LITE:-$root/target/debug/lite}"
node_bin="${NODE:-node}"

if [ ! -x "$lite" ]; then
  echo "no lite binary at '$lite'; run 'cargo build' or set LITE=" >&2
  exit 2
fi
if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "no node binary ('$node_bin'): the oracle side cannot run" >&2
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/lite-programs.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# --- fixture ---------------------------------------------------------------------------------
mkdir -p "$work/src/sub/deep"
printf 'alpha\nbeta\n' >"$work/src/a.txt"
: >"$work/src/empty.txt"
printf 'one two three\nfour five\n' >"$work/src/sub/b.txt"
printf 'deep\nlines\nhere\n' >"$work/src/sub/deep/c.txt"
# 200 KiB with no trailing newline: exercises chunked reads and backpressure.
head -c 204800 /dev/zero | tr '\0' 'z' >"$work/src/big.txt"
printf 'tail' >>"$work/src/big.txt"
ln -s a.txt "$work/src/link.txt"

pass=0
fail=0
failures=()

show() {
  local label="$1"
  shift
  echo "FAIL      $label"
  for file in "$@"; do
    [ -s "$file" ] && sed 's/^/          /' "$file" | head -12
  done
  failures+=("$label")
  fail=$((fail + 1))
}

# Compare stdout, stderr and exit code. The programs print only Node-shaped messages, so a
# stderr mismatch is a real message-shape divergence.
compare() {
  local label="$1"
  shift
  (cd "$work" && "$node_bin" "$@") >"$work/n.out" 2>"$work/n.err"
  local ncode=$?
  (cd "$work" && "$lite" "$@") >"$work/l.out" 2>"$work/l.err"
  local lcode=$?

  if [ "$ncode" -eq "$lcode" ] && cmp -s "$work/n.out" "$work/l.out" && cmp -s "$work/n.err" "$work/l.err"; then
    echo "ok        $label"
    pass=$((pass + 1))
  else
    show "$label (node exit $ncode, lite exit $lcode)" "$work/n.err" "$work/l.err"
    diff -u "$work/n.out" "$work/l.out" 2>/dev/null | head -20 | sed 's/^/          /'
  fi
}

manifest() (
  cd "$1" || return 1
  find . -type f | LC_ALL=C sort | while IFS= read -r file; do
    printf 'file %s %s\n' "$(cksum <"$file" | awk '{print $1}')" "$file"
  done
  find . -type l | LC_ALL=C sort | while IFS= read -r link; do
    printf 'link %s -> %s\n' "$link" "$(readlink "$link")"
  done
)

# --- cat -------------------------------------------------------------------------------------
compare "cat: one file" "$here/cat.js" src/a.txt
compare "cat: several files, including empty and large" "$here/cat.js" src/a.txt src/empty.txt src/big.txt
compare "cat: nested path" "$here/cat.js" src/sub/b.txt src/sub/deep/c.txt
compare "cat: missing file reports Node's message" "$here/cat.js" src/does-not-exist.txt

printf 'from stdin\nsecond line\n' >"$work/stdin.txt"
(cd "$work" && "$node_bin" "$here/cat.js" <stdin.txt) >"$work/n.out" 2>"$work/n.err"
ncode=$?
(cd "$work" && "$lite" "$here/cat.js" <stdin.txt) >"$work/l.out" 2>"$work/l.err"
lcode=$?
if [ "$ncode" -eq "$lcode" ] && cmp -s "$work/n.out" "$work/l.out"; then
  echo "ok        cat: stdin"
  pass=$((pass + 1))
else
  show "cat: stdin (node exit $ncode, lite exit $lcode)" "$work/n.err" "$work/l.err"
fi

# --- wc --------------------------------------------------------------------------------------
compare "wc: default line/word/byte counts" "$here/wc.js" src/a.txt src/sub/b.txt
compare "wc: -l" "$here/wc.js" -l src/a.txt src/sub/deep/c.txt
compare "wc: -c on the large file" "$here/wc.js" -c src/big.txt
compare "wc: empty file" "$here/wc.js" src/empty.txt

# --- cp --------------------------------------------------------------------------------------
rm -rf "$work/out-node" "$work/out-lite"
(cd "$work" && "$node_bin" "$here/cp.js" -r src out-node) >"$work/n.out" 2>"$work/n.err"
ncode=$?
(cd "$work" && "$lite" "$here/cp.js" -r src out-lite) >"$work/l.out" 2>"$work/l.err"
lcode=$?
manifest "$work/out-node" >"$work/n.manifest"
manifest "$work/out-lite" >"$work/l.manifest"
if [ "$ncode" -eq "$lcode" ] && cmp -s "$work/n.manifest" "$work/l.manifest"; then
  echo "ok        cp -r: tree, contents and symlinks"
  pass=$((pass + 1))
else
  show "cp -r (node exit $ncode, lite exit $lcode)" "$work/n.err" "$work/l.err"
  diff -u "$work/n.manifest" "$work/l.manifest" 2>/dev/null | head -20 | sed 's/^/          /'
fi

compare "cp: file without -r" "$here/cp.js" src/a.txt single-copy.txt

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failing: %s\n' "${failures[@]}" >&2
  exit 1
fi
