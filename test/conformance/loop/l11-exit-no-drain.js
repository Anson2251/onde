process.on('exit', c => console.log('exit', c));
queueMicrotask(() => { console.log('m1'); process.exit(0); });
queueMicrotask(() => console.log('nope'));
