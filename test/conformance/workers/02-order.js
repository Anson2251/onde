const path = require("path");
const { Worker } = require("worker_threads");
const worker = new Worker(path.join(__dirname, "fixtures", "echo.js"));
let sent = 0;
worker.on("message", (value) => {
    console.log("echo:" + value);
    sent += 1;
    if (sent < 5) worker.postMessage(sent);
    else worker.terminate();
});
worker.on("exit", (code) => console.log("exit:" + code));
worker.postMessage(0);
