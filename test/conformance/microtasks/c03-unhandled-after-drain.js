// C3: an unhandled rejection is reported after both queues drain, before the next phase.
// Expected: t1 m1 unhandled:r1 timer
process.on("unhandledRejection", (r) => console.log("unhandled:" + r.message));
Promise.reject(new Error("r1"));
queueMicrotask(() => console.log("m1"));
process.nextTick(() => console.log("t1"));
setTimeout(() => console.log("timer"), 0);
