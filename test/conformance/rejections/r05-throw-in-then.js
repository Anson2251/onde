process.on("uncaughtException", (e) => console.log("uncaught", e.message));
process.on("unhandledRejection", (e) => console.log("unhandled", e.message));
Promise.resolve().then(() => {
    throw new Error("in-then");
});
queueMicrotask(() => console.log("m2"));
