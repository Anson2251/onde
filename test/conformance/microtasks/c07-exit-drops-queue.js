// C7: process.exit inside a microtask drops the remaining microtasks (exit code 0).
// Expected: t1 m1   (m2 must NOT run)
queueMicrotask(() => {
    console.log("m1");
    process.exit(0);
});
queueMicrotask(() => console.log("m2"));
process.nextTick(() => console.log("t1"));
