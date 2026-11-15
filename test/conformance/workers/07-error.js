const { Worker } = require("worker_threads");
const worker = new Worker('throw new Error("boom")', { eval: true });
worker.on("error", (error) => console.log("error:" + error.name + ":" + error.message));
worker.on("exit", (code) => console.log("exit:" + code));
