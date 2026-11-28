setTimeout(() => {
    console.log("timer");
    process.nextTick(() => console.log("tick"));
    queueMicrotask(() => console.log("micro"));
}, 0);
