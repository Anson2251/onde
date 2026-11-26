#!/usr/bin/env bash
# The deny-all sweep: every existing fs/net/child_process/workers/sqlite conformance case runs
# under `--permission` with no grants. A case must either be pure computation (exit 0, recorded as
# `pass`) or fail with ERR_ACCESS_DENIED (`denied`); any other failure is a bypass or a broken gate.
#
#   ./test/perm/deny-all.sh              # compare against deny-all.expected
#   REGEN=1 ./test/perm/deny-all.sh      # re-record the manifest (review the diff)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-$root/target/debug/onde}"
manifest="$here/deny-all.expected"
suites="${SUITES:-fs net child_process workers sqlite}"

if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "timeout not found: install GNU coreutils and put it on PATH" >&2
  exit 2
fi

actual="$(mktemp)"
trap 'rm -f "$actual"' EXIT

cd "$root" || exit 2
for suite in $suites; do
  dir="test/conformance/$suite"
  [ -d "$dir" ] || continue
  for src in "$dir"/*.js "$dir"/*.cjs "$dir"/*.mjs; do
    [ -e "$src" ] || continue
    base="$(basename "$src")"
    name="$suite/${base%.*}"
    out="$(timeout -k 2 20 "$onde" --permission "$src" 2>&1)"
    code=$?
    # Classify by the denial first: a case that catches ERR_ACCESS_DENIED and exits 0 still
    # exercised a gate, and calling that a `pass` would hide it.
    if printf '%s' "$out" | grep -q "ERR_ACCESS_DENIED"; then
      echo "$name denied" >>"$actual"
    elif [ "$code" -eq 0 ]; then
      echo "$name pass" >>"$actual"
    else
      echo "$name unexpected($code)" >>"$actual"
    fi
  done
done

if [ "${REGEN:-0}" = "1" ]; then
  cp "$actual" "$manifest"
  echo "recorded $(wc -l < "$manifest" | tr -d ' ') cases in $manifest"
  exit 0
fi

if [ ! -f "$manifest" ]; then
  echo "no manifest at $manifest; run with REGEN=1" >&2
  exit 2
fi
if diff -u "$manifest" "$actual" >/dev/null 2>&1; then
  echo "deny-all sweep: $(wc -l < "$actual" | tr -d ' ') cases match the manifest"
  exit 0
fi

echo "deny-all sweep changed:" >&2
diff -u "$manifest" "$actual" | sed 's/^/          /' >&2
exit 1
