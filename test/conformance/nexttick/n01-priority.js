process.nextTick(() => console.log('tick'));
queueMicrotask(() => console.log('micro'));
Promise.resolve().then(() => console.log('then'));
console.log('sync');
