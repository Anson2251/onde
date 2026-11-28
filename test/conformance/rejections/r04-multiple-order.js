process.on("unhandledRejection", (r) => console.log("unhandled", r.message));
Promise.reject(new Error("a"));
Promise.reject(new Error("b"));
