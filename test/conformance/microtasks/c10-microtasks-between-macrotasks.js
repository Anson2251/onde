// C10: microtasks run between each timer/immediate callback, never between siblings.
// A 20 ms timer keeps the phase order deterministic (a clamped 0 ms timer is the D1 race,
// asserted order-insensitively in divergences/d04).
// Expected: imm1 m-imm1 imm2 t1 m-t1   (deterministic in lite-node; Node is too, in practice)
setImmediate(() => {
  console.log('imm1');
  queueMicrotask(() => console.log('m-imm1'));
});
setTimeout(() => {
  console.log('t1');
  queueMicrotask(() => console.log('m-t1'));
}, 20);
setImmediate(() => console.log('imm2'));
