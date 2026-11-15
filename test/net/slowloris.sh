#!/usr/bin/env bash
# Slow-loris bound for the M4 exit criterion.
#
#   ./test/net/slowloris.sh                 # 2000 half-open connections, under a minute
#   NET_CONNS=10000 ulimit -n 20000 ./test/net/slowloris.sh   # the 10k variant
#   LITE=/path/to/lite ./test/net/slowloris.sh
#
# NET_CONNS (default 2000) sockets each send a partial request head and then idle. While they are
# held open the script samples the lite server's RSS (must stay below 25 MB), then opens one more
# connection with a head over `maxHeaderSize` and asserts the canned 431 plus a close.
#
# The default is deliberately 2000: 10k needs a raised fd limit and roughly 30-60 s on a laptop.
# The 10k variant is the exit criterion's larger sweep and is documented above.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
LITE="${LITE:-$root/target/debug/lite}"
conns="${NET_CONNS:-2000}"
rss_limit_mb="${NET_SLOWLORIS_RSS_MB:-25}"
server_js="$here/fixtures/slow-server.js"
client_js="$here/slowloris.js"
probe_js="$here/http-431.js"
# shellcheck source=lib.sh
. "$here/lib.sh"

if [ ! -x "$LITE" ]; then
  echo "no lite runtime at '$LITE'; set LITE=/path/to/lite" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for the slow-loris client" >&2
  exit 2
fi

# Each half-open connection is one fd in each process. Raise the soft limit when possible and
# fail clearly when the environment cannot hold the requested count.
current_fds="$(ulimit -n)"
if [ "$current_fds" != "unlimited" ] && [ "$current_fds" -lt $((conns * 2 + 64)) ]; then
  ulimit -n $((conns * 2 + 64)) 2>/dev/null || true
  current_fds="$(ulimit -n)"
  if [ "$current_fds" != "unlimited" ] && [ "$current_fds" -lt $((conns * 2 + 64)) ]; then
    echo "slowloris: fd limit $current_fds is too low for $conns connections (raise ulimit -n)" >&2
    exit 2
  fi
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-slowloris.XXXXXX")"
server_pid=""
client_pid=""

cleanup() {
  [ -n "$client_pid" ] && kill "$client_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  [ -n "$client_pid" ] && wait "$client_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && wait "$server_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$LITE" "$server_js" "$tmp/port" >"$tmp/server.log" 2>&1 &
server_pid=$!

i=0
while [ ! -s "$tmp/port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 500 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    echo "slowloris: server failed to start" >&2
    sed 's/^/  /' "$tmp/server.log" 2>/dev/null || true
    exit 2
  fi
  sleep 0.01
done

rss_base="$(rss_kb "$server_pid")"
echo "slowloris: runtime=$LITE connections=$conns rss_limit=${rss_limit_mb}MB baseline=${rss_base}KB"

node "$client_js" "$tmp/port" "$conns" >"$tmp/client.log" 2>&1 &
client_pid=$!

# Wait for the client to report every socket open (up to 60 s).
opened=0
i=0
while [ "$i" -lt 6000 ]; do
  if grep -q '^OPEN:' "$tmp/client.log" 2>/dev/null; then
    opened=1
    break
  fi
  if ! kill -0 "$client_pid" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.01
done

failures=0
if [ "$opened" -ne 1 ]; then
  echo "slowloris: client did not open the connections"
  sed 's/^/  /' "$tmp/client.log" 2>/dev/null || true
  failures=$((failures + 1))
fi

open_line="$(grep -m1 '^OPEN:' "$tmp/client.log" 2>/dev/null || true)"
echo "slowloris: client ${open_line:-did-not-report}"

# Let the accept loop settle, then take the peak of a few samples: a transient allocation spike is
# still memory the server is holding under the flood.
sleep 1
rss_peak=0
for _ in 1 2 3 4 5; do
  value="$(rss_kb "$server_pid")"
  if [ -n "$value" ] && [ "$value" -gt "$rss_peak" ]; then rss_peak="$value"; fi
  sleep 0.1
done
rss_mb="$(awk -v kb="$rss_peak" 'BEGIN { printf "%.1f", kb / 1024 }')"
echo "slowloris: rss_held=${rss_mb}MB (baseline $((rss_base / 1024))MB)"
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "slowloris: server died under the flood"
  failures=$((failures + 1))
fi

if ! awk -v mb="$rss_mb" -v limit="$rss_limit_mb" 'BEGIN { exit !(mb < limit) }'; then
  echo "slowloris: RSS ${rss_mb}MB is not < ${rss_limit_mb}MB"
  failures=$((failures + 1))
fi

# The 431 probe runs while the half-open sockets are still held, so it also proves the server
# still accepts and answers new connections under the flood.
probe_out="$(node "$probe_js" "$tmp/port" 2>&1)"
probe_code=$?
printf '%s\n' "$probe_out" | sed 's/^/  probe: /'
if [ "$probe_code" -ne 0 ]; then
  failures=$((failures + 1))
fi

# Tear the flood down before reporting so no listener is left behind.
kill "$client_pid" 2>/dev/null || true
wait "$client_pid" 2>/dev/null || true
client_pid=""
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""

if [ "$failures" -eq 0 ]; then
  echo "SUMMARY: conns=$conns rss_held=${rss_mb}MB baseline=$((rss_base / 1024))MB 431=ok closed=ok"
else
  echo "SUMMARY: conns=$conns rss_held=${rss_mb}MB baseline=$((rss_base / 1024))MB failures=$failures"
fi
[ "$failures" -eq 0 ]
