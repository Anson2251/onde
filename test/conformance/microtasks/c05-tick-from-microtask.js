// C5: a nextTick queued from a microtask runs only after the microtask queue is empty.
// Expected: m1 m2 tick-from-m1
queueMicrotask(() => {
    console.log("m1");
    process.nextTick(() => console.log("tick-from-m1"));
});
queueMicrotask(() => console.log("m2"));
