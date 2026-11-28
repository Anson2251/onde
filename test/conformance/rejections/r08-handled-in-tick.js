process.on("unhandledRejection", (r) => console.log("unhandled", r.message));
const p = Promise.reject(new Error("x"));
process.nextTick(() => p.catch(() => console.log("caught")));
