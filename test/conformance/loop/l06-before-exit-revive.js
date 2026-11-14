let n = 0;
process.on('beforeExit', c => { console.log('beforeExit', c, n); if (n++ < 2) setTimeout(() => console.log('timer', n), 0); });
process.on('exit', c => console.log('exit', c));
