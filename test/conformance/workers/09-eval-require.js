const { Worker } = require("worker_threads");
const worker = new Worker(
    'const path = require("path"); console.log("joined:" + path.join("a", "b")); process.exit(0);',
    { eval: true },
);
worker.on("exit", (code) => console.log("exit:" + code));
