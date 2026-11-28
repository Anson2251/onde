process.on("unhandledRejection", (r) => console.log("unhandled", r.message));
setTimeout(() => {
    Promise.reject(new Error("later"));
}, 0);
