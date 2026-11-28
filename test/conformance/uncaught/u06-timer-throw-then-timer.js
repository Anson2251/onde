process.on("uncaughtException", (e) => {
    console.log("handled", e.message);
    setTimeout(() => console.log("after"), 0);
});
setTimeout(() => {
    throw new Error("boom");
}, 0);
