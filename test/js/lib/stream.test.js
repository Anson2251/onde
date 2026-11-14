"use strict";

// Runtime-agnostic self-check for js/lib/stream.js. Runs under `node` and under lite:
// no `node:` imports, no test framework, only the module under test.
//
// Every wait is a short timer; the assertions below never depend on wall-clock precision.

const {
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
  addAbortSignal,
  isReadable,
  isWritable,
  isDestroyed,
} = require("../../../js/lib/stream.js");

let passed = 0;
let failed = 0;
const failures = [];

function record(condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(detail);
  }
}

function ok(value, message) {
  record(Boolean(value), `${message} (expected truthy, got ${String(value)})`);
}

function eq(actual, expected, message) {
  record(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function deepEq(actual, expected, message) {
  let same;
  try {
    same = JSON.stringify(actual) === JSON.stringify(expected);
  } catch (_) {
    same = false;
  }
  record(
    same,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function throwsCode(fn, code, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(error && error.code === code, `${message} (code was ${error && error.code})`);
    return error;
  }
}

function tick(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds === undefined ? 10 : milliseconds),
  );
}

function text(chunk) {
  return String(chunk);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Shape

test("module shape", () => {
  eq(typeof Stream, "function", "Stream is exported");
  eq(Stream.Stream, Stream, "Stream.Stream points at itself");
  eq(typeof Readable, "function", "Readable is a constructor");
  eq(typeof Writable, "function", "Writable is a constructor");
  eq(typeof Duplex, "function", "Duplex is a constructor");
  eq(typeof Transform, "function", "Transform is a constructor");
  eq(typeof PassThrough, "function", "PassThrough is a constructor");
  eq(typeof pipeline, "function", "pipeline is exported");
  eq(typeof finished, "function", "finished is exported");
  eq(typeof addAbortSignal, "function", "addAbortSignal is exported");
  const readable = new Readable({ read() {} });
  const writable = new Writable({ write(chunk, encoding, cb) { cb(); } });
  ok(readable instanceof Stream, "Readable extends Stream");
  ok(writable instanceof Stream, "Writable extends Stream");
  ok(new Duplex({ read() {}, write(c, e, cb) { cb(); } }) instanceof Readable, "Duplex extends Readable");
  ok(new Transform({ transform(c, e, cb) { cb(); } }) instanceof Duplex, "Transform extends Duplex");
  ok(new PassThrough() instanceof Transform, "PassThrough extends Transform");
  eq(typeof readable.pipe, "function", "Readable has pipe");
  eq(readable.readableObjectMode, false, "byte streams are not objectMode");
});

// ---------------------------------------------------------------------------
// Readable

test("Readable pull mode: push, read(n) and EOF", () => {
  const r = new Readable({ read() {} });
  eq(r.read(), null, "read() on an empty stream returns null");
  eq(r.push("hello"), true, "push returns true below the high-water mark");
  eq(r.readableLength, 5, "readableLength counts bytes");
  eq(text(r.read(2)), "he", "read(2) returns a prefix");
  eq(r.readableLength, 3, "read(2) consumes two bytes");
  eq(text(r.read()), "llo", "read() returns the rest of the buffered chunk");
  eq(r.readableLength, 0, "the buffer is empty");
  eq(r.read(), null, "read() at the end returns null");
  eq(r.push(null), false, "push(null) returns false");
  eq(r.readableEnded, false, "end is emitted on a later tick");
});

test("Readable: data, end and close order", async () => {
  const r = new Readable({ read() {} });
  const events = [];
  r.on("data", (chunk) => events.push(`data:${text(chunk)}`));
  r.on("end", () => events.push("end"));
  r.on("close", () => events.push("close"));
  r.push("a");
  r.push("b");
  r.push(null);
  await tick(20);
  deepEq(events, ["data:a", "data:b", "end", "close"], "data then end then close");
  eq(r.readableEnded, true, "readableEnded after end");
  eq(r.destroyed, true, "autoDestroy destroys after end");
  eq(r.closed, true, "closed after close");
});

test("Readable flowing re-arms _read after an async push", async () => {
  // Regression: a push from an asynchronous _read used to deliver one "data" chunk and then
  // stall, because nothing re-entered _read once the flow loop had already returned null.
  let issued = 0;
  const lengths = [];
  let ended = false;
  const r = new Readable({
    read() {
      if (issued < 5) {
        const id = issued;
        issued += 1;
        queueMicrotask(() => r.push(`${id}`.repeat(100)));
      } else {
        queueMicrotask(() => r.push(null));
      }
    },
  });
  r.on("data", (chunk) => lengths.push(chunk.length));
  r.on("end", () => {
    ended = true;
  });
  await tick(50);
  eq(lengths.length, 5, "every asynchronously pushed chunk is delivered");
  eq(lengths.reduce((sum, length) => sum + length, 0), 500, "no chunk is dropped or duplicated");
  eq(ended, true, "the stream reaches end");
});

test("Readable objectMode accepts falsy values", async () => {
  const r = new Readable({ objectMode: true, read() {} });
  const values = [];
  r.on("data", (chunk) => values.push(chunk));
  r.push(0);
  r.push(false);
  r.push("");
  r.push(null);
  await tick(20);
  deepEq(values, [0, false, ""], "zero, false and the empty string are real chunks");
});

test("Readable setEncoding decodes split multi-byte input", async () => {
  const r = new Readable({ read() {} });
  const values = [];
  r.setEncoding("utf8");
  eq(r.readableEncoding, "utf8", "readableEncoding is reported");
  r.on("data", (chunk) => values.push(chunk));
  const bytes = Buffer.from("héllo");
  r.push(bytes.subarray(0, 2));
  r.push(bytes.subarray(2));
  r.push(null);
  await tick(20);
  deepEq(values, ["h", "éllo"], "the decoder emits what it can and holds the partial code point");
});

test("Readable high-water mark backpressure", () => {
  const r = new Readable({ highWaterMark: 4, read() {} });
  eq(r.push("ab"), true, "below the mark accepts more");
  eq(r.push("cd"), false, "at the mark reports backpressure");
  eq(r.push("e"), false, "over the mark reports backpressure");
  eq(r.readableHighWaterMark, 4, "readableHighWaterMark is the configured value");
  eq(r.readableLength, 5, "the excess chunk is still buffered");
});

test("Readable pause and resume", async () => {
  const r = new Readable({ read() {} });
  const events = [];
  r.on("data", (chunk) => {
    events.push(text(chunk));
    if (text(chunk) === "b") r.pause();
  });
  r.on("pause", () => events.push("pause"));
  r.on("resume", () => events.push("resume"));
  r.push("a");
  r.push("b");
  r.push("c");
  await tick(20);
  eq(r.isPaused(), true, "pause() pauses the stream");
  eq(r.readableFlowing, false, "readableFlowing is false while paused");
  r.resume();
  await tick(20);
  eq(r.readableFlowing, true, "resume() restarts flowing");
  deepEq(events, ["resume", "a", "b", "pause", "resume", "c"], "paused data is delivered after resume");
});

test("Readable unshift puts a chunk back", async () => {
  const r = new Readable({ read() {} });
  const values = [];
  r.on("readable", () => {
    let chunk;
    while ((chunk = r.read()) !== null) values.push(text(chunk));
  });
  r.push("bb");
  r.unshift("aa");
  r.push(null);
  await tick(20);
  deepEq(values, ["aa", "bb"], "unshifted chunk is read first");
});

test("Readable readable event pull loop", async () => {
  const r = new Readable({ read() {} });
  const values = [];
  r.on("readable", () => {
    let chunk;
    while ((chunk = r.read()) !== null) values.push(text(chunk));
  });
  r.push("a");
  r.push("b");
  r.push(null);
  await tick(20);
  deepEq(values, ["a", "b"], "readable fires for buffered chunks");
  eq(r.readableEnded, true, "the stream ends after the buffer drains");
});

test("Readable.from over arrays, strings and options", async () => {
  const objects = Readable.from([1, "two", { three: 3 }]);
  const seen = [];
  objects.on("data", (chunk) => seen.push(typeof chunk));
  await tick(10);
  deepEq(seen, ["number", "string", "object"], "array values keep their type and objectMode");
  eq(objects.readableObjectMode, true, "Readable.from defaults to objectMode");
  eq(objects.destroyed, true, "the stream is destroyed after it ends");

  const bytes = Readable.from(["a", "b"], { objectMode: false });
  const chunks = [];
  bytes.on("data", (chunk) => chunks.push(text(chunk)));
  await tick(10);
  deepEq(chunks, ["a", "b"], "objectMode false yields byte chunks");

  const string = Readable.from("abc");
  const single = [];
  string.on("data", (chunk) => single.push(text(chunk)));
  await tick(10);
  deepEq(single, ["abc"], "a string is one chunk, not three characters");

  const empty = Readable.from([]);
  let emptyEnded = false;
  empty.on("end", () => {
    emptyEnded = true;
  });
  empty.resume();
  await tick(10);
  eq(emptyEnded, true, "an empty iterable ends immediately");
});

test("Readable.from over an async iterable", async () => {
  async function* generate() {
    yield "a";
    yield "b";
    yield "c";
  }
  const r = Readable.from(generate());
  const values = [];
  r.on("data", (chunk) => values.push(text(chunk)));
  await tick(20);
  deepEq(values, ["a", "b", "c"], "every awaited value is emitted");
  eq(r.readableEnded, true, "the async iterable ends the stream");
});

test("Readable.from rejects a null yielded value", async () => {
  async function* generate() {
    yield "a";
    yield null;
  }
  const r = Readable.from(generate());
  let error = null;
  r.on("error", (err) => {
    error = err;
  });
  r.resume();
  await tick(20);
  eq(error && error.code, "ERR_STREAM_NULL_VALUES", "null is not a valid chunk");
});

// ---------------------------------------------------------------------------
// Async iteration

test("async iteration over a Readable", async () => {
  const r = Readable.from([1, 2, 3]);
  const values = [];
  for await (const value of r) values.push(value);
  deepEq(values, [1, 2, 3], "for await yields every chunk");
  eq(r.destroyed, true, "the stream auto-destroys after iteration");
});

test("async iteration early break destroys the stream", async () => {
  const r = Readable.from([1, 2, 3, 4]);
  for await (const value of r) {
    if (value === 2) break;
  }
  eq(r.destroyed, true, "break closes the iterator and destroys the stream");
});

test("async iteration surfaces stream errors", async () => {
  const r = new Readable({ read() {} });
  setTimeout(() => r.destroy(new Error("iter boom")), 1);
  let caught = null;
  try {
    for await (const value of r) {
      void value;
    }
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.message, "iter boom", "the error rejects the loop");
  eq(r.destroyed, true, "the stream is destroyed");
});

// ---------------------------------------------------------------------------
// Writable

test("Writable writes, callbacks and finish", async () => {
  const events = [];
  const w = new Writable({
    write(chunk, encoding, cb) {
      events.push(`write:${text(chunk)}:${encoding}`);
      cb();
    },
  });
  w.on("finish", () => events.push("finish"));
  w.on("close", () => events.push("close"));
  eq(w.write("a", () => events.push("cb:a")), true, "a small write returns true");
  w.end(() => events.push("end-cb"));
  await tick(20);
  deepEq(
    events,
    ["write:a:buffer", "cb:a", "end-cb", "finish", "close"],
    "write, callback, end callback, finish, close",
  );
  eq(w.writableFinished, true, "writableFinished after finish");
  eq(w.destroyed, true, "autoDestroy destroys after finish");
});

test("Writable backpressure emits drain", async () => {
  const w = new Writable({
    highWaterMark: 4,
    write(chunk, encoding, cb) {
      setTimeout(cb, 2);
    },
  });
  let drained = false;
  w.on("drain", () => {
    drained = true;
  });
  eq(w.write("aa"), true, "the first write fits");
  eq(w.write("bb"), false, "the second write hits the mark");
  eq(w.writableNeedDrain, true, "writableNeedDrain is set");
  await tick(20);
  eq(drained, true, "drain fires once the queue empties");
  eq(w.writableNeedDrain, false, "writableNeedDrain clears");
});

test("Writable write after end", async () => {
  const w = new Writable({ write(chunk, encoding, cb) { cb(); } });
  let callbackError = null;
  let emittedError = null;
  w.on("error", (err) => {
    emittedError = err;
  });
  w.end();
  eq(w.write("x", (err) => {
    callbackError = err;
  }), false, "write after end returns false");
  await tick(20);
  eq(callbackError && callbackError.code, "ERR_STREAM_WRITE_AFTER_END", "the callback gets the error");
  eq(emittedError && emittedError.code, "ERR_STREAM_WRITE_AFTER_END", "the error is emitted");
});

test("Writable rejects null chunks", () => {
  const w = new Writable({ write(chunk, encoding, cb) { cb(); } });
  throwsCode(() => w.write(null), "ERR_STREAM_NULL_VALUES", "a null chunk throws");
  throwsCode(() => w.write(1), "ERR_INVALID_ARG_TYPE", "a non-chunk value throws");
});

test("Writable cork, uncork and writev", async () => {
  const events = [];
  const w = new Writable({
    write(chunk, encoding, cb) {
      events.push(`write:${text(chunk)}`);
      cb();
    },
    writev(chunks, cb) {
      events.push(`writev:${chunks.map((entry) => text(entry.chunk)).join(",")}`);
      cb();
    },
  });
  w.cork();
  w.write("a");
  w.write("b");
  eq(w.writableCorked, 1, "cork is counted");
  w.uncork();
  w.write("c");
  w.end();
  await tick(20);
  deepEq(events, ["writev:a,b", "write:c"], "buffered writes are batched through writev");
});

test("Writable objectMode and _final", async () => {
  const events = [];
  const w = new Writable({
    objectMode: true,
    write(chunk, encoding, cb) {
      events.push(`write:${typeof chunk}`);
      cb();
    },
    final(cb) {
      events.push("final");
      cb();
    },
  });
  w.write({ a: 1 });
  w.write("text");
  w.end();
  await tick(20);
  deepEq(events, ["write:object", "write:string", "final"], "objectMode writes and _final run in order");
  eq(w.writableFinished, true, "finish follows _final");
});

test("Writable destroy is idempotent and emits one close", async () => {
  const w = new Writable({ write(chunk, encoding, cb) { cb(); } });
  const events = [];
  w.on("error", (err) => events.push(`error:${err.message}`));
  w.on("close", () => events.push("close"));
  w.destroy(new Error("boom"));
  eq(w.destroyed, true, "destroy sets destroyed");
  w.destroy();
  await tick(20);
  deepEq(events, ["error:boom", "close"], "one error and one close");
  eq(w.closed, true, "closed after the close event");
});

// ---------------------------------------------------------------------------
// Duplex / Transform / PassThrough

test("Duplex allowHalfOpen keeps the readable side open", async () => {
  const d = new Duplex({
    read() {},
    write(chunk, encoding, cb) { cb(); },
  });
  const events = [];
  d.on("finish", () => events.push("finish"));
  d.on("end", () => events.push("end"));
  d.end();
  await tick(10);
  deepEq(events, ["finish"], "the writable side finishes while the readable side stays open");
  d.push("tail");
  d.push(null);
  d.resume();
  await tick(20);
  deepEq(events, ["finish", "end"], "the readable side ends when it is pushed to");
});

test("Duplex allowHalfOpen false ends the readable side", async () => {
  const d = new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk, encoding, cb) { cb(); },
  });
  const events = [];
  d.on("finish", () => events.push("finish"));
  d.on("end", () => events.push("end"));
  d.resume();
  d.end();
  await tick(20);
  deepEq(events, ["finish"], "ending the writable side does not end the readable side");
  d.push(null);
  await tick(20);
  deepEq(events, ["finish", "end"], "the readable side ends when it is pushed to");
});

