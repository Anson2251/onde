#!/usr/bin/env bash
# Feature-flag acceptance: `node-net`, `node-tls`, `node-crypto`, `node-sqlite` and `node-zlib`
# are default features; a build can leave any of them out, and requiring a module that was left
# out must name the missing feature. `node-tls` implies `node-net`.
#
#   ./test/features/run.sh
#
# The script builds the matrix in the normal target directory and restores the default build on
# exit, so a CI step can run it between the other onde jobs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="$root/target/debug/onde"

restore() {
  cargo build -q -p ln-cli >/dev/null 2>&1 || true
}
trap restore EXIT

build() {
  echo "== cargo build -p ln-cli $*"
  cargo build -q -p ln-cli "$@"
}

loads() { # specifier, marker property exported by the module
  "$onde" -e "const m = require('$1'); console.log(typeof m.$2)" | grep -qx function
}

fails_with_feature() { # specifier, feature
  local specifier="$1" feature="$2" out
  out="$("$onde" -e "
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
  out="$("$onde" "$file")"
  rm -rf "$directory"
  grep -q "ERR_UNKNOWN_BUILTIN_MODULE" <<<"$out"
  grep -Fq "\`$feature\` feature is not enabled in this build" <<<"$out"
}

constants_survives() { # the deprecated grab bag must load with the crypto module gone
  "$onde" -e '
    const constants = require("constants");
    console.log(typeof constants, Object.keys(constants).length > 0);
  ' | grep -qx "object true"
}

has_dependency() { # crate-name, cargo tree args...
  local dependency="$1"
  shift
  cargo tree -p ln-runtime --edges normal "$@" 2>/dev/null | grep -q " ${dependency} v"
}

builtin_table() {
  "$onde" -e '
    const module = require("module");
    const names = ["net", "http", "https", "tls", "dns", "crypto", "sqlite", "zlib"];
    console.log(names.map((name) => module.isBuiltin("node:" + name)).join(" "));
  '
}

expect_table() { # expected line, label
  local actual
  actual="$(builtin_table)"
  if [ "$actual" != "$1" ]; then
    echo "FAIL: $2 builtin table is '$actual', expected '$1'" >&2
    exit 1
  fi
}

# The table order: net http https tls dns crypto sqlite zlib.
ALL="true true true true true true true true"
NONE_OF_THEM="false false false false false false false false"
NET_ONLY="true true false false true false false false"
NET_AND_TLS="true true true true true false false false"
CRYPTO_ONLY="false false false false false true false false"

loads_all() {
  loads node:net createServer
  loads node:http createServer
  loads node:https createServer
  loads node:tls connect
  loads node:dns lookup
  loads node:crypto createHash
  loads node:sqlite Database
  loads node:zlib gzipSync
}

fails_net_tls_crypto() {
  fails_with_feature node:net node-net
  fails_with_feature node:http node-net
  fails_with_feature node:dns node-net
  fails_with_feature node:tls node-tls
  fails_with_feature node:https node-tls
  fails_with_feature node:crypto node-crypto
}

# ------------------------------------------------------------------------------------------------
# All features: the normal build.
# ------------------------------------------------------------------------------------------------
build
"$onde" -e 'console.log(1 + 1)' | grep -qx 2
loads_all
expect_table "$ALL" "default"
has_dependency ln-zlib
has_dependency libsqlite3-sys
has_dependency ln-http
has_dependency rustls
has_dependency ln-crypto
echo "ok        default build has every module"

