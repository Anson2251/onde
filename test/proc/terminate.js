// M5 acceptance: terminate stops a busy worker, reports exit 1, and does not wedge the process.
"use strict";
const path = require("path");
const { Worker } = require("worker_threads");
let failures = 0;

const worker = new Worker(path.join(__dirname, "fixtures", "worker-busy.js"));
worker.on("online", () => {
  worker.terminate().then((code) => {
    if (code !== 1) { failures += 1; console.log(`not ok terminate code ${code}`); }
    else console.log("ok terminate code 1");
  });
});
worker.on("exit", (code) => {
  if (code !== 1) { failures += 1; console.log(`not ok exit code ${code}`); }
  else console.log("ok exit code 1");
  console.log(failures === 0 ? "terminate: ok" : `terminate: ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
});
