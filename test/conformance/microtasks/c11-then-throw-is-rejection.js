// C11: a throw inside a .then rejects the derived promise; it is not an uncaughtException.
// Expected: m2 unhandled:in-then
process.on('uncaughtException', (e) => console.log('uncaught:' + e.message));
process.on('unhandledRejection', (e) => console.log('unhandled:' + e.message));
Promise.resolve().then(() => {
  throw new Error('in-then');
});
queueMicrotask(() => console.log('m2'));
