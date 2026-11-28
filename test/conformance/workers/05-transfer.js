const { Worker } = require("worker_threads");
const buffer = new ArrayBuffer(4);
new Uint8Array(buffer)[0] = 9;
const worker = new Worker(
    'const { parentPort } = require("worker_threads"); parentPort.postMessage("worker"); process.exit(0);',
    { eval: true, workerData: buffer, transferList: [buffer] },
);
console.log("detached:" + (buffer.byteLength === 0));
worker.on("exit", (code) => console.log("exit:" + code));