# ------------------------------------------------------------------------------------------------
# No features: every module reports the missing feature, CJS and ESM.
# ------------------------------------------------------------------------------------------------
build --no-default-features
"$onde" -e 'console.log(1 + 1)' | grep -qx 2
fails_net_tls_crypto
fails_with_feature node:sqlite node-sqlite
fails_with_feature node:zlib node-zlib
# The bare specifiers resolve to the same builtins (except sqlite, which is node:-only).
fails_with_feature net node-net
fails_with_feature crypto node-crypto
constants_survives
esm_fails_with_feature node:net node-net
esm_fails_with_feature node:crypto node-crypto
esm_fails_with_feature node:sqlite node-sqlite
expect_table "$NONE_OF_THEM" "no-feature"
if has_dependency ln-zlib --no-default-features \
  || has_dependency libsqlite3-sys --no-default-features \
  || has_dependency ln-http --no-default-features \
  || has_dependency rustls --no-default-features \
  || has_dependency ln-crypto --no-default-features; then
  echo "FAIL: a no-feature onde still links an optional module dependency" >&2
  exit 1
fi
echo "ok        no features: readable errors, no optional dependencies linked"

# ------------------------------------------------------------------------------------------------
# Network only: sockets and HTTP/1.1, no rustls, no TLS module.
# ------------------------------------------------------------------------------------------------
build --no-default-features --features node-net
loads node:net createServer
loads node:http createServer
loads node:dns lookup
fails_with_feature node:tls node-tls
fails_with_feature node:https node-tls
fails_with_feature node:crypto node-crypto
expect_table "$NET_ONLY" "node-net-only"
has_dependency ln-http --no-default-features --features node-net
if has_dependency rustls --no-default-features --features node-net; then
  echo "FAIL: an onde with only node-net still links rustls" >&2
  exit 1
fi
if has_dependency ln-crypto --no-default-features --features node-net; then
  echo "FAIL: an onde with only node-net still links ln-crypto" >&2
  exit 1
fi
echo "ok        node-net only: sockets and http, no tls, no rustls"

# ------------------------------------------------------------------------------------------------
# TLS: implies net, so every socket module plus tls/https is present.
# ------------------------------------------------------------------------------------------------
build --no-default-features --features node-tls
loads node:net createServer
loads node:http createServer
loads node:tls connect
loads node:https createServer
loads node:dns lookup
fails_with_feature node:crypto node-crypto
expect_table "$NET_AND_TLS" "node-tls-only"
has_dependency rustls --no-default-features --features node-tls
has_dependency ln-http --no-default-features --features node-tls
if has_dependency ln-crypto --no-default-features --features node-tls; then
  echo "FAIL: an onde with only node-tls still links ln-crypto" >&2
  exit 1
fi
echo "ok        node-tls only: tls implies net, rustls linked"

# ------------------------------------------------------------------------------------------------
# Crypto alone: the module is independent of the network flags.
# ------------------------------------------------------------------------------------------------
build --no-default-features --features node-crypto
loads node:crypto createHash
constants_survives
if has_dependency rustls --no-default-features --features node-crypto \
  || has_dependency ln-http --no-default-features --features node-crypto; then
  echo "FAIL: an onde with only node-crypto still links the network stack" >&2
  exit 1
fi
expect_table "$CRYPTO_ONLY" "node-crypto-only"
echo "ok        node-crypto only: crypto without any socket code"

# ------------------------------------------------------------------------------------------------
# Standalone modules keep their own flags.
# ------------------------------------------------------------------------------------------------
build --no-default-features --features node-sqlite
loads node:sqlite Database
fails_with_feature node:zlib node-zlib
fails_with_feature node:net node-net
has_dependency libsqlite3-sys --no-default-features --features node-sqlite
if has_dependency ln-zlib --no-default-features --features node-sqlite; then
  echo "FAIL: an onde with only node-sqlite still links zlib" >&2
  exit 1
fi
echo "ok        node-sqlite only"

build --no-default-features --features node-zlib
loads node:zlib gzipSync
fails_with_feature node:sqlite node-sqlite
fails_with_feature node:net node-net
has_dependency ln-zlib --no-default-features --features node-zlib
if has_dependency libsqlite3-sys --no-default-features --features node-zlib; then
  echo "FAIL: an onde with only node-zlib still links SQLite" >&2
  exit 1
fi
echo "ok        node-zlib only"

# Restore the default build before the script exits (the trap covers failures too).
restore
loads_all
echo "ok        default build restored"
