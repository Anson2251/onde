// C4: a rejection handled inside the same checkpoint is never reported.
// Expected: m2 caught:r2
process.on("unhandledRejection", (r) => console.log("unhandled:" + r.message));
const p = Promise.reject(new Error("r2"));
queueMicrotask(() => {
    p.catch((e) => console.log("caught:" + e.message));
});
queueMicrotask(() => console.log("m2"));
