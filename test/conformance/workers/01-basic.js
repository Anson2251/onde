const { Worker, isMainThread } = require("worker_threads");
console.log("main:" + isMainThread);
const worker = new Worker(
  'const { isMainThread, workerData } = require("worker_threads"); console.log("worker:" + isMainThread + ":" + workerData.name); process.exit(0);',
  { eval: true, workerData: { name: "onde" } },
);
console.log("online:" + (typeof worker.threadId));
worker.on("exit", (code) => console.log("exit:" + code));
