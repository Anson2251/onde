const { parentPort, workerData } = require("worker_threads");
const view = new Int32Array(workerData.buffer);
for (let i = 0; i < workerData.iterations; i += 1) Atomics.add(view, 0, 1);
parentPort.postMessage("done");
