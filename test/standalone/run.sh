#!/usr/bin/env bash
# Standalone builds: the runtime archive plus the build tool, end to end.
#
# The acceptance criterion is the feature's whole promise: `ondec build` produces an executable
# that runs after the project directory *and* the SDK it was built against are deleted. The test
# binary links the archive and executes the result, so a broken payload format, a stale ABI stamp
# or a bad link line all fail here.
#
# Cost: one release build of the static library (the same artifact the SDK ships), a few seconds
# per test. That is why it is a script and not part of `cargo test --all`, which stays fast.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== building the runtime archive (release, the profile the SDK ships)"
cargo build --release -p ln-embed

echo "== standalone end-to-end: build, delete the sources, run"
ONDE_E2E_ARCHIVE="${PWD}/target/release/libonde.a" \
    cargo test -p ondec --test e2e -- --nocapture
