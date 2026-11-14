process.on('uncaughtException', e => { console.log('uncaught', e.message); process.nextTick(() => console.log('tick-from-handler')); queueMicrotask(() => console.log('micro-from-handler')); });
queueMicrotask(() => { throw new Error('x'); });
queueMicrotask(() => console.log('m2'));
Promise.resolve().then(() => console.log('then'));
