// C2: a throwing microtask is reported inline and the remaining microtasks still run.
// Expected: m1 uncaught:boom m2 then1
process.on('uncaughtException', (e) => console.log('uncaught:' + e.message));
queueMicrotask(() => {
  console.log('m1');
  throw new Error('boom');
});
queueMicrotask(() => console.log('m2'));
Promise.resolve().then(() => console.log('then1'));
