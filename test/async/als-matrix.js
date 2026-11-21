// The AsyncLocalStorage propagation matrix (M6 exit criterion: 60+ cells, 100%).
//
// Ten scheduling contexts x eight observations, printed as one sorted line per cell so the
// runner can diff node against lite byte for byte. A cell that disagrees with Node is a real
// propagation bug: the store either leaked out of its run, was lost across a boundary, or was
// shadowed by a concurrent run.
//
// Contexts: await, then, queueMicrotask, process.nextTick, setTimeout, setImmediate,
// fs.readFile (callback), fs.promises.readFile (then), EventEmitter (emitted from a timer),
// AsyncResource.runInAsyncScope, a stream 'data' event, and process.nextTick scheduled from a
// then.
//
// Observations per context:
//   inside        store visible in the callback
//   concurrent    a second, interleaved run keeps its own store
//   outside       store is gone after run() returned
//   nested        an inner run() sees its own store
//   restored      after the inner run(), the outer store is back
//   resource      an AsyncResource created inside inherits
//   thenchild     a promise callback created inside inherits
//   late          a timer created inside the context inherits

const { AsyncLocalStorage, AsyncResource } = require("async_hooks");
const fs = require("fs");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const als = new AsyncLocalStorage();
const cells = [];
const record = (context, cell, value) => {
  cells.push(`${context}:${cell}=${value === undefined ? "<none>" : value}`);
};

const contexts = {
  await: (fn) => {
    (async () => {
      await null;
      fn();
    })();
  },
  then: (fn) => {
    Promise.resolve().then(fn);
  },
  microtask: (fn) => queueMicrotask(fn),
  tick: (fn) => process.nextTick(fn),
  timeout: (fn) => setTimeout(fn, 1),
  immediate: (fn) => setImmediate(fn),
  fscb: (fn) => fs.readFile(__filename, () => fn()),
  fspromise: (fn) => {
    fs.promises.readFile(__filename).then(() => fn());
  },
  emitter: (fn) => {
    const emitter = new EventEmitter();
    emitter.on("go", fn);
    setTimeout(() => emitter.emit("go"), 1);
  },
  resource: (fn) => {
    new AsyncResource("ContextResource").runInAsyncScope(fn);
  },
  stream: (fn) => {
    const stream = new PassThrough();
    stream.on("data", fn);
    stream.write("x");
  },
  tickFromThen: (fn) => {
    Promise.resolve().then(() => process.nextTick(fn));
  },
};

for (const [context, run] of Object.entries(contexts)) {
  // One run per context, with the observations made from inside it.
  als.run(`${context}-A`, () => {
    run(() => {
      record(context, "inside", als.getStore());
      new AsyncResource("Inherited").runInAsyncScope(() => {
        record(context, "resource", als.getStore());
      });
      Promise.resolve().then(() => {
        record(context, "thenchild", als.getStore());
      });
      setTimeout(() => record(context, "late", als.getStore()), 1);
      als.run("nested", () => {
        record(context, "nested", als.getStore());
      });
      record(context, "restored", als.getStore());
    });
  });
  record(context, "outside", als.getStore());

  // A second run, started after the first, must never see the first store.
  als.run(`${context}-B`, () => {
    run(() => record(context, "concurrent", als.getStore()));
  });
}

setTimeout(() => {
  cells.sort();
  console.log(cells.join("\n"));
  console.log(`cells=${cells.length}`);
}, 400);
