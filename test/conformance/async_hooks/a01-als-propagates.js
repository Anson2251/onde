// AsyncLocalStorage across the boundaries M6 has to get right: await, then, nextTick,
// queueMicrotask, timers, an fs callback and a stream event.
//
// The output is sorted so it does not depend on completion order; the ids themselves are never
// printed, only the stores.
const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs");
const { PassThrough } = require("stream");

const als = new AsyncLocalStorage();
const lines = [];

function record(name) {
  lines.push(`${name}=${als.getStore()}`);
}

async function afterAwait() {
  await Promise.resolve();
  record("await");
  await new Promise((resolve) => setTimeout(resolve, 1));
  record("await-timer");
}

als.run("A", () => {
  afterAwait();
  Promise.resolve().then(() => record("then"));
  process.nextTick(() => record("tick"));
  queueMicrotask(() => record("microtask"));
  setTimeout(() => record("timeout"), 1);
  fs.readFile(__filename, () => record("fscb"));

  const stream = new PassThrough();
  stream.on("data", () => record("stream"));
  stream.write("x");
});

record("outside");

setTimeout(() => {
  lines.sort();
  console.log(lines.join("\n"));
}, 50);
