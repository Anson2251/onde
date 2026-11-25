#!/usr/bin/env bash
# Release footprint of the optional features, measured as an increment on the minimal build.
#
#   ./test/features/size.sh
#
# The ladder starts at `--no-default-features` and adds one flag at a time, so every row reads
# "the binary grew by X when this module came back". `node-tls` implies `node-net`, which is why
# net comes first. The last row is the full build.
#
# Sizes are the `onde` binary only. Run this on an otherwise idle machine: release builds are
# LTO-linked and the numbers are byte-exact, so they should not move between runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

binary="$root/target/release/onde"
results="$(mktemp)"
trap 'rm -f "$results"' EXIT

previous=""
build() { # label, feature list (comma-separated, empty for the minimal build)
  local label="$1" features="$2"
  local args=(-q --release -p ln-cli --no-default-features)
  if [ -n "$features" ]; then
    args+=(--features "$features")
  fi
  echo "== $label: cargo build ${args[*]}" >&2
  cargo build "${args[@]}" >&2
  local size
  size="$(wc -c <"$binary" | tr -d ' ')"
  printf '%s %s %s\n' "$label" "${features:--}" "$size" >>"$results"
}

size_of() { awk -v name="$1" '$1 == name { print $3 }' "$results"; }
mib() { awk -v bytes="$1" 'BEGIN { printf "%.2f", bytes / 1048576 }'; }
delta() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%d", a - b }'; }
human() { # bytes -> the unit a reader expects (KB below 1 MB, else MB)
  awk -v bytes="$1" 'BEGIN {
    if (bytes >= 1048576) printf "%.1f MB", bytes / 1000000;
    else printf "%.0f KB", bytes / 1000;
  }'
}

# Cumulative, cheapest first and with `net` before `tls` (tls implies net).
build "minimal" ""
build "+crypto" "node-crypto"
build "+net" "node-crypto,node-net"
build "+tls" "node-crypto,node-net,node-tls"
build "+sqlite" "node-crypto,node-net,node-tls,node-sqlite"
build "+zlib" "node-crypto,node-net,node-tls,node-sqlite,node-zlib"

printf '\n%-10s %-46s %10s %10s\n' "build" "features" "MiB" "increment"
for label in minimal +crypto +net +tls +sqlite +zlib; do
  features="$(awk -v name="$label" '$1 == name { print $2 }' "$results")"
  bytes="$(size_of "$label")"
  if [ -z "$previous" ]; then
    increment="-"
  else
    step="$(delta "$bytes" "$previous")"
    increment="+$(human "$step")"
  fi
  printf '%-10s %-46s %10s %10s\n' "$label" "$features" "$(mib "$bytes")" "$increment"
  previous="$bytes"
done
echo
