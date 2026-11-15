"use strict";

// Self-check for `js/lib/child_process.js` (M5).
//
//   ./target/debug/lite test/js/lib/child_process.test.js
//
// Plain Node skips it: the process bridge only exists under lite. The M5 acceptance harness
// (`test/proc/run.sh`) covers the behaviour; this file pins the surface and argument validation.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

const childProcess = require("child_process");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(name);
    console.log(`not ok ${name}`);
  }
}
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    return error.code === code;
  }
  return false;
}

check("spawn is a function", typeof childProcess.spawn === "function");
check("exec is a function", typeof childProcess.exec === "function");
check("execFile is a function", typeof childProcess.execFile === "function");
check("fork is a function", typeof childProcess.fork === "function");
check("ChildProcess is a class", typeof childProcess.ChildProcess === "function");
check(
  "spawn rejects a non-string file",
  throwsCode(() => childProcess.spawn(42), "ERR_INVALID_ARG_TYPE"),
);
check(
  "spawn rejects a non-array args",
  throwsCode(() => childProcess.spawn("echo", "not-array"), "ERR_INVALID_ARG_TYPE"),
);
check(
  "fork rejects a missing callback-less exec",
  throwsCode(() => childProcess.exec("echo hi", "not-a-function"), "ERR_INVALID_ARG_TYPE"),
);

const child = childProcess.spawn(process.execPath, ["-e", "process.stdout.write('ok'); process.exit(0)"]);
check("spawn returns a ChildProcess", child instanceof childProcess.ChildProcess);
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.on("close", (code, signal) => {
  check("child stdout", output === "ok");
  check("child exit code", code === 0);
  check("child exit signal", signal === null);
  console.log(failed === 0 ? "child_process: ok" : `child_process: ${failed} failed`);
  if (failures.length > 0) console.log("failures:", failures.join(", "));
  process.exitCode = failed === 0 ? 0 : 1;
});
