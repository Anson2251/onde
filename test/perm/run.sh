#!/usr/bin/env bash
# The permission suite: the CLI surface, the host inventory, the deny-all sweep and the race.
#
#   ./test/perm/run.sh
#   ONDE=target/release/onde ./test/perm/run.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-$root/target/debug/onde}"

if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi

export ONDE="$onde"
fail=0

echo "== CLI matrix"
"$here/cli.sh" || fail=1

echo
echo "== host inventory"
"$onde" "$here/cases/inventory.js" || fail=1

echo
echo "== deny-all sweep"
"$here/deny-all.sh" || fail=1

echo
echo "== symlink race"
work="$(mktemp -d)"
outside="$(mktemp -d)"
trap 'rm -rf "$work" "$outside"' EXIT
printf 'SAFE' > "$work/safe"
printf 'SECRET-CONTENT' > "$outside/secret"
if timeout -k 2 20 "$onde" --permission \
    --allow-fs-read="$work" --allow-fs-write="$work" \
    "$here/race.js" "$work/safe" "$outside/secret"; then
  :
else
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "permission suite failed" >&2
  exit 1
fi
echo "permission suite passed"
