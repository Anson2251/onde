process.on('unhandledRejection', r => console.log('unhandled', r.message));
process.on('rejectionHandled', () => console.log('rejectionHandled'));
const p = Promise.reject(new Error('r3'));
setTimeout(() => p.catch(e => console.log('caught', e.message)), 0);
