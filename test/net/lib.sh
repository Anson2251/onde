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

# Machine state, for the cold-start protocol (m7-plan §4.1).
#
# A wall-clock benchmark on a laptop measures the laptop as much as the runtime: macOS `lowpowermode`
# caps CPU frequency and roughly doubles onde's 12 ms cold start. Every recorded number therefore
# carries the mode and the load average, and a gate is skipped rather than failed when the mode is
# known to be throttled.

power_mode() {
  if [ "$(uname -s)" = "Darwin" ]; then
    local value
    value="$(pmset -g 2>/dev/null | awk '/lowpowermode/ { print $2; exit }')"
    case "$value" in
      1) echo "low" ;;
      0) echo "off" ;;
      *) echo "unknown" ;;
    esac
  else
    local governor
    governor="$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null)"
    case "$governor" in
      powersave) echo "low" ;;
      performance|schedutil|ondemand|conservative|"") echo "unknown" ;;
      *) echo "unknown" ;;
    esac
  fi
}

load_average() {
  uptime 2>/dev/null | sed 's/.*load averages*: *//' | awk '{ print $1 }'
}

machine_line() {
  printf 'MACHINE lowpowermode=%s load=%s\n' "$(power_mode)" "$(load_average)"
}