test("Transform maps chunks and orders end before finish", async () => {
  const t = new Transform({
    transform(chunk, encoding, cb) {
      cb(null, text(chunk).toUpperCase());
    },
  });
  const events = [];
  t.on("data", (chunk) => events.push(`data:${text(chunk)}`));
  t.on("end", () => events.push("end"));
  t.on("finish", () => events.push("finish"));
  t.write("a");
  t.write("b");
  t.end();
  await tick(20);
  deepEq(events, ["data:A", "data:B", "end", "finish"], "the readable end precedes finish");
});

test("Transform _flush appends output before end", async () => {
  const t = new Transform({
    transform(chunk, encoding, cb) {
      cb(null, text(chunk));
    },
    flush(cb) {
      cb(null, "!");
    },
  });
  const events = [];
  t.on("data", (chunk) => events.push(`data:${text(chunk)}`));
  t.on("end", () => events.push("end"));
  t.on("finish", () => events.push("finish"));
  t.end("ab");
  await tick(20);
  deepEq(events, ["data:ab", "data:!", "end", "finish"], "flush output lands before end");
});

test("Transform error destroys the stream", async () => {
  const t = new Transform({
    transform(chunk, encoding, cb) {
      cb(new Error("transform boom"));
    },
  });
  const events = [];
  t.on("error", (err) => events.push(`error:${err.message}`));
  t.on("close", () => events.push("close"));
  t.write("a");
  await tick(20);
  deepEq(events, ["error:transform boom", "close"], "the transform error is emitted then close");
  eq(t.destroyed, true, "the stream is destroyed");
});

