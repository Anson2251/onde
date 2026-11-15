const { parentPort, workerData } = require("worker_threads");
const view = new Int32Array(workerData.buffer);
const iterations = workerData.iterations;
for (let i = 0; i < iterations; i += 1) Atomics.add(view, 0, 1);
parentPort.postMessage("done");
