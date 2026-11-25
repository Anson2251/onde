#!/usr/bin/env bash
# 10k connect/disconnect leak check (M4 §8).
#
#   ./test/net/fdleak.sh
#   NET_CYCLES=50000 ./test/net/fdleak.sh
#   ONDE=/path/to/onde ./test/net/fdleak.sh
#
# A onde server accepts NET_CYCLES (default 10000) connections that the node client opens, sends
# FIN on, and closes. The server's fd count and RSS are sampled after a small warm-up and once
# more after the churn, then compared: fd growth must be <= 2 and RSS growth <= 8 MB.
#
# The RSS bound is absolute on purpose. A percentage of an 8-10 MB baseline is inside the
# allocator's noise: three runs of this script on the same binary moved by 0.4, 1.4 and 3.4 MB,
# which is 3% to 44% of the baseline and none of it a leak (fd growth was 0 every time). After
# 10,000 connections a real per-connection leak is far larger than 8 MB, so the ceiling still
# catches one without failing on allocator retention.
#
# Back-to-back runs are fine: three in a row completed in 3, 4 and 6 seconds. A connection that
# cannot open fails with ETIMEDOUT and a hint after 15 s rather than stalling the worker.
#
# If a piped invocation ever appears to hang, check for a leaked `sleep 180`: the watchdog used to
# inherit stdout and hold the pipe open after the script itself had exited.
#
# fd sampling: /proc/<pid>/fd on Linux, `lsof -p` on macOS. /dev/fd is per-process (it describes
# the shell's own fds), so it cannot sample a child; lsof is the macOS equivalent. No hardcoded
# ports: the server binds :0 and writes the port to a temp file.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-${LITE:-$root/target/debug/onde}}"
cycles="${NET_CYCLES:-10000}"
warmup="${NET_FDLEAK_WARMUP:-100}"
concurrency="${NET_CONCURRENCY:-50}"
server_js="$here/fixtures/fd-server.js"
# shellcheck source=lib.sh
. "$here/lib.sh"
client_js="$here/fixtures/connect-cycles.js"

if [ ! -x "$onde" ]; then
  echo "no onde runtime at '$onde'; set ONDE=/path/to/onde" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for the connection churn client" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ln-fdleak.XXXXXX")"
server_pid=""
client_pid=""
watchdog=""

cleanup() {
  # The watchdog outlives the script on any early exit unless it is killed here, and because it
  # inherits stdout, a leaked one keeps `fdleak.sh | anything` waiting for the full 180 s.
  [ -n "$watchdog" ] && kill "$watchdog" 2>/dev/null || true
  [ -n "$client_pid" ] && kill "$client_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  [ -n "$client_pid" ] && wait "$client_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && wait "$server_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$onde" "$server_js" "$tmp/port" >"$tmp/server.log" 2>&1 &
server_pid=$!

i=0
while [ ! -s "$tmp/port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 500 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    echo "fdleak: server failed to start" >&2
    sed 's/^/  /' "$tmp/server.log" 2>/dev/null || true
    exit 2
  fi
  sleep 0.01
done
port="$(cat "$tmp/port")"

echo "fdleak: runtime=$onde cycles=$cycles concurrency=$concurrency"

# A short warm-up allocates the per-socket buffers and any lazily created pool state, so the
# baseline is not compared against a cold process.
NET_CONCURRENCY="$concurrency" node "$client_js" "$tmp/port" "$warmup" >"$tmp/warmup.log" 2>&1 || {
  echo "fdleak: warm-up failed" >&2
  sed 's/^/  /' "$tmp/warmup.log" 2>/dev/null || true
  exit 1
}
sleep 0.3

fd_before="$(fd_count "$server_pid")"
rss_before="$(rss_kb "$server_pid")"
if [ "$rss_before" = "0" ]; then
  echo "fdleak: RSS sampling unavailable on this host; fd growth is still enforced" >&2
fi
echo "fdleak: before fd=$fd_before rss=${rss_before}KB"

started_at="$(node -e 'process.stdout.write(String(Date.now()))')"
NET_CONCURRENCY="$concurrency" node "$client_js" "$tmp/port" "$cycles" >"$tmp/client.log" 2>&1 &
client_pid=$!

# Watchdog: 10k cycles on a slow machine is still well under two minutes.
(
  sleep 180
  if kill -0 "$client_pid" 2>/dev/null; then
    echo "fdleak: client timed out" >&2
    kill -9 "$client_pid" 2>/dev/null || true
  fi
) >/dev/null 2>&1 &
watchdog=$!

wait "$client_pid"
client_code=$?
client_pid=""
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
elapsed="$((($(node -e 'process.stdout.write(String(Date.now()))') - started_at) / 1000))"

cat "$tmp/client.log"
if [ "$client_code" -ne 0 ]; then
  echo "fdleak: client failed (exit $client_code)" >&2
  exit 1
fi

# The accept loop reaps closed sockets asynchronously: under 10k churn the fd count can take
# several seconds to fall back to the baseline. Poll until it is flat (growth <= 2) or 60 s.
settled=0
while [ "$settled" -lt 120 ]; do
  fd_after="$(fd_count "$server_pid")"
  if [ $((fd_after - fd_before)) -le 2 ]; then
    break
  fi
  settled=$((settled + 1))
  sleep 0.5
done
echo "fdleak: settled after $((settled / 2))s"
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "fdleak: server died during the churn" >&2
  exit 1
fi
fd_after="$(fd_count "$server_pid")"
rss_after="$(rss_kb "$server_pid")"
echo "fdleak: after  fd=$fd_after rss=${rss_after}KB cycles=$cycles seconds=$elapsed"

fd_growth=$((fd_after - fd_before))
rss_growth=$((rss_after - rss_before))
rss_pct="$(awk -v before="$rss_before" -v after="$rss_after" 'BEGIN { if (before <= 0) { print "0.0" } else { printf "%.1f", (after - before) * 100 / before } }')"

failures=0
if [ "$fd_growth" -gt 2 ]; then
  echo "fdleak: fd growth $fd_growth is > 2"
  failures=$((failures + 1))
fi
rss_budget_kb="${NET_FDLEAK_RSS_KB:-8192}"
if [ "$rss_before" != "0" ] && [ "$rss_growth" -gt "$rss_budget_kb" ]; then
  echo "fdleak: RSS growth $((rss_growth / 1024))MB is > $((rss_budget_kb / 1024))MB (${rss_pct}% of baseline)"
  failures=$((failures + 1))
fi

echo "SUMMARY: cycles=$cycles fd_before=$fd_before fd_after=$fd_after fd_growth=$fd_growth rss_before=${rss_before}KB rss_after=${rss_after}KB rss_growth=$((rss_growth / 1024))MB (${rss_pct}%)"
[ "$failures" -eq 0 ]
