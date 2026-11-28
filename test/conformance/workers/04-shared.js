const path = require("path");
const { Worker } = require("worker_threads");
const buffer = new SharedArrayBuffer(16);
const view = new Int32Array(buffer);
const workers = [];
let done = 0;
for (let i = 0; i < 2; i += 1) {
    const worker = new Worker(path.join(__dirname, "fixtures", "counter.js"), {
        workerData: { buffer, iterations: 1000 },
    });
    workers.push(worker);
    worker.on("message", () => {
        done += 1;
        if (done === 2) {
            console.log("value:" + Atomics.load(view, 0));
            for (const item of workers) item.terminate();
        }
    });
}
