// M5 acceptance: worker round-trips preserve order, and (with WORKER_ECHO_FULL=1) 1M of them.
"use strict";
const path = require("path");
const { Worker } = require("worker_threads");

const total = process.env.WORKER_ECHO_FULL === "1" ? 1_000_000 : 20_000;
const worker = new Worker(path.join(__dirname, "fixtures", "worker-echo.js"));
let expected = 0;
let received = 0;
let failures = 0;
const started = Date.now();

worker.on("error", (error) => { console.log("error", error.message); process.exitCode = 1; });
worker.on("message", (value) => {
  if (value !== expected) {
    failures += 1;
    if (failures < 5) console.log(`not ok sequence: expected ${expected}, got ${value}`);
  }
  expected += 1;
  received += 1;
  if (received === total) {
    const elapsed = (Date.now() - started) / 1000;
    console.log(`round-trips: ${received}, failures: ${failures}, ${Math.round(received / elapsed)}/s`);
    process.exitCode = failures === 0 ? 0 : 1;
    worker.terminate();
    return;
  }
  worker.postMessage(received);
});
worker.postMessage(0);
