// M5 acceptance: 8 workers increment one SharedArrayBuffer exactly, and Atomics.wait wakes.
"use strict";
const path = require("path");
const { Worker } = require("worker_threads");

const WORKERS = 8;
const ITERATIONS = 50_000;
const buffer = new SharedArrayBuffer(16);
const view = new Int32Array(buffer);
let finished = 0;
let failures = 0;

for (let i = 0; i < WORKERS; i += 1) {
    const worker = new Worker(path.join(__dirname, "fixtures", "worker-counter.js"), {
        workerData: { buffer, iterations: ITERATIONS },
    });
    worker.on("message", () => {
        finished += 1;
        if (finished !== WORKERS) return;
        const expected = WORKERS * ITERATIONS;
        if (Atomics.load(view, 0) !== expected) {
            failures += 1;
            console.log(`not ok counter: ${Atomics.load(view, 0)} !== ${expected}`);
        } else {
            console.log(`ok counter ${expected}`);
        }
        checkWaiter();
    });
    worker.on("error", (error) => {
        failures += 1;
        console.log("error", error.message);
    });
}

function checkWaiter() {
    const waitBuffer = new SharedArrayBuffer(16);
    const waitView = new Int32Array(waitBuffer);
    const waiter = new Worker(path.join(__dirname, "fixtures", "worker-waiter.js"), {
        workerData: { buffer: waitBuffer },
    });
    let outcome;
    waiter.on("message", (value) => {
        outcome = value;
        if (outcome !== "ok") {
            failures += 1;
            console.log(`not ok wait: ${outcome}`);
        } else {
            console.log("ok wait woke");
        }
        console.log(failures === 0 ? "atomics: ok" : `atomics: ${failures} failed`);
        process.exitCode = failures === 0 ? 0 : 1;
    });
    // Notify after the waiter has entered the wait: a short delay is enough, and the timeout
    // (5 s) makes a missed notify fail rather than hang.
    setTimeout(() => Atomics.notify(waitView, 0, 1), 100);
}
