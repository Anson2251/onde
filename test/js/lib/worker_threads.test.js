"use strict";

// Self-check for `js/lib/worker_threads.js` and `js/lib/internal/worker.js` (M5).
//
//   ./target/debug/onde test/js/lib/worker_threads.test.js
//
// Plain Node skips it: a worker is a nested isolate with the onde host. `test/proc/run.sh` and
// the conformance corpus cover the behaviour; this pins the main-thread surface and validation.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: onde host unavailable");
  process.exit(0);
}

const workerThreads = require("worker_threads");

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

check("isMainThread", workerThreads.isMainThread === true);
check("threadId", workerThreads.threadId === 0);
check("parentPort is null on main", workerThreads.parentPort === null);
check("workerData is null on main", workerThreads.workerData === null);
check("Worker is a class", typeof workerThreads.Worker === "function");
check("MessageChannel is a class", typeof workerThreads.MessageChannel === "function");
check("receiveMessageOnPort", typeof workerThreads.receiveMessageOnPort === "function");
check("markAsUntransferable", typeof workerThreads.markAsUntransferable === "function");

const { port1, port2 } = new workerThreads.MessageChannel();
const seen = [];
port2.on("message", (value) => seen.push(value));
port1.postMessage(1);
port1.postMessage(2);
check("receiveMessageOnPort returns the queued value", workerThreads.receiveMessageOnPort(port2).message === 1);

const worker = new workerThreads.Worker(
  'const { parentPort, workerData } = require("worker_threads"); parentPort.on("message", (m) => parentPort.postMessage(m + workerData.add));',
  { eval: true, workerData: { add: 1 } },
);
check("Worker has a threadId", typeof worker.threadId === "number" && worker.threadId > 0);
let echoed = null;
worker.on("message", (value) => {
  echoed = value;
  worker.terminate().then((code) => {
    check("worker echoed the message", echoed === 42);
    check("terminate resolves exit code 1", code === 1);
    check("async port delivered", seen.length === 1 && seen[0] === 2);
    console.log(failed === 0 ? "worker_threads: ok" : `worker_threads: ${failed} failed`);
    if (failures.length > 0) console.log("failures:", failures.join(", "));
    process.exitCode = failed === 0 ? 0 : 1;
  });
});
worker.postMessage(41);
