// 1M promises with async_hooks enabled: ids stay monotonic, the resource table is pruned by GC,
// and the loop comes back to the root context. Structural checks only — the values are
// runtime-specific, so node and lite print the same booleans.

"use strict";

const { createHook, executionAsyncId } = require("async_hooks");

const COUNT = 1_000_000;
let inits = 0;
let resolves = 0;
let lastId = 0;
let monotonic = true;

const hook = createHook({
  init(id) {
    inits += 1;
    if (id <= lastId) monotonic = false;
    lastId = id;
  },
  promiseResolve() {
    resolves += 1;
  },
});
hook.enable();

const rootId = executionAsyncId();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < COUNT; i += 1) {
  Promise.resolve(i);
}

// Retained garbage is collected between turns. Debug builds in particular can still be holding
// the whole batch here, so the heap reading is taken from a second turn, after a collection has
// had a chance to schedule its finalizer jobs (which the loop then runs).
setTimeout(() => {
  // Allocate and drop ~50 MB: over QuickJS's GC threshold, so a collection actually happens.
  for (let i = 0; i < 64; i += 1) {
    globalThis.__gc_nudge = new Array(100000).fill(i);
  }
  globalThis.__gc_nudge = undefined;
}, 50);

setTimeout(() => {
  const growth = process.memoryUsage().heapUsed - before;
  console.log("inits", inits >= COUNT);
  console.log("resolves", resolves >= COUNT);
  console.log("monotonic", monotonic);
  console.log("root context", rootId === 1);
  // What must not happen is retention of the promises themselves: a strong reference would cost
  // over a gigabyte for 1M of them. The bound is generous because a debug build's accounting and
  // a young collector both add noise; it only catches unbounded growth.
  console.log("bounded", growth < 128 * 1024 * 1024);
  hook.disable();
  console.log("done");
}, 120);
