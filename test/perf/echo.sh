#!/usr/bin/env bash
# One TCP echo run: <runtime> serves test/net/fixtures/echo-server.js, node drives the client.
#
#   ./test/perf/echo.sh target/release/lite
#   ./test/perf/echo.sh "$(command -v node)"
#
# Prints one RESULT line. test/perf/run.sh runs it twice and compares, so both sides use the same
# client and the same fixture; only the server runtime differs.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
runtime="${1:-$root/target/release/lite}"
connections="${PERF_ECHO_CONNECTIONS:-20}"
rounds="${PERF_ECHO_ROUNDS:-200}"
payload="${PERF_ECHO_PAYLOAD:-1024}"

# shellcheck source=../net/lib.sh
. "$here/../net/lib.sh"

if ! command -v "$runtime" >/dev/null 2>&1 && [ ! -x "$runtime" ]; then
  echo "echo: no runtime at '$runtime'" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "echo: node is required for the client" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-echo.XXXXXX")"
server_pid=""

cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && wait "$server_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$runtime" "$here/../net/fixtures/echo-server.js" "$tmp/port" >"$tmp/server.log" 2>&1 &
server_pid=$!

i=0
while [ ! -s "$tmp/port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 500 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    echo "echo: server failed to start" >&2
    sed 's/^/  /' "$tmp/server.log" 2>/dev/null || true
    exit 2
  fi
  sleep 0.01
done

port="$(cat "$tmp/port")"
result="$(node "$here/echo.js" "$port" "$connections" "$rounds" "$payload")"
code=$?
if [ "$code" -ne 0 ]; then
  echo "echo: client failed" >&2
  printf '%s\n' "$result" | sed 's/^/  /' >&2
  sed 's/^/  /' "$tmp/server.log" >&2
  exit 1
fi

printf 'RESULT runtime=%s %s\n' "$(basename "$runtime")" "${result#RESULT }"
