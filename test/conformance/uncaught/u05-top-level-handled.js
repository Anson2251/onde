process.on("uncaughtException", (e) => console.log("handled", e.message));
queueMicrotask(() => console.log("micro"));
throw new Error("top");
