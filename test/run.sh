#!/usr/bin/env bash
# Shared test entry: one suite table, one summary, and `--skip` for the rest.
#
#   ./test/run.sh --list
#   ./test/run.sh
#   ./test/run.sh --skip ffi,proc
#   ./test/run.sh --all
#
# The suite scripts stay the source of truth for how each area is built and run; this file only
# orders them and reports the result. `--skip` is repeatable and takes a comma-separated list.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

default_suites="rust js conformance differential ffi perm proc async programs smoke node-test diag features"
optin_suites="net standalone stress soak"
known_suites="$default_suites $optin_suites"

all=0
list=0
skip_spec=""

usage() {
  cat <<'EOF'
usage: test/run.sh [--list] [--all] [--skip SUITE[,SUITE...]]...

  (no options)   run the default suites
  --all          also run the opt-in suites (net, standalone, stress, soak)
  --skip NAME    skip a suite; repeatable and comma-separated
  --list         print the suite table and exit

Suite names: rust js conformance differential ffi perm proc async programs smoke
             node-test diag features net standalone stress soak
EOF
}

die() {
  printf 'test/run.sh: %s\n' "$*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --list) list=1; shift ;;
    --all) all=1; shift ;;
    --skip)
      [ $# -ge 2 ] || die "--skip needs a suite name"
      skip_spec="${skip_spec:+$skip_spec,}$2"
      shift 2
      ;;
    --skip=*)
      skip_spec="${skip_spec:+$skip_spec,}${1#--skip=}"
      shift
      ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

# The command each suite runs, for --list and for the runner.
suite_desc() {
  case "$1" in
    rust)        echo "cargo test --all" ;;
    js)          echo "./test/js/run.sh" ;;
    conformance) echo "./test/conformance/run.sh" ;;
    differential) echo "./test/differential.sh" ;;
    ffi)         echo "./test/ffi/run.sh" ;;
    perm)        echo "./test/perm/run.sh" ;;
    proc)        echo "./test/proc/run.sh" ;;
    async)       echo "./test/async/run.sh" ;;
    programs)    echo "./test/programs/run.sh" ;;
    smoke)       echo "./test/smoke/run.sh" ;;
    node-test)   echo "./test/node-test/run.sh" ;;
    diag)        echo "./test/diag/run.sh" ;;
    features)    echo "./test/features/run.sh" ;;
    net)         echo "./test/net/run.sh" ;;
    standalone)  echo "./test/standalone/run.sh" ;;
    stress)      echo "./test/stress/run.sh" ;;
    soak)        echo "./test/soak/run.sh" ;;
    *) return 1 ;;
  esac
}

if [ "$list" = 1 ]; then
  for name in $default_suites; do
    printf '%-14s %-8s %s\n' "$name" "default" "$(suite_desc "$name")"
  done
  for name in $optin_suites; do
    printf '%-14s %-8s %s\n' "$name" "opt-in" "$(suite_desc "$name")"
  done
  exit 0
fi

# Validate the names before running anything: a typo in --skip must not silently skip nothing.
if [ -n "$skip_spec" ]; then
  old_ifs="$IFS"
  IFS=','
  for entry in $skip_spec; do
    [ -n "$entry" ] || continue
    case " $known_suites " in
      *" $entry "*) ;;
      *) IFS="$old_ifs"; die "unknown suite '$entry' in --skip (try --list)" ;;
    esac
  done
  IFS="$old_ifs"
fi

is_skipped() {
  local entry
  local old_ifs="$IFS"
  IFS=','
  for entry in $skip_spec; do
    if [ "$entry" = "$1" ]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

# The suites take a built debug binary unless ONDE points at an artifact. Building is cheap when
# nothing changed, and it keeps `make test` from failing on a fresh checkout.
if [ -z "${ONDE:-}" ]; then
  if ! cargo build -p ln-cli; then
    printf 'test/run.sh: cargo build -p ln-cli failed\n' >&2
    exit 2
  fi
fi

run_suite() {
  case "$1" in
    rust)        cargo test --all ;;
    js)          ./test/js/run.sh ;;
    conformance) ./test/conformance/run.sh ;;
    differential) ./test/differential.sh ;;
    ffi)         ./test/ffi/run.sh ;;
    perm)        ./test/perm/run.sh ;;
    proc)        ./test/proc/run.sh ;;
    async)       ./test/async/run.sh ;;
    programs)    ./test/programs/run.sh ;;
    smoke)       ./test/smoke/run.sh ;;
    node-test)   ./test/node-test/run.sh ;;
    diag)        ./test/diag/run.sh ;;
    features)    ./test/features/run.sh ;;
    net)         ./test/net/run.sh ;;
    standalone)  ./test/standalone/run.sh ;;
    stress)      ./test/stress/run.sh ;;
    soak)        ./test/soak/run.sh ;;
    *) return 2 ;;
  esac
}

suites="$default_suites"
[ "$all" = 1 ] && suites="$default_suites $optin_suites"

passed=0
failed=0
setup=0
skipped=0
failed_names=""
setup_names=""

for name in $suites; do
  if is_skipped "$name"; then
    printf 'skip      %s\n' "$name"
    skipped=$((skipped + 1))
    continue
  fi
  printf '\n== %s\n' "$name"
  ( run_suite "$name" )
  status=$?
  if [ "$status" -eq 0 ]; then
    passed=$((passed + 1))
    printf 'ok        %s\n' "$name"
  elif [ "$status" -eq 2 ]; then
    # The suite scripts use 2 for "this host cannot run me" (missing compiler, binary, ...).
    setup=$((setup + 1))
    setup_names="$setup_names $name"
    printf 'setup     %s\n' "$name"
  else
    failed=$((failed + 1))
    failed_names="$failed_names $name"
    printf 'FAIL      %s (exit %s)\n' "$name" "$status"
  fi
done

printf '\n'
printf 'passed: %d  failed: %d  setup: %d  skipped: %d\n' \
  "$passed" "$failed" "$setup" "$skipped"
[ -n "$failed_names" ] && printf 'failed:%s\n' "$failed_names"
[ -n "$setup_names" ] && printf 'setup:%s\n' "$setup_names"

if [ "$failed" -ne 0 ] || [ "$setup" -ne 0 ]; then
  exit 1
fi
exit 0
