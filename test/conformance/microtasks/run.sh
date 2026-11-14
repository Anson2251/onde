#!/usr/bin/env bash
# Thin compatibility wrapper around the generic conformance runner.
#
#   ./run.sh            # compare lite against the recorded microtask expectations
#   RUN=node ./run.sh   # verify the expectations still describe Node
#   REGEN=1 RUN=node ./run.sh

set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITES=microtasks "$here/../run.sh" "$@"
