// C12: queueMicrotask and promise reactions share one FIFO, in settle order.
// Also the cross-check we ran against qjs 0.17.0: same output there, because quickjs-ng
// already implements this part correctly (ADR-0002 §1.1).
// Expected: sync qm1 then1 then2 qm2 qm-from-then2
queueMicrotask(() => console.log("qm1"));
Promise.resolve().then(() => console.log("then1"));
Promise.resolve().then(() => {
    console.log("then2");
    queueMicrotask(() => console.log("qm-from-then2"));
});
queueMicrotask(() => console.log("qm2"));
console.log("sync");
