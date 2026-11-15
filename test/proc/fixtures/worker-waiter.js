const { parentPort, workerData } = require("worker_threads");
const view = new Int32Array(workerData.buffer);
const outcome = Atomics.wait(view, 0, 0, 5000);
parentPort.postMessage(outcome);
