process.on("unhandledRejection", (r) => console.log("unhandled", r.message));
Promise.reject(new Error("r1"));
queueMicrotask(() => console.log("m1"));
process.nextTick(() => console.log("t1"));
setTimeout(() => console.log("timer"), 0);
