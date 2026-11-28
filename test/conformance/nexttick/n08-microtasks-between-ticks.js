process.nextTick(() => {
    console.log("t1");
    queueMicrotask(() => console.log("m-from-t1"));
});
queueMicrotask(() => console.log("m1"));
Promise.resolve().then(() => console.log("then1"));
