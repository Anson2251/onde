process.on("uncaughtException", (e) => console.log("uncaught", e.message));
process.on("unhandledRejection", (r) => console.log("unhandled", r.message));
Promise.reject(new Error("r"));
