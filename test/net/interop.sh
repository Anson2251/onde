#!/usr/bin/env bash
# Interop matrix for the M4 network surface.
#
#   ./test/net/interop.sh
#   LITE=/path/to/lite ./test/net/interop.sh
#
# Four plaintext legs: lite server + curl, lite server + node client, node server + lite client,
# lite server + lite client. Every leg asserts the status line, a custom header with mixed case,
# the client's rawHeaders case, the body, keep-alive reuse (two requests on one connection,
# observed through a per-socket counter) and a chunked response. The client's exit code is part of
# the contract.
#
# If the runtime under test can serve TLS (`test/fixtures/tls`), three TLS legs are added: lite
# TLS server + node https client, node TLS server + lite https client, lite TLS server + curl.
# When TLS is not available yet the script prints one skip line and still exits 0.
#
# Ports are always :0 and travel through a temp file; nothing port-specific is printed.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
LITE="${LITE:-$root/target/debug/lite}"
server_js="$here/fixtures/interop-server.js"
client_js="$here/fixtures/http-client.js"
probe_js="$here/fixtures/tls-probe.js"
tls_dir="$root/test/fixtures/tls"

if [ ! -x "$LITE" ]; then
  echo "no lite runtime at '$LITE'; set LITE=/path/to/lite" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for the interop matrix" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the interop matrix" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-interop.XXXXXX")"
server_pids=()

cleanup() {
  local pid
  for pid in "${server_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${server_pids[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local file="$1" pid="$2" i=0
  while [ ! -s "$file" ]; do
    i=$((i + 1))
    if [ "$i" -gt 500 ]; then
      return 1
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.01
  done
}

# start_server <runtime> <tls:0|1> <port-file> <log-file>; sets SERVER_PID.
start_server() {
  local runtime="$1" tls="$2" port_file="$3" log_file="$4"
  if [ "$tls" = "1" ]; then
    INTEROP_TLS=1 TLS_KEY="$tls_dir/server-key.pem" TLS_CERT="$tls_dir/server-cert.pem" \
      "$runtime" "$server_js" "$port_file" >"$log_file" 2>&1 &
  else
    "$runtime" "$server_js" "$port_file" >"$log_file" 2>&1 &
  fi
  SERVER_PID=$!
  server_pids+=("$SERVER_PID")
  if ! wait_for_port "$port_file" "$SERVER_PID"; then
    echo "server failed to start ($runtime):"
    sed 's/^/  /' "$log_file" 2>/dev/null || true
    return 1
  fi
}

stop_server() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

declare -a results=()
record() {
  results+=("$1")
  printf '%-5s %s\n' "$1" "$2"
}

fail_detail() {
  local detail="$1"
  printf '      %s\n' "$detail"
}

