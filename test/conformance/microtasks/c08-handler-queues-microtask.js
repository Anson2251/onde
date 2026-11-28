// C8: an uncaughtException handler runs inline; microtasks it queues go to the tail.
// Expected: h:x m2 from-handler
process.on("uncaughtException", (e) => {
    console.log("h:" + e.message);
    queueMicrotask(() => console.log("from-handler"));
});
queueMicrotask(() => {
    throw new Error("x");
});
queueMicrotask(() => console.log("m2"));
