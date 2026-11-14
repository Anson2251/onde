// C9: `await null` enqueues its continuation before a later `.then`, so it runs first.
// Expected: f-start sync f-after then qm
async function f() {
  console.log('f-start');
  await null;
  console.log('f-after');
}
f();
Promise.resolve().then(() => console.log('then'));
queueMicrotask(() => console.log('qm'));
console.log('sync');