test("PassThrough passes chunks through", async () => {
  const pt = new PassThrough();
  const events = [];
  pt.on("data", (chunk) => events.push(`data:${text(chunk)}`));
  pt.on("end", () => events.push("end"));
  pt.on("finish", () => events.push("finish"));
  pt.write("a");
  pt.end("b");
  await tick(20);
  deepEq(events, ["data:a", "data:b", "end", "finish"], "chunks pass through in order");
});

// ---------------------------------------------------------------------------
// pipe / pipeline

test("pipe links data and lifecycle events", async () => {
  const r = new Readable({ read() {} });
  const seen = [];
  const w = new Writable({
    write(chunk, encoding, cb) {
      seen.push(text(chunk));
      cb();
    },
  });
  const events = [];
  w.on("pipe", (source) => events.push(`pipe:${source === r}`));
  w.on("unpipe", (source) => events.push(`unpipe:${source === r}`));
  w.on("finish", () => events.push(`finish:${seen.join(",")}`));
  eq(r.pipe(w), w, "pipe returns the destination");
  r.push("a");
  r.push("b");
  r.push(null);
  await tick(20);
  deepEq(events, ["pipe:true", "finish:a,b", "unpipe:true"], "pipe/finish/unpipe lifecycle");
});

test("pipe with end false leaves the destination open", async () => {
  const r = new Readable({ read() {} });
  const w = new Writable({ write(chunk, encoding, cb) { cb(); } });
  let finishedEarly = false;
  w.on("finish", () => {
    finishedEarly = true;
  });
  r.pipe(w, { end: false });
  r.push("a");
  r.push(null);
  await tick(20);
  eq(finishedEarly, false, "the destination is not ended");
  w.end();
  await tick(20);
  eq(finishedEarly, true, "an explicit end finishes it");
});

