// C1: nextTick outranks promise jobs; a microtask queued from a tick runs after the
// microtasks already queued. Expected: sync tick1 tick2 micro1 then1 micro-from-tick
process.nextTick(() => {
    console.log("tick1");
    queueMicrotask(() => console.log("micro-from-tick"));
    process.nextTick(() => console.log("tick2"));
});
queueMicrotask(() => console.log("micro1"));
Promise.resolve().then(() => console.log("then1"));
console.log("sync");
