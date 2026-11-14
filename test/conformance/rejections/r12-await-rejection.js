process.on('unhandledRejection', r => console.log('unhandled', r.message));
async function f() { await Promise.reject(new Error('awaited')); }
f();
queueMicrotask(() => console.log('m'));
