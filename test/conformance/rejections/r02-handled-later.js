process.on('unhandledRejection', r => console.log('unhandled', r.message));
const p = Promise.reject(new Error('r2'));
queueMicrotask(() => { p.catch(e => console.log('caught', e.message)); });
queueMicrotask(() => console.log('m2'));
