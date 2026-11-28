let n = 0;
process.on("unhandledRejection", (r) => {
    console.log("unhandled", r.message);
    if (++n < 4) Promise.reject(new Error("cascade" + n));
});
Promise.reject(new Error("seed"));
