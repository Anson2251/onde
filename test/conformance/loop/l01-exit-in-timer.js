process.on('exit', c => console.log('exit', c));
setTimeout(() => { console.log('t1'); process.exit(6); }, 0);
setTimeout(() => console.log('nope'), 0);
