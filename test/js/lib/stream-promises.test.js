"use strict";

// Runtime-agnostic self-check for js/lib/stream-promises.js. Runs under `node` and under onde.
// The module under test is required by path so Node also exercises our implementation rather
// than the `stream/promises` builtin.

const { pipeline, finished } = require("../../../js/lib/stream-promises.js");
const { Readable, Writable, PassThrough } = require("../../../js/lib/stream.js");

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

function tick(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds === undefined ? 20 : milliseconds),
  );
}

function collector() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { writable, chunks };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Shape

test("module shape", () => {
  eq(typeof pipeline, "function", "pipeline is exported");
  eq(typeof finished, "function", "finished is exported");
  eq(pipeline.length, 0, "pipeline is variadic");
});

// ---------------------------------------------------------------------------
// pipeline

test("pipeline resolves undefined and delivers chunks", async () => {
  const { writable, chunks } = collector();
  const value = await pipeline(Readable.from(["a", "b"]), new PassThrough(), writable);
  eq(value, undefined, "the promise resolves undefined");
  eq(chunks.join(""), "ab", "every chunk reaches the destination");
});

test("pipeline accepts the array form", async () => {
  const { writable, chunks } = collector();
  const value = await pipeline([Readable.from(["a"]), writable]);
  eq(value, undefined, "the array form resolves undefined");
  eq(chunks.join(""), "a", "the array form pipes data");
});

test("pipeline rejects the first error and destroys the chain", async () => {
  const source = new Readable({ read() {} });
  const dest = new Writable({
    write(chunk, encoding, callback) {
      callback(new Error("dest boom"));
    },
  });
  source.on("error", () => {});
  dest.on("error", () => {});
  const pending = pipeline(source, dest);
  source.push("a");
  let caught = null;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.message, "dest boom", "the destination error rejects");
  eq(source.destroyed, true, "the source is destroyed");
  eq(dest.destroyed, true, "the destination is destroyed");
});

test("pipeline rejects a pre-aborted signal with AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const { writable } = collector();
  let caught = null;
  try {
    await pipeline(Readable.from(["a"]), writable, { signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.name, "AbortError", "the error name is AbortError");
  eq(caught && caught.code, "ABORT_ERR", "the error code is ABORT_ERR");
});

test("pipeline rejects invalid arguments", async () => {
  let caught = null;
  try {
    await pipeline(Readable.from(["solo"]));
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.code, "ERR_MISSING_ARGS", "a one-stream pipeline rejects");
});

// ---------------------------------------------------------------------------
// finished

test("finished resolves undefined after end", async () => {
  const r = Readable.from(["a", "b"]);
  r.resume();
  const value = await finished(r);
  eq(value, undefined, "the promise resolves undefined");
});

test("finished resolves undefined after finish", async () => {
  const w = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const pending = finished(w);
  w.end();
  const value = await pending;
  eq(value, undefined, "the promise resolves undefined");
});

test("finished rejects on stream error", async () => {
  const r = new Readable({ read() {} });
  r.on("error", () => {});
  const pending = finished(r);
  r.destroy(new Error("boom"));
  let caught = null;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.message, "boom", "the stream error rejects");
});

test("finished rejects premature close", async () => {
  const r = new Readable({ read() {} });
  const pending = finished(r);
  r.destroy();
  let caught = null;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.code, "ERR_STREAM_PREMATURE_CLOSE", "an unfinished close rejects");
});

test("finished rejects a pre-aborted signal with AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const r = new Readable({ read() {} });
  r.on("error", () => {});
  let caught = null;
  try {
    await finished(r, { signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.name, "AbortError", "the error name is AbortError");
  eq(caught && caught.code, "ABORT_ERR", "the error code is ABORT_ERR");
});

test("finished rejects when an active signal aborts", async () => {
  const controller = new AbortController();
  const r = new Readable({ read() {} });
  r.on("error", () => {});
  const pending = finished(r, { signal: controller.signal });
  controller.abort();
  let caught = null;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.code, "ABORT_ERR", "aborting the signal rejects");
});

test("finished supports { cleanup: true } and validates it", async () => {
  const r = Readable.from(["a"]);
  r.resume();
  const value = await finished(r, { cleanup: true });
  eq(value, undefined, "cleanup true still resolves");
  let caught = null;
  try {
    await finished(new Readable({ read() {} }), { cleanup: "yes" });
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.name, "TypeError", "a non-boolean cleanup rejects");
  eq(caught && caught.code, "ERR_INVALID_ARG_TYPE", "the validation error is coded");
});

test("finished reports a stream that already ended", async () => {
  const r = Readable.from(["a"]);
  r.resume();
  await tick();
  const value = await finished(r);
  eq(value, undefined, "finished on a completed stream resolves");
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
  log(`stream-promises.test.js: ${passed} passed, ${failed} failed, ${tests.length} tests`);

  if (failed > 0) {
    const proc = globalThis.process;
    if (proc) proc.exitCode = 1;
    else throw new Error(`${failed} stream-promises assertions failed`);
  }
}

run().catch((error) => {
  const proc = globalThis.process;
  if (proc) {
    proc.exitCode = 1;
    try {
      proc.stderr.write(
        `stream-promises.test.js crashed: ${error && error.stack ? error.stack : error}\n`,
      );
    } catch (_) {
      // nothing else we can do
    }
  } else {
    throw error;
  }
});
