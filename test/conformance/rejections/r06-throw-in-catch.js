process.on('unhandledRejection', r => console.log('unhandled', r.message));
Promise.resolve().then(() => { throw new Error('one'); }).catch(() => { throw new Error('two'); });
