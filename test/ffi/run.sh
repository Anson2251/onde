#!/usr/bin/env bash
# The FFI suite (docs/ffi-plan.md §11): the C fixture, the layout oracle, the JavaScript matrix,
# the build-feature gate and the `ffi.load` permission gate.
#
#   ./test/ffi/run.sh
#   ONDE=target/release/onde ./test/ffi/run.sh
#   FFI_FEATURE_CHECK=0 ./test/ffi/run.sh     # skip the --no-default-features build
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
run_case() {
  local name="$1"
  shift
  if "$@"; then
    note "ok        $name"
  else
    note "FAIL      $name"
    fail=1
  fi
}

# --- fixtures ---------------------------------------------------------------------------------

case "$(uname -s)" in
  Darwin) lib="$work/libffi-fixture.dylib" ;;
  *) lib="$work/libffi-fixture.so" ;;
esac

if ! cc -shared -fPIC -O2 -pthread -o "$lib" "$here/fixture/fixture.c"; then
  echo "cannot build the C fixture (a C compiler is required)" >&2
  exit 2
fi
if ! cc -o "$work/layout" "$here/layout.c" "$here/fixture/fixture.c"; then
  echo "cannot build the layout oracle" >&2
  exit 2
fi
"$work/layout" > "$work/oracle.txt" || { echo "the layout oracle failed" >&2; exit 2; }

export ONDE_FFI_FIXTURE="$lib"
export ONDE_FFI_ORACLE="$work/oracle.txt"

# --- the JavaScript matrix --------------------------------------------------------------------

for case_file in inference call struct callback memory json sqlite; do
  run_case "$case_file.test.js" "$onde" "$here/$case_file.test.js"
done

# --- the namespace ----------------------------------------------------------------------------
#
# `onde:ffi` is an extension namespace, not a Node builtin: a bare `ffi` must fall through to
# node_modules, and `module.builtinModules` must not list the extension.
bare="$("$onde" -e '
try { require("ffi"); console.log("resolved"); }
catch (error) { console.log(error.code); }' 2>&1)"
if [ "$bare" = "MODULE_NOT_FOUND" ]; then
  note "ok        bare ffi does not resolve"
else
  note "FAIL      bare ffi was: $bare"
  fail=1
fi

listed="$("$onde" -e '
const names = require("module").builtinModules;
console.log(names.includes("ffi") || names.includes("onde:ffi") ? "listed" : "unlisted");
console.log(require.resolve("onde:ffi"));' 2>&1)"
if [ "$listed" = "unlisted
onde:ffi" ]; then
  note "ok        module.builtinModules omits the extension"
else
  note "FAIL      builtinModules/resolve was: $listed"
  fail=1
fi

# --- the build-feature gate -------------------------------------------------------------------
#
# A binary built without `ffi` must not merely disable the module: the name must not resolve, so
# no script can talk it into loading a library. CI passes `ONDE_FEATURE_OFF` from the build stage;
# a developer run builds it here.
if [ "${FFI_FEATURE_CHECK:-1}" = "1" ]; then
  off=""
  if [ -n "${ONDE_FEATURE_OFF:-}" ]; then
    off="$ONDE_FEATURE_OFF"
    if [ ! -x "$off" ]; then
      note "FAIL      ONDE_FEATURE_OFF is not executable: $off"
      fail=1
      off=""
    fi
  else
    off_dir="$root/target/ffi-off"
    if cargo build -q -p ln-cli --no-default-features --target-dir "$off_dir"; then
      off="$off_dir/debug/onde"
    else
      note "FAIL      cargo build --no-default-features"
      fail=1
    fi
  fi

  if [ -n "$off" ]; then
    out="$("$off" -e 'try { require("onde:ffi"); console.log("loaded"); } catch (error) { console.log(error.code); }' 2>&1)"
    if [ "$out" = "ERR_UNKNOWN_BUILTIN_MODULE" ]; then
      note "ok        a feature-off build has no onde:ffi"
    else
      note "FAIL      a feature-off build resolved onde:ffi: $out"
      fail=1
    fi
    # The node: namespace must never reach the extension, and a bare name must not either.
    out="$("$off" -e 'try { require("node:ffi"); } catch (error) { console.log(error.code); }' 2>&1)"
    if [ "$out" = "ERR_UNKNOWN_BUILTIN_MODULE" ]; then
      note "ok        node:ffi is not a namespace we claim"
    else
      note "FAIL      node:ffi resolved unexpectedly: $out"
      fail=1
    fi
  fi
fi

# --- the permission gate ----------------------------------------------------------------------
#
# `ffi.load` is the single runtime gate (ADR-0011); the build feature is the structural one.
denied="$("$onde" --permission -e '
try {
  const { dlopen, libcName } = require("onde:ffi");
  dlopen(libcName);
  console.log("allowed");
} catch (error) {
  console.log(error.code + " " + error.capability);
}' 2>&1)"
if [ "$denied" = "ERR_ACCESS_DENIED ffi.load" ]; then
  note "ok        --permission denies ffi.load"
else
  note "FAIL      --permission denial was: $denied"
  fail=1
fi

granted="$("$onde" --permission --allow-ffi -e '
const { dlopen, libcName } = require("onde:ffi");
const lib = dlopen(libcName);
lib.close();
console.log("granted");' 2>&1)"
if [ "$granted" = "granted" ]; then
  note "ok        --allow-ffi grants ffi.load"
else
  note "FAIL      --allow-ffi grant was: $granted"
  fail=1
fi

# --- the inventory ----------------------------------------------------------------------------
#
# The permission suite classifies `__ln_host`; `ffi` must be in its known set or that suite fails
# on its own, so this is a local early warning rather than a duplicate check.
inventory="$("$onde" "$root/test/perm/cases/inventory.js" 2>&1)"
if printf '%s' "$inventory" | grep -q "inventory ok"; then
  note "ok        host inventory classifies ffi"
else
  note "FAIL      host inventory: $inventory"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "ffi suite failed" >&2
  exit 1
fi
echo "ffi suite passed"
