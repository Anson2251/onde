#!/usr/bin/env bash
# Shared sampling helpers for test/net/fdleak.sh and test/net/slowloris.sh.
#
# macOS note: `ps` can be unavailable in restricted sandboxes and /proc is Linux-only, so RSS is
# read from `ps`, then /proc, then `footprint` (macOS) in that order. fd counting uses /proc on
# Linux and `lsof -p` on macOS: /dev/fd describes the *calling* process, not an arbitrary child.

fd_count() {
  local pid="$1"
  if [ -d "/proc/$pid/fd" ]; then
    ls "/proc/$pid/fd" 2>/dev/null | wc -l | tr -d ' '
  elif command -v lsof >/dev/null 2>&1; then
    lsof -p "$pid" 2>/dev/null | tail -n +2 | wc -l | tr -d ' '
  else
    echo "0"
  fi
}

rss_kb() {
  local pid="$1" value=""
  value="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return
  fi
  if [ -r "/proc/$pid/status" ]; then
    value="$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return
    fi
  fi
  if command -v footprint >/dev/null 2>&1; then
    # footprint prints KB below ~1 MB and MB above it; normalise to KB.
    value="$(footprint "$pid" 2>/dev/null | awk '
      /Footprint:/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "Footprint:") {
            amount = $(i + 1)
            unit = $(i + 2)
            if (unit == "MB") amount *= 1024
            else if (unit == "GB") amount *= 1048576
            else if (unit == "B") amount /= 1024
            print amount
            exit
          }
        }
      }')"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return
    fi
  fi
  echo "0"
}
