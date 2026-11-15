// M5 acceptance: kill/kill -9 reap the child (no zombie) and a JS SIGTERM listener runs.
"use strict";
const { spawn } = require("child_process");
const runtime = process.env.RUNTIME || process.execPath;
let failures = 0;
function check(label, actual, expected) {
  if (actual === expected) console.log(`ok ${label}`);
  else { failures += 1; console.log(`not ok ${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }
}

let seenPid = null;
const sleeper = spawn("sleep", ["30"]);
sleeper.on("spawn", () => {
  seenPid = sleeper.pid;
  check("child has pid", typeof seenPid, "number");
  check("SIGKILL accepted", sleeper.kill("SIGKILL"), true);
});
sleeper.on("exit", (code, signal) => check("SIGKILL reported", signal, "SIGKILL"));
sleeper.on("close", () => {
  // The Rust task waits for the child, so by the time close fires the pid is gone. `ps` is not
  // portable enough for this check (and some CI sandboxes deny it); `kill(pid, 0)` throwing ESRCH
  // is the OS-level proof that no live process holds the pid.
  let killZero = "survived";
  try {
    process.kill(seenPid, 0);
  } catch (error) {
    killZero = error.code;
  }
  check("kill(pid, 0) after reap", killZero, "ESRCH");
  listenerCase();
});

function listenerCase() {
  const child = spawn(runtime, [
    "-e",
    'process.on("SIGTERM", () => { console.log("caught SIGTERM"); process.exit(0); }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
  ]);
  let stdout = "";
  let signalled = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    // Wait until the listener is installed; killing on `spawn` races the child's script.
    if (!signalled && stdout.includes("ready")) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  child.on("close", (code) => {
    check("JS signal listener", stdout.trim(), "ready\ncaught SIGTERM");
    check("signal listener exit", code, 0);
    console.log(failures === 0 ? "signals: ok" : `signals: ${failures} failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
}
