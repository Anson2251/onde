const second = () => console.log('second');
process.on('exit', () => { console.log('first'); process.removeListener('exit', second); });
process.on('exit', second);