test("pipeline runs a chain and returns the destination", async () => {
  const source = Readable.from(["x", "y"]);
  const middle = new PassThrough();
  const output = [];
  const dest = new Writable({
    write(chunk, encoding, cb) {
      output.push(text(chunk));
      cb();
    },
  });
  const returned = pipeline(source, middle, dest, () => {});
  eq(returned, dest, "pipeline returns the last stream");
  await tick(20);
  deepEq(output, ["x", "y"], "every chunk reaches the destination");
});

test("pipeline accepts the array form", async () => {
  const output = [];
  const dest = new Writable({
    write(chunk, encoding, cb) {
      output.push(text(chunk));
      cb();
    },
  });
  let callbackError = "unset";
  pipeline([Readable.from(["a"]), dest], (err) => {
    callbackError = err;
  });
  await tick(20);
  deepEq(output, ["a"], "array form pipes data");
  eq(callbackError, undefined, "the callback receives no error");
});

test("pipeline reports the first error and destroys the chain", async () => {
  const source = new Readable({ read() {} });
  const dest = new Writable({
    write(chunk, encoding, cb) {
      cb(new Error("dest boom"));
    },
  });
  source.on("error", () => {});
  dest.on("error", () => {});
  let callbackError = null;
  pipeline(source, dest, (err) => {
    callbackError = err;
  });
  source.push("a");
  await tick(20);
  eq(callbackError && callbackError.message, "dest boom", "the destination error reaches the callback");
  eq(source.destroyed, true, "the source is destroyed");
  eq(dest.destroyed, true, "the destination is destroyed");
});

