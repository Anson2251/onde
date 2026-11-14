process.on('uncaughtException', e => { console.log('h', e.message); queueMicrotask(() => console.log('from-handler')); });
queueMicrotask(() => { throw new Error('x'); });
queueMicrotask(() => console.log('m2'));
