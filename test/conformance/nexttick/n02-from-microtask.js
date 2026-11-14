queueMicrotask(() => { console.log('m1'); process.nextTick(() => console.log('tick-from-m1')); });
queueMicrotask(() => console.log('m2'));
