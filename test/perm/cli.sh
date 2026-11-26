#!/usr/bin/env bash
# The permission CLI surface: both grant channels, mutual exclusion, and the usage errors.
#
#   ./test/perm/cli.sh                 # target/debug/onde
#   ONDE=target/release/onde ./test/perm/cli.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
onde="${ONDE:-$root/target/debug/onde}"

if [ ! -x "$onde" ]; then
  echo "no onde binary at '$onde'; run 'cargo build' or set ONDE=" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '{"x":7}\n' > "$work/data.json"
cat > "$work/main.js" <<'JS'
try {
  const data = require("./data.json");
  console.log("loaded", data.x);
  process.exit(0);
} catch (error) {
  console.log("error", error.code);
  process.exit(error.code === "ERR_ACCESS_DENIED" ? 3 : 4);
}
JS
cat > "$work/ci.json" <<'JSON'
{
  // a relative grant roots at this file's directory
  "fs": { "read": ["./"] }
}
JSON
cat > "$work/--odd.js" <<'JS'
console.log("odd", typeof __ln_host.readFile, typeof __ln_loader);
JS

pass=0
fail=0
failed=()

# run <label> <expected-exit> <expected-output-substring> <command...>
run() {
  local label="$1" want_code="$2" want_text="$3"
  shift 3
  local out code
  out="$("$@" 2>&1)"
  code=$?
  if [ "$code" -ne "$want_code" ]; then
    echo "FAIL      $label (exit $code, wanted $want_code)"
    printf '%s\n' "$out" | sed 's/^/          /'
    failed+=("$label")
    fail=$((fail + 1))
    return
  fi
  if [ -n "$want_text" ] && ! printf '%s' "$out" | grep -qF -- "$want_text"; then
    echo "FAIL      $label (missing '$want_text')"
    printf '%s\n' "$out" | sed 's/^/          /'
    failed+=("$label")
    fail=$((fail + 1))
    return
  fi
  echo "ok        $label"
  pass=$((pass + 1))
}

run "deny-all denies the data read" 3 "error ERR_ACCESS_DENIED" \
  "$onde" --permission "$work/main.js"

run "a read grant with '=' allows it" 0 "loaded 7" \
  "$onde" --permission --allow-fs-read="$work" "$work/main.js"

run "a read grant with a space allows it" 0 "loaded 7" \
  "$onde" --permission --allow-fs-read "$work" "$work/main.js"

run "the policy file allows it" 0 "loaded 7" \
  "$onde" --permission --permission-file="$work/ci.json" "$work/main.js"

run "both grant channels are a usage error" 1 "cannot be combined" \
  "$onde" --permission --permission-file="$work/ci.json" --allow-env=PATH "$work/main.js"

run "a policy file without --permission is a usage error" 1 "--permission is required" \
  "$onde" --permission-file="$work/ci.json" "$work/main.js"

run "an allow flag without --permission is a usage error" 1 "--permission is required" \
  "$onde" --allow-env=PATH -e '1+1'

run "a connect-only spelling is refused for listen" 1 "listen-only" \
  "$onde" --permission --allow-net-connect=:8080 "$work/main.js"

run "-- separates a flag-looking script" 0 "odd undefined undefined" \
  "$onde" --permission --allow-fs-read="$work" -- "$work/--odd.js"

run "every allow flag reaches the policy" 0 "all-true" \
  "$onde" --permission \
    --allow-fs-read=/tmp --allow-fs-write=/tmp \
    --allow-net-connect=api.example.com:443 --allow-net-listen=:0 \
    --allow-net-resolve=api.example.com --allow-child-process=echo \
    --allow-env=PATH --allow-worker --allow-ffi \
    -e 'const ok = process.permission.has("fs.read", "/tmp/x") && process.permission.has("fs.write", "/tmp/x") && process.permission.has("net.connect", "api.example.com:443") && process.permission.has("net.listen", ":0") && process.permission.has("net.resolve", "api.example.com") && process.permission.has("child.spawn", "/bin/echo") && process.permission.has("env.read", "PATH") && process.permission.has("worker.spawn") && process.permission.has("ffi.load"); console.log(ok ? "all-true" : "missing");'

run "a missing policy file is fatal" 1 "cannot open" \
  "$onde" --permission --permission-file="$work/nope.json" "$work/main.js"

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failing: %s\n' "${failed[*]}" >&2
  exit 1
fi
