#!/usr/bin/env bash
# Build the SDK for this machine.
#
# The SDK is two files plus release metadata, in the layout `ondec` expects:
#
#   dist/sdk/<version>/<tuple>/onde.h
#                              /libonde-<tuple>.a
#                              /SHA256SUMS
#
# `ondec build app.js --sdk dist/sdk/<version>/<tuple>` then needs no network. The release job runs
# the same steps per cell (with the right `--target` and compiler); this script is the host cell,
# for development and for anyone who wants a local SDK without a published release.
#
# The archive is named after the host tuple, which `ondec sdk path` already computes — asking the
# tool keeps the mapping in one place instead of duplicating it in shell.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/^version = "\(.*\)"/\1/p' crates/ondec/Cargo.toml | head -1)
: "${version:?cannot read the version from crates/ondec/Cargo.toml}"

echo "== building libonde.a (release, the profile the SDK ships)"
cargo build --release -p ln-embed

tuple=$(target/release/ondec sdk path | xargs basename)
out="dist/sdk/$version/$tuple"
rm -rf "$out"
mkdir -p "$out"

cp crates/ln-embed/include/onde.h "$out/onde.h"
cp target/release/libonde.a "$out/libonde-$tuple.a"

# The checksum file is release metadata, not part of the SDK; `ondec sdk install` verifies it after
# a download, and a local build should have one too so the two paths look alike.
if command -v shasum >/dev/null 2>&1; then
    (cd "$out" && shasum -a 256 onde.h "libonde-$tuple.a" > SHA256SUMS)
else
    (cd "$out" && sha256sum onde.h "libonde-$tuple.a" > SHA256SUMS)
fi

echo "== verifying the archive's engine identity"
target/release/ondec sdk verify --sdk "$out"

echo
echo "SDK ready: $out"
echo "  ondec build app.js --sdk $out -o app"
