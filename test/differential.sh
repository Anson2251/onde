#!/usr/bin/env bash
# Differential harness: run every conformance case under `node` and under `lite` and compare
# ordered stdout plus the exit code. Unlike the recorded `.expected` files this needs no
# regeneration, so it also catches an expectation that drifted from Node.
#
#   ./test/differential.sh
#   LITE=/path/to/lite ./test/differential.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIFF=1 RUN="${LITE:-$here/../target/debug/lite}" "$here/conformance/run.sh"
