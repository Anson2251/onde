process.on("uncaughtException", (e) => console.log("uncaught", e.message));
queueMicrotask(() => {
    console.log("m1");
    throw new Error("boom");
});
queueMicrotask(() => console.log("m2"));
