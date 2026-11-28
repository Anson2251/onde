const { Worker } = require("worker_threads");
const worker = new Worker("while (true) {}", { eval: true });
worker.on("online", () => {
    worker.terminate().then((code) => console.log("terminated:" + code));
});
worker.on("exit", (code) => console.log("exit:" + code));
