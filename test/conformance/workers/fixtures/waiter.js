const { parentPort, workerData } = require("worker_threads");
const view = new Int32Array(workerData.buffer);
parentPort.postMessage(Atomics.wait(view, 0, 0, 5000));
