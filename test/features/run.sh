#!/usr/bin/env bash
# Feature-flag acceptance: `node-sqlite` and `node-zlib` are default features; a build can leave
# them out, and requiring a module that was left out must name the missing feature.
#
#   ./test/features/run.sh
#
# The script builds four variants in the normal target directory and restores the default build on
# exit, so a CI step can run it between the other lite jobs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lite="$root/target/debug/lite"

restore() {
  cargo build -q -p ln-cli >/dev/null 2>&1 || true
}
trap restore EXIT

build() {
  echo "== cargo build -p ln-cli $*"
  cargo build -q -p ln-cli "$@"
}

loads() { # specifier
  "$lite" -e "const m = require('$1'); console.log(typeof (m.Database || m.gzipSync))" | grep -qx function
}

fails_with_feature() { # specifier, feature
  local specifier="$1" feature="$2" out
  out="$("$lite" -e "
    try { require('$specifier'); console.log('loaded'); }
    catch (error) { console.log(error.code); console.log(error.message); }
  ")"
  if ! grep -q "ERR_UNKNOWN_BUILTIN_MODULE" <<<"$out"; then
    echo "FAIL: $specifier did not fail with ERR_UNKNOWN_BUILTIN_MODULE" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  if ! grep -Fq "node:${specifier#node:} is not available: the \`$feature\` feature is not enabled in this build" <<<"$out"; then
    echo "FAIL: $specifier message does not name $feature" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  if ! grep -Fq -- "--features $feature" <<<"$out"; then
    echo "FAIL: $specifier message does not show how to include the feature" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
}

esm_fails_with_feature() { # specifier, feature
  local specifier="$1" feature="$2" directory file out
  directory="$(mktemp -d)"
  file="$directory/probe.mjs"
  printf 'try { await import("%s"); } catch (error) { console.log(error.code); console.log(error.message); }\n' "$specifier" >"$file"
  out="$("$lite" "$file")"
  rm -rf "$directory"
  grep -q "ERR_UNKNOWN_BUILTIN_MODULE" <<<"$out"
  grep -Fq "\`$feature\` feature is not enabled in this build" <<<"$out"
}

has_dependency() { # crate-name, cargo tree args...
  local dependency="$1"
  shift
  cargo tree -p ln-runtime --edges normal "$@" 2>/dev/null | grep -q " ${dependency} v"
}

builtin_table() {
  "$lite" -e '
    const module = require("module");
    console.log(
      module.builtinModules.includes("sqlite"),
      module.builtinModules.includes("zlib"),
      module.isBuiltin("node:sqlite"),
      module.isBuiltin("node:zlib"),
    );
  '
}

# ------------------------------------------------------------------------------------------------
# Both default features: the normal build.
# ------------------------------------------------------------------------------------------------
build
"$lite" -e 'console.log(1 + 1)' | grep -qx 2
loads node:sqlite
loads node:zlib
[ "$(builtin_table)" = "false true true true" ] || {
  echo "FAIL: default builtin table is $(builtin_table)" >&2
  exit 1
}
has_dependency ln-zlib
has_dependency libsqlite3-sys
echo "ok        default build has both modules"

# ------------------------------------------------------------------------------------------------
# No features: both modules report the missing feature, CJS and ESM.
# ------------------------------------------------------------------------------------------------
build --no-default-features
"$lite" -e 'console.log(1 + 1)' | grep -qx 2
fails_with_feature node:sqlite node-sqlite
fails_with_feature node:zlib node-zlib
esm_fails_with_feature node:sqlite node-sqlite
esm_fails_with_feature node:zlib node-zlib
[ "$(builtin_table)" = "false false false false" ] || {
  echo "FAIL: no-feature builtin table is $(builtin_table)" >&2
  exit 1
}
if has_dependency ln-zlib --no-default-features || has_dependency libsqlite3-sys --no-default-features; then
  echo "FAIL: a no-feature lite still links zlib or SQLite" >&2
  exit 1
fi
echo "ok        no features: readable errors for both modules, no zlib/SQLite linked"

# ------------------------------------------------------------------------------------------------
# One feature at a time.
# ------------------------------------------------------------------------------------------------
build --no-default-features --features node-sqlite
loads node:sqlite
fails_with_feature node:zlib node-zlib
[ "$(builtin_table)" = "false false true false" ] || {
  echo "FAIL: node-sqlite-only builtin table is $(builtin_table)" >&2
  exit 1
}
has_dependency libsqlite3-sys --no-default-features --features node-sqlite
if has_dependency ln-zlib --no-default-features --features node-sqlite; then
  echo "FAIL: a lite with only node-sqlite still links zlib" >&2
  exit 1
fi
echo "ok        node-sqlite only"

build --no-default-features --features node-zlib
loads node:zlib
fails_with_feature node:sqlite node-sqlite
[ "$(builtin_table)" = "false true false true" ] || {
  echo "FAIL: node-zlib-only builtin table is $(builtin_table)" >&2
  exit 1
}
has_dependency ln-zlib --no-default-features --features node-zlib
if has_dependency libsqlite3-sys --no-default-features --features node-zlib; then
  echo "FAIL: a lite with only node-zlib still links SQLite" >&2
  exit 1
fi
echo "ok        node-zlib only"

# Restore the default build before the script exits (the trap covers failures too).
restore
loads node:sqlite
loads node:zlib
echo "ok        default build restored"
