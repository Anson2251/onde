process.on("uncaughtException", (e) => console.log("handled", e.name, e.message));
setTimeout(() => {
    throw new Error("timer-boom");
}, 0);