test("pipeline validates its arguments", () => {
  throwsCode(() => pipeline(Readable.from(["solo"]), () => {}), "ERR_MISSING_ARGS", "one stream is not enough");
});

// ---------------------------------------------------------------------------
// finished / addAbortSignal

test("finished reports success, errors and premature close", async () => {
  const clean = new Readable({ read() {} });
  let cleanError = "unset";
  finished(clean, (err) => {
    cleanError = err;
  });
  clean.resume();
  clean.push(null);

  const failing = new Readable({ read() {} });
  failing.on("error", () => {});
  let failingError = null;
  finished(failing, (err) => {
    failingError = err;
  });
  failing.destroy(new Error("x"));

  const premature = new Readable({ read() {} });
  let prematureError = null;
  finished(premature, (err) => {
    prematureError = err;
  });
  premature.destroy();

  await tick(30);
  eq(cleanError, undefined, "a clean end resolves with no error");
  eq(failingError && failingError.message, "x", "an error is reported");
  eq(prematureError && prematureError.code, "ERR_STREAM_PREMATURE_CLOSE", "an unfinished close is premature");
});

test("finished cleanup prevents the callback", async () => {
  const r = new Readable({ read() {} });
  let calls = 0;
  const cleanup = finished(r, () => {
    calls += 1;
  });
  eq(typeof cleanup, "function", "finished returns a cleanup function");
  cleanup();
  r.push(null);
  r.resume();
  await tick(20);
  eq(calls, 0, "the callback never runs");
});

