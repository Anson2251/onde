const { Worker } = require("worker_threads");
const worker = new Worker("process.exit(0)", { eval: true });
worker.on("online", () => console.log("online:" + (typeof worker.threadId === "number")));
worker.on("exit", (code) => console.log("exit:" + code));
