process.on('uncaughtException', e => console.log('handled', e.message));
process.nextTick(() => { throw new Error('tick-boom'); });
process.nextTick(() => console.log('t2'));