test("finished rejects a pre-aborted signal with AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const r = new Readable({ read() {} });
  r.on("error", () => {});
  let caught = null;
  finished(r, { signal: controller.signal }, (err) => {
    caught = err;
  });
  await tick(20);
  eq(caught && caught.name, "AbortError", "the error name is AbortError");
  eq(caught && caught.code, "ABORT_ERR", "the error code is ABORT_ERR");
});

test("finished honours { error: false } like Node", async () => {
  const r = new Readable({ read() {} });
  r.on("error", () => {});
  let seen = "unset";
  finished(r, { error: false }, (err) => {
    seen = err;
  });
  r.destroy(new Error("nope"));
  await tick(20);
  // Node skips the error *listener* but still reports the stream's errored state from close.
  eq(seen && seen.message, "nope", "the destroyed stream's error is still reported");
});

test("addAbortSignal destroys with ABORT_ERR", async () => {
  const controller = new AbortController();
  const r = new Readable({ read() {} });
  addAbortSignal(controller.signal, r);
  let seen = null;
  r.on("error", (err) => {
    seen = err;
  });
  controller.abort();
  eq(r.destroyed, true, "abort destroys synchronously");
  await tick(20);
  eq(seen && seen.name, "AbortError", "the error name is AbortError");
  eq(seen && seen.code, "ABORT_ERR", "the error code is ABORT_ERR");
});

// ---------------------------------------------------------------------------
// Predicates / getters

test("predicates and destroy getters", async () => {
  const r = new Readable({ read() {} });
  const w = new Writable({ write(chunk, encoding, cb) { cb(); } });
  eq(isReadable(r), true, "a Readable is readable");
  eq(isWritable(r), null, "a Readable has no writable side");
  eq(isReadable(w), null, "a Writable has no readable side");
  eq(isWritable(w), true, "a Writable is writable");
  eq(isDestroyed(r), false, "a fresh stream is not destroyed");
  eq(r.readableFlowing, null, "readableFlowing starts null");
  r.resume();
  eq(r.readableFlowing, true, "resume makes it flow");
  r.pause();
  eq(r.readableFlowing, false, "pause stops flowing");
  r.destroy();
  w.destroy();
  eq(isDestroyed(r), true, "destroy is visible");
  eq(r.readable, false, "a destroyed stream is not readable");
  await tick(10);
  eq(r.closed, true, "close follows destroy");
  eq(w.closed, true, "close follows destroy on the writable side");
});

// ---------------------------------------------------------------------------
// runner

async function run() {
  for (let i = 0; i < tests.length; i += 1) {
    const current = tests[i];
    try {
      await current.fn();
    } catch (error) {
      failed += 1;
      failures.push(`${current.name} threw: ${error && error.stack ? error.stack : error}`);
    }
  }

  const consoleObject = globalThis.console;
  const log =
    consoleObject && typeof consoleObject.log === "function"
      ? consoleObject.log.bind(consoleObject)
      : function print(line) {
          globalThis.__ln_print ? globalThis.__ln_print(line) : null;
        };

  if (failures.length > 0) {
    for (let i = 0; i < failures.length; i += 1) log(`not ok - ${failures[i]}`);
  }
  log(`stream.test.js: ${passed} passed, ${failed} failed, ${tests.length} tests`);

  if (failed > 0) {
    const proc = globalThis.process;
    if (proc) proc.exitCode = 1;
    else throw new Error(`${failed} stream assertions failed`);
  }
}

run().catch((error) => {
  const proc = globalThis.process;
  if (proc) {
    proc.exitCode = 1;
    try {
      proc.stderr.write(`stream.test.js crashed: ${error && error.stack ? error.stack : error}\n`);
    } catch (_) {
      // nothing else we can do
    }
  } else {
    throw error;
  }
});
