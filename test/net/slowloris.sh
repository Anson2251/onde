#!/usr/bin/env bash
# Slow-loris bound for the M4 exit criterion.
#
#   ./test/net/slowloris.sh                 # 2000 half-open connections, under a minute
#   NET_CONNS=10000 ulimit -n 20000 ./test/net/slowloris.sh   # the 10k variant
#   LITE=/path/to/lite ./test/net/slowloris.sh
#   NET_SLOWLORIS_RAW=1 ./test/net/slowloris.sh   # the floor: raw TCP, no HTTP layer
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
# The floor variant serves raw TCP (accept, consume, never answer) so the difference between the
# two runs is the HTTP layer's per-connection cost — the number m7-plan §6.1 re-specifies the bound
# against, since the raw floor alone (29 MB at 2,000) is above the old 25 MB target.
if [ "${NET_SLOWLORIS_RAW:-0}" = "1" ]; then
  server_js="$here/fixtures/raw-server.js"
  mode="raw"
else
  server_js="$here/fixtures/slow-server.js"
  mode="http"
fi
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
echo "slowloris: runtime=$LITE connections=$conns mode=$mode rss_limit=${rss_limit_mb}MB baseline=${rss_base}KB"

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

# The client must have opened exactly the connections we asked for: a partial flood measures a
# different stress level, and comparing it against a full one produced a nonsense -22 MB delta once.
opened_count="$(printf '%s' "${open_line:-}" | sed -n 's/.*OPEN:\([0-9]*\).*/\1/p')"
if [ "${opened_count:-0}" != "$conns" ]; then
  echo "slowloris: client opened ${opened_count:-0} of $conns connections; not a measurement of the bound"
  failures=$((failures + 1))
fi

# Let the accept loop settle, then take the median of seven samples. The median rather than the
# peak, because this number is used as a *difference* against the raw-TCP floor (m7-plan §6.1) and
# one transient in one of the two runs would otherwise dominate it. The peak is reported alongside.
sleep 1
samples=""
for _ in 1 2 3 4 5 6 7; do
  value="$(rss_kb "$server_pid")"
  [ -n "$value" ] && samples="$samples$value
"
  sleep 0.1
done
rss_peak="$(printf '%s' "$samples" | sort -n | tail -n 1)"
rss_median="$(printf '%s' "$samples" | sort -n | sed -n 4p)"
rss_mb="$(awk -v kb="${rss_median:-0}" 'BEGIN { printf "%.1f", kb / 1024 }')"
rss_peak_mb="$(awk -v kb="${rss_peak:-0}" 'BEGIN { printf "%.1f", kb / 1024 }')"
echo "slowloris: rss_held=${rss_mb}MB peak=${rss_peak_mb}MB (baseline $((rss_base / 1024))MB)"
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "slowloris: server died under the flood"
  failures=$((failures + 1))
fi

if [ "$mode" = "http" ] && ! awk -v mb="$rss_mb" -v limit="$rss_limit_mb" 'BEGIN { exit !(mb < limit) }'; then
  echo "slowloris: RSS ${rss_mb}MB is not < ${rss_limit_mb}MB"
  if [ "${NET_BENCH_SOFT:-0}" = "1" ]; then
    # A shared CI runner is not the reference machine, and this bound is a recorded M4 gap that
    # M7 closes by making per-connection session state lazy. Report the number, do not gate on it.
    echo "slowloris: memory bound is a known gap (m4-plan §8), soft mode: not enforced"
  else
    failures=$((failures + 1))
  fi
fi

# The 431 probe runs while the half-open sockets are still held, so it also proves the server
# still accepts and answers new connections under the flood. It is an HTTP behaviour, so the raw
# floor variant has nothing to probe.
if [ "$mode" = "http" ]; then
probe_out="$(node "$probe_js" "$tmp/port" 2>&1)"
probe_code=$?
printf '%s\n' "$probe_out" | sed 's/^/  probe: /'
if [ "$probe_code" -ne 0 ]; then
  failures=$((failures + 1))
fi
fi

# Tear the flood down before reporting so no listener is left behind.
kill "$client_pid" 2>/dev/null || true
wait "$client_pid" 2>/dev/null || true
client_pid=""
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""

if [ "$failures" -eq 0 ]; then
  echo "RESULT conns=$conns mode=$mode rss_mb=$rss_mb baseline_mb=$((rss_base / 1024)) 431=ok closed=ok"
else
  echo "RESULT conns=$conns mode=$mode rss_mb=$rss_mb baseline_mb=$((rss_base / 1024)) failures=$failures"
fi
[ "$failures" -eq 0 ]