# run_client_leg <leg-name> <server-runtime> <client-runtime> <tls>
run_client_leg() {
  local name="$1" server_runtime="$2" client_runtime="$3" tls="${4:-0}"
  local port_file="$tmp/port-$RANDOM" log="$tmp/server-$RANDOM.log" out
  if ! start_server "$server_runtime" "$tls" "$port_file" "$log"; then
    record FAIL "$name (server did not start)"
    return
  fi
  local port; port="$(cat "$port_file")"
  if [ "$tls" = "1" ]; then
    out="$(INTEROP_TLS=1 TLS_CA="$tls_dir/ca-cert.pem" \
      "$client_runtime" "$client_js" "$port_file" 2>&1)"
  else
    out="$("$client_runtime" "$client_js" "$port_file" 2>&1)"
  fi
  local code=$?
  stop_server "$SERVER_PID"
  if [ "$code" -eq 0 ]; then
    record ok "$name ($(printf '%s' "$out" | tr '\n' ' '))"
  else
    record FAIL "$name (client exit $code)"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

# header_values <file> <name>: print the trimmed values of one response header, in wire order.
header_values() {
  awk -v want="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" '
    BEGIN { IGNORECASE = 1 }
    index(tolower($0), want ":") == 1 {
      sub(/^[^:]*:[ ]*/, "")
      sub(/\r$/, "")
      print
    }' "$1"
}

# run_curl_leg <leg-name> <runtime> <tls>
run_curl_leg() {
  local name="$1" runtime="$2" tls="${3:-0}"
  local port_file="$tmp/port-$RANDOM" log="$tmp/server-$RANDOM.log" scheme="http"
  [ "$tls" = "1" ] && scheme="https"
  if ! start_server "$runtime" "$tls" "$port_file" "$log"; then
    record FAIL "$name (server did not start)"
    return
  fi
  local port; port="$(cat "$port_file")"
  local url="$scheme://127.0.0.1:$port"
  local headers="$tmp/curl-$RANDOM.headers"
  local body_one="$tmp/curl-$RANDOM.body1" body_two="$tmp/curl-$RANDOM.body2"
  local chunk_headers="$tmp/curl-$RANDOM.chunk.headers" chunk_body="$tmp/curl-$RANDOM.chunk.body"
  local -a curl_args=(--silent --show-error --max-time 10)
  if [ "$tls" = "1" ]; then
    curl_args+=(--cacert "$tls_dir/ca-cert.pem")
  fi

  curl "${curl_args[@]}" -D "$headers" -o "$body_one" "$url/ok" -o "$body_two" "$url/ok"
  local code=$?
  curl "${curl_args[@]}" -D "$chunk_headers" -o "$chunk_body" "$url/chunked"
  local chunk_code=$?

  local failures=0
  local detail
  if [ "$code" -ne 0 ]; then
    detail="curl exit $code"
    fail_detail "$detail"
    failures=$((failures + 1))
  fi
  if [ "$chunk_code" -ne 0 ]; then
    detail="curl chunked exit $chunk_code"
    fail_detail "$detail"
    failures=$((failures + 1))
  fi

  local statuses; statuses="$(grep -c '^HTTP/1.1 200' "$headers" 2>/dev/null || true)"
  if [ "$statuses" != "2" ]; then
    fail_detail "status lines: $statuses (want 2)"
    failures=$((failures + 1))
  fi
  local custom; custom="$(header_values "$headers" "X-Custom" | tr '\n' ' ')"
  if [ "$custom" != "ValueCase ValueCase " ]; then
    fail_detail "x-custom: '$custom'"
    failures=$((failures + 1))
  fi
  local counts; counts="$(header_values "$headers" "X-Connection-Requests" | tr '\n' ' ')"
  if [ "$counts" != "1 2 " ]; then
    fail_detail "connection reuse counters: '$counts' (want '1 2')"
    failures=$((failures + 1))
  fi
  local body_text; body_text="$(cat "$body_one")$(cat "$body_two")"
  if [ "$body_text" != "hellohello" ]; then
    fail_detail "body: '$body_text'"
    failures=$((failures + 1))
  fi
  local transfer; transfer="$(header_values "$chunk_headers" "Transfer-Encoding" | tr '\n' ' ')"
  if [ "$(printf '%s' "$transfer" | tr '[:upper:]' '[:lower:]')" != "chunked " ]; then
    fail_detail "transfer-encoding: '$transfer'"
    failures=$((failures + 1))
  fi
  local chunk_text; chunk_text="$(cat "$chunk_body")"
  if [ "$chunk_text" != "chunk-onechunk-two" ]; then
    fail_detail "chunked body: '$chunk_text'"
    failures=$((failures + 1))
  fi

  stop_server "$SERVER_PID"
  if [ "$failures" -eq 0 ]; then
    record ok "$name (status=200 x2 custom=ValueCase reuse=1,2 body=hello chunked=ok exit=0)"
  else
    record FAIL "$name ($failures assertion(s))"
  fi
}

echo "interop: lite=$LITE node=$(node --version)"

run_curl_leg "lite-server/curl" "$LITE"
run_client_leg "lite-server/node-client" "$LITE" "node"
run_client_leg "node-server/lite-client" "node" "$LITE"
run_client_leg "lite-server/lite-client" "$LITE" "$LITE"

# --- TLS legs (optional until WP6 lands) ------------------------------------------------------
tls_ok=0
if [ -f "$tls_dir/server-key.pem" ] && [ -f "$tls_dir/server-cert.pem" ] && [ -f "$tls_dir/ca-cert.pem" ]; then
  if "$LITE" "$probe_js" "$tls_dir/server-key.pem" "$tls_dir/server-cert.pem" >"$tmp/tls-probe.log" 2>&1; then
    tls_ok=1
  fi
else
  echo "skip  tls (test/fixtures/tls is incomplete)"
fi

if [ "$tls_ok" = "1" ]; then
  run_client_leg "tls-lite-server/node-client" "$LITE" "node" 1
  run_client_leg "tls-node-server/lite-client" "node" "$LITE" 1
  run_curl_leg "tls-lite-server/curl" "$LITE" 1
elif [ -f "$tls_dir/server-key.pem" ]; then
  echo "skip  tls (lite https unavailable: $(tr '\n' ' ' <"$tmp/tls-probe.log" 2>/dev/null))"
fi

passed=0
failed=0
for result in "${results[@]}"; do
  if [ "$result" = "ok" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); fi
done

if [ "$tls_ok" = "1" ]; then
  echo "SUMMARY: $passed passed, $failed failed (4 plaintext + 3 tls legs)"
else
  echo "SUMMARY: $passed passed, $failed failed (4 plaintext legs, tls skipped)"
fi
if [ "$failed" -ne 0 ]; then
  exit 1
fi
