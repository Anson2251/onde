const { Worker } = require("worker_threads");
const worker = new Worker(
    `const { workerData } = require("worker_threads");
   console.log([workerData.map.get(1), workerData.set.has(2), workerData.date.getTime(), workerData.bytes[0]].join("|"));
   process.exit(0);`,
    {
        eval: true,
        workerData: {
            map: new Map([[1, "a"]]),
            set: new Set([2]),
            date: new Date(0),
            bytes: new Uint8Array([7]),
        },
    },
);
worker.on("exit", (code) => console.log("exit:" + code));
