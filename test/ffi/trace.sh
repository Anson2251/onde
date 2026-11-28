#!/usr/bin/env bash
# The FFI crash trace (`--trace-ffi`, `ONDE_FFI_TRACE`).
#
# A crash inside C cannot be caught, so the last trace line before the fault is the only record
# of which call was in flight. These assertions pin the events, the JavaScript frame, the layout
# dump and the flag/env precedence. Run alone, or through the suite entry:
#
#   ./test/ffi/trace.sh
#   ONDE=target/release/onde ./test/ffi/trace.sh
#   ONDE_FFI_FIXTURE=/path/to/libffi-fixture.dylib ./test/ffi/trace.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-$root/target/debug/onde}"

if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail=0
note() { printf '%s\n' "$*"; }

# `run.sh` exports its fixture; a standalone run builds its own.
if [ -z "${ONDE_FFI_FIXTURE:-}" ]; then
  case "$(uname -s)" in
    Darwin) lib="$work/libffi-fixture.dylib" ;;
    *) lib="$work/libffi-fixture.so" ;;
  esac
  if ! cc -shared -fPIC -O2 -pthread -o "$lib" "$here/fixture/fixture.c"; then
    echo "cannot build the C fixture (a C compiler is required)" >&2
    exit 2
  fi
  export ONDE_FFI_FIXTURE="$lib"
fi

trace_err="$work/trace.err"
trace_out="$work/trace.out"
if "$onde" --trace-ffi=full "$here/trace.js" >"$trace_out" 2>"$trace_err"; then
  trace_has() {
    local pattern="$1" label="$2"
    if grep -Eq "$pattern" "$trace_err"; then
      note "ok        trace: $label"
    else
      note "FAIL      trace: $label"
      sed 's/^/          /' "$trace_err"
      fail=1
    fi
  }
  trace_has '^\[ffi\] open .*libffi-fixture\.(dylib|so)$' "open"
  trace_has '^\[ffi\] declare .*fixture_add_i32\(i32, i32\) -> i32$' "declare"
  trace_has '^\[ffi\] image .* base=0x[0-9a-f]+$' "image base"
  trace_has '^\[ffi\] struct TracePoint bytes=16 align=8 x:i32@0, y:f64@8$' "struct layout"
  trace_has '^\[ffi\] call .*fixture_add_i32\(i32=2, i32=3\) at .*trace\.js:[0-9]+:[0-9]+$' "declared call site"
  trace_has '^\[ffi\] call .*fixture_add_i32\(i32=4, i32=5\) at .*trace\.js:[0-9]+:[0-9]+$' "plan call site"
  trace_has '^\[ffi\] call .*fixture_add_i32\(i32=6, i32=7\) at .*trace\.js:[0-9]+:[0-9]+$' "inferred call site"
  trace_has '^\[ffi\] close ' "close"
  if [ "$(grep -c '^\[ffi\] call ' "$trace_err")" = "3" ]; then
    note "ok        trace: one line per call"
  else
    note "FAIL      trace: one line per call"
    fail=1
  fi
  if grep -Eq '^\[ffi\]' "$trace_out"; then
    note "FAIL      trace: log leaked to stdout"
    fail=1
  else
    note "ok        trace: stderr only"
  fi
else
  note "FAIL      trace: the fixture run exited nonzero"
  fail=1
fi

summary_err="$work/trace-summary.err"
if "$onde" --trace-ffi "$here/trace.js" >/dev/null 2>"$summary_err"; then
  if grep -Eq '^\[ffi\] call ' "$summary_err"; then
    note "ok        trace: bare --trace-ffi logs calls"
  else
    note "FAIL      trace: bare --trace-ffi logged no call"
    fail=1
  fi
  if grep -Eq '^\[ffi\] struct ' "$summary_err"; then
    note "FAIL      trace: summary printed a layout"
    fail=1
  else
    note "ok        trace: summary omits layouts"
  fi
else
  note "FAIL      trace: summary run exited nonzero"
  fail=1
fi

env_err="$work/trace-env.err"
if ONDE_FFI_TRACE=1 "$onde" "$here/trace.js" >/dev/null 2>"$env_err"; then
  if grep -Eq '^\[ffi\] call ' "$env_err"; then
    note "ok        trace: ONDE_FFI_TRACE works for a plain run"
  else
    note "FAIL      trace: ONDE_FFI_TRACE logged no call"
    fail=1
  fi
else
  note "FAIL      trace: ONDE_FFI_TRACE run exited nonzero"
  fail=1
fi

flag_err="$work/trace-flag.err"
if ONDE_FFI_TRACE=full "$onde" --trace-ffi "$here/trace.js" >/dev/null 2>"$flag_err"; then
  if grep -Eq '^\[ffi\] struct ' "$flag_err"; then
    note "FAIL      trace: the flag did not override ONDE_FFI_TRACE=full"
    fail=1
  else
    note "ok        trace: the flag wins over the environment"
  fi
else
  note "FAIL      trace: flag/env run exited nonzero"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "ffi trace failed" >&2
  exit 1
fi
echo "ffi trace passed"
