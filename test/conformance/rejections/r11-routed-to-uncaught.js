process.on('uncaughtException', e => console.log('uncaught', e.message));
Promise.reject(new Error('r'));
