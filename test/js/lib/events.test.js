"use strict";

// Runtime-agnostic self-check for js/lib/events.js. Runs under `node` and under
// lite: no `node:` imports, no test framework, only the module under test.

const EventEmitter = require("../../../js/lib/events.js");

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
  record(same, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function throwsValue(fn, expected, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(error === expected, `${message} (threw a different value)`);
    return error;
  }
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
  return new Promise((resolve) => setTimeout(resolve, milliseconds === undefined ? 5 : milliseconds));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Shape

test("module shape", () => {
  eq(typeof EventEmitter, "function", "module exports a constructor");
  eq(EventEmitter.EventEmitter, EventEmitter, "EventEmitter.EventEmitter is the default");
  eq(typeof EventEmitter.errorMonitor, "symbol", "errorMonitor is a symbol");
  eq(typeof EventEmitter.captureRejections, "symbol", "captureRejections is a symbol");
  eq(typeof EventEmitter.captureRejectionSymbol, "symbol", "captureRejectionSymbol is a symbol");
  ok(new EventEmitter() instanceof EventEmitter, "new EventEmitter() constructs");
});

// ---------------------------------------------------------------------------
// on / emit

test("on ordering and emit return value", () => {
  const emitter = new EventEmitter();
  const order = [];
  const seenThis = [];
  function first(...args) {
    order.push("first");
    seenThis.push(this);
    deepEq(args, [1, 2], "listener receives all emit arguments");
  }
  function second() {
    order.push("second");
  }
  eq(emitter.on("x", first), emitter, "on returns the emitter");
  emitter.addListener("x", second);
  eq(emitter.emit("x", 1, 2), true, "emit returns true with listeners");
  deepEq(order, ["first", "second"], "listeners run in registration order");
  eq(seenThis[0], emitter, "listener is called with the emitter as this");
  eq(emitter.emit("missing"), false, "emit returns false without listeners");
  eq(EventEmitter.prototype.addListener, EventEmitter.prototype.on, "addListener aliases on");
});

test("prependListener and prependOnceListener", () => {
  const emitter = new EventEmitter();
  const order = [];
  emitter.on("x", () => order.push("on"));
  emitter.prependListener("x", () => order.push("prepend"));
  emitter.prependOnceListener("x", () => order.push("prependOnce"));
  emitter.emit("x");
  emitter.emit("x");
  deepEq(
    order,
    ["prependOnce", "prepend", "on", "prepend", "on"],
    "prepend and prependOnce run first, once only once"
  );
});

test("once fires once and is removed", () => {
  const emitter = new EventEmitter();
  let calls = 0;
  emitter.once("x", () => {
    calls += 1;
  });
  eq(emitter.listenerCount("x"), 1, "once registers a listener");
  emitter.emit("x");
  emitter.emit("x");
  eq(calls, 1, "once listener runs only once");
  eq(emitter.listenerCount("x"), 0, "once listener removed after firing");
});

test("once wrapper metadata and removal by original listener", () => {
  const emitter = new EventEmitter();
  function original() {}
  emitter.once("x", original);
  const raw = emitter.rawListeners("x");
  eq(raw.length, 1, "rawListeners returns the wrapper");
  ok(raw[0] !== original, "raw listener is not the original function");
  eq(raw[0].listener, original, "wrapper exposes .listener");
  eq(emitter.listeners("x")[0], original, "listeners() unwraps the original");
  emitter.removeListener("x", original);
  eq(emitter.listenerCount("x"), 0, "removing the original removes the wrapper");
});

test("removeListener, off and duplicate listeners", () => {
  const emitter = new EventEmitter();
  const calls = [];
  function a() {
    calls.push("a");
  }
  function b() {
    calls.push("b");
  }
  emitter.on("x", a);
  emitter.on("x", b);
  eq(emitter.removeListener("x", a), emitter, "removeListener returns the emitter");
  eq(emitter.listenerCount("x"), 1, "one listener remains");
  emitter.emit("x");
  deepEq(calls, ["b"], "the removed listener no longer runs");
  eq(emitter.off, EventEmitter.prototype.removeListener, "off aliases removeListener");
  eq(emitter.listenerCount("x", b), 1, "listenerCount filters by listener");

  const duplicates = new EventEmitter();
  const same = () => {};
  duplicates.on("y", same);
  duplicates.on("y", same);
  eq(duplicates.listenerCount("y", same), 2, "duplicate registrations are counted");
  duplicates.removeListener("y", same);
  eq(duplicates.listenerCount("y", same), 1, "removeListener removes one instance");
  duplicates.removeListener("y", same);
  eq(duplicates.listenerCount("y"), 0, "removeListener removes the last instance");
});

test("removal and addition during emit", () => {
  const emitter = new EventEmitter();
  const order = [];
  function second() {
    order.push("second");
  }
  function first() {
    order.push("first");
    emitter.removeListener("x", second);
    emitter.on("x", () => order.push("added"));
  }
  emitter.on("x", first);
  emitter.on("x", second);
  emitter.emit("x");
  // Node snapshots the listener array: a listener removed by an earlier listener still runs in
  // the current emit, and a listener added during it waits for the next emit.
  deepEq(order, ["first", "second"], "removed listener still runs in this emit (Node snapshot)");
  emitter.emit("x");
  deepEq(
    order,
    ["first", "second", "first", "added"],
    "the listener added during the previous emit runs now",
  );
});

test("removeAllListeners during emit does not affect the current snapshot", () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on("x", () => {
    calls.push("first");
    emitter.removeAllListeners("x");
  });
  emitter.on("x", () => calls.push("second"));
  emitter.emit("x");
  deepEq(calls, ["first", "second"], "the snapshot still runs the remaining listeners");
  eq(emitter.listenerCount("x"), 0, "removeAllListeners clears the listener array");
});

test("removeAllListeners", () => {
  const emitter = new EventEmitter();
  const symbolName = Symbol("symbolic");
  emitter.on("a", () => {});
  emitter.on("a", () => {});
  emitter.on("b", () => {});
  emitter.on(symbolName, () => {});
  deepEq(emitter.eventNames(), ["a", "b", symbolName], "eventNames lists strings and symbols");
  eq(emitter.eventNames()[2], symbolName, "eventNames preserves the symbol identity");
  emitter.removeAllListeners("a");
  eq(emitter.listenerCount("a"), 0, "removeAllListeners(name) clears one event");
  eq(emitter.listenerCount("b"), 1, "other events are untouched");
  eq(emitter.removeAllListeners(), emitter, "removeAllListeners returns the emitter");
  deepEq(emitter.eventNames(), [], "removeAllListeners() clears everything");
});

test("removeListener on an unknown event is a no-op", () => {
  const emitter = new EventEmitter();
  eq(emitter.removeListener("nope", () => {}), emitter, "unknown event removal returns the emitter");
  eq(emitter.listenerCount("nope"), 0, "unknown event has no listeners");
});

test("max listeners", () => {
  const emitter = new EventEmitter();
  eq(emitter.getMaxListeners(), 10, "default max listeners is 10");
  eq(emitter.setMaxListeners(3), emitter, "setMaxListeners returns the emitter");
  eq(emitter.getMaxListeners(), 3, "getMaxListeners reflects the setting");
  eq(EventEmitter.getMaxListeners(emitter), 3, "static getMaxListeners delegates");
});

// ---------------------------------------------------------------------------
// error and errorMonitor

test("emit('error') throws without an error listener", () => {
  const emitter = new EventEmitter();
  const error = new Error("boom");
  throwsValue(
    () => emitter.emit("error", error),
    error,
    "the original error is thrown"
  );
  const missing = new EventEmitter();
  const thrown = throwsCode(
    () => missing.emit("error", "not-an-error"),
    "ERR_UNHANDLED_ERROR",
    "non-Error error arguments are wrapped"
  );
  ok(thrown && thrown.message.indexOf("Unhandled error") === 0, "unhandled error has Node's message");
});

test("errorMonitor runs before error listeners", () => {
  const emitter = new EventEmitter();
  const order = [];
  const monitorArgs = [];
  emitter.on(EventEmitter.errorMonitor, (...args) => {
    order.push("monitor");
    monitorArgs.push(args);
  });
  emitter.on("error", () => order.push("error"));
  const error = new Error("watched");
  eq(emitter.emit("error", error), true, "error emit returns true with listeners");
  deepEq(order, ["monitor", "error"], "errorMonitor runs before the error listener");
  eq(monitorArgs[0][0], error, "errorMonitor receives the error");

  const monitorOnly = new EventEmitter();
  monitorOnly.on(EventEmitter.errorMonitor, () => {});
  let monitorThrew = false;
  try {
    monitorOnly.emit("error", new Error("still-unhandled"));
  } catch (_) {
    monitorThrew = true;
  }
  ok(monitorThrew, "errorMonitor alone does not handle the error");
});

test("errorMonitor does not run for non-error events", () => {
  const emitter = new EventEmitter();
  let called = 0;
  emitter.on(EventEmitter.errorMonitor, () => {
    called += 1;
  });
  emitter.emit("x", 1);
  eq(called, 0, "errorMonitor ignores non-error events");
});

// ---------------------------------------------------------------------------
// captureRejections

test("captureRejections delivers thenable rejections asynchronously", async () => {
  const emitter = new EventEmitter({ captureRejections: true });
  const seen = [];
  emitter.on("error", (error) => seen.push(error.message));
  emitter.on("x", () => ({
    then(resolve, reject) {
      reject(new Error("thenable-rejection"));
    },
  }));
  eq(emitter.emit("x"), true, "emit with a thenable listener returns true");
  eq(seen.length, 0, "captured rejection is not delivered synchronously");
  await tick();
  deepEq(seen, ["thenable-rejection"], "rejection reason is emitted as error");
});

test("captureRejections off by default", async () => {
  const emitter = new EventEmitter();
  const seen = [];
  emitter.on("error", (error) => seen.push(error.message));
  emitter.on("x", () => ({
    then(resolve, reject) {
      reject(new Error("ignored"));
    },
  }));
  emitter.emit("x");
  await tick();
  deepEq(seen, [], "rejections are ignored when captureRejections is off");
});

test("captureRejections flag can be set through the static symbol", async () => {
  const emitter = new EventEmitter();
  emitter[EventEmitter.captureRejections] = true;
  const seen = [];
  emitter.on("error", (error) => seen.push(error.message));
  emitter.on("x", () => ({
    then(resolve, reject) {
      reject(new Error("flagged"));
    },
  }));
  emitter.emit("x");
  await tick();
  deepEq(seen, ["flagged"], "per-emitter symbol flag enables capture");
});

test("captureRejectionSymbol installs a custom handler", async () => {
  const emitter = new EventEmitter({ captureRejections: true });
  const seen = [];
  emitter[EventEmitter.captureRejectionSymbol] = (error, type, ...args) => {
    seen.push([error.message, type, args]);
  };
  emitter.on("x", () => ({
    then(resolve, reject) {
      reject(new Error("custom"));
    },
  }));
  emitter.emit("x", 7);
  await tick();
  deepEq(seen, [["custom", "x", [7]]], "custom rejection handler receives (err, event, ...args)");
});

test("captureRejections handles a real rejected Promise", async () => {
  const emitter = new EventEmitter({ captureRejections: true });
  const seen = [];
  emitter.on("error", (error) => seen.push(error.message));
  emitter.on("x", async () => {
    throw new Error("async-rejection");
  });
  emitter.emit("x");
  await tick();
  deepEq(seen, ["async-rejection"], "async listener rejections are captured");
});

// ---------------------------------------------------------------------------
// events.once

test("events.once resolves with the emitted arguments and cleans up", async () => {
  const emitter = new EventEmitter();
  const promise = EventEmitter.once(emitter, "ready");
  setTimeout(() => emitter.emit("ready", "a", 2), 0);
  const args = await promise;
  deepEq(args, ["a", 2], "once resolves with an args array");
  eq(emitter.listenerCount("ready"), 0, "once removes its event listener");
  eq(emitter.listenerCount("error"), 0, "once removes its error listener");
});

test("events.once rejects on the error event", async () => {
  const emitter = new EventEmitter();
  const promise = EventEmitter.once(emitter, "ready");
  const failure = new Error("early-error");
  emitter.emit("error", failure);
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  eq(caught, failure, "once rejects with the emitted error");
  eq(emitter.listenerCount("ready"), 0, "rejection removes the event listener");
});

test("events.once resolves for the error event itself", async () => {
  const emitter = new EventEmitter();
  const promise = EventEmitter.once(emitter, "error");
  const failure = new Error("observed");
  emitter.emit("error", failure);
  const args = await promise;
  eq(args[0], failure, "awaiting 'error' resolves with the error");
});

test("events.once rejects with AbortError on abort", async () => {
  if (typeof AbortController !== "function") return;
  const controller = new AbortController();
  const emitter = new EventEmitter();
  const promise = EventEmitter.once(emitter, "ready", { signal: controller.signal });
  const guarded = promise.catch((error) => error);
  controller.abort();
  const error = await guarded;
  eq(error.name, "AbortError", "once abort rejects with AbortError");
  eq(error.code, "ABORT_ERR", "once abort error has ABORT_ERR code");
  eq(emitter.listenerCount("ready"), 0, "abort removes the event listener");
});

test("events.once with a pre-aborted signal rejects immediately", async () => {
  if (typeof AbortController !== "function") return;
  const controller = new AbortController();
  controller.abort();
  let caught;
  try {
    await EventEmitter.once(new EventEmitter(), "ready", { signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.name, "AbortError", "pre-aborted once rejects with AbortError");
});

// ---------------------------------------------------------------------------
// events.on

test("events.on yields emitted argument arrays", async () => {
  const emitter = new EventEmitter();
  const iterator = EventEmitter.on(emitter, "data");
  eq(typeof iterator[Symbol.asyncIterator], "function", "iterator is async iterable");
  eq(iterator[Symbol.asyncIterator](), iterator, "asyncIterator returns itself");
  const pending = iterator.next();
  emitter.emit("data", 1, 2);
  const first = await pending;
  deepEq(first, { value: [1, 2], done: false }, "next resolves with the emitted args");
  emitter.emit("data", 3);
  deepEq(await iterator.next(), { value: [3], done: false }, "already-emitted events are queued");
  await iterator.return();
  const done = await iterator.next();
  ok(done.done === true && done.value === undefined, "after return(), next resolves done");
  eq(emitter.listenerCount("data"), 0, "return() removes the listeners");
});

test("events.on rejects on the error event", async () => {
  const emitter = new EventEmitter();
  const iterator = EventEmitter.on(emitter, "data");
  const failure = new Error("iterator-error");
  const pending = iterator.next();
  emitter.emit("error", failure);
  let caught;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught, failure, "pending next rejects with the error event's argument");
  const done = await iterator.next();
  ok(done.done === true, "iteration is finished after an error");
});

test("events.on throw() rejects the pending next()", async () => {
  const emitter = new EventEmitter();
  const iterator = EventEmitter.on(emitter, "data");
  const pending = iterator.next();
  const failure = new Error("thrown");
  iterator.throw(failure);
  let caught;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught, failure, "throw() delivers the error to the iterator");
});

test("events.on rejects with AbortError on abort", async () => {
  if (typeof AbortController !== "function") return;
  const controller = new AbortController();
  const emitter = new EventEmitter();
  const iterator = EventEmitter.on(emitter, "data", { signal: controller.signal });
  const pending = iterator.next();
  controller.abort();
  let caught;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  eq(caught && caught.name, "AbortError", "on abort rejects with AbortError");
  eq(emitter.listenerCount("data"), 0, "abort removes the event listener");
});

// ---------------------------------------------------------------------------
// subclassing

test("subclassing with EventEmitter.call and class extends", () => {
  function Legacy() {
    EventEmitter.call(this);
    this.label = "legacy";
  }
  Object.setPrototypeOf(Legacy.prototype, EventEmitter.prototype);
  Legacy.prototype.constructor = Legacy;
  const legacy = new Legacy();
  let legacyCalls = 0;
  legacy.on("x", () => {
    legacyCalls += 1;
  });
  legacy.emit("x");
  eq(legacyCalls, 1, "EventEmitter.call(this) initialises a function-style subclass");
  ok(legacy instanceof EventEmitter, "function-style subclass is an EventEmitter");

  class Modern extends EventEmitter {
    constructor() {
      super();
      this.label = "modern";
    }
  }
  const modern = new Modern();
  let modernCalls = 0;
  modern.once("y", () => {
    modernCalls += 1;
  });
  modern.emit("y");
  eq(modernCalls, 1, "class extends EventEmitter works");
  eq(modern.label, "modern", "subclass fields survive initialisation");
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
  const log = consoleObject && typeof consoleObject.log === "function"
    ? consoleObject.log.bind(consoleObject)
    : function print(line) {
        globalThis.__ln_print ? globalThis.__ln_print(line) : null;
      };

  if (failures.length > 0) {
    for (let i = 0; i < failures.length; i += 1) log(`not ok - ${failures[i]}`);
  }
  log(`events.test.js: ${passed} passed, ${failed} failed, ${tests.length} tests`);

  if (failed > 0) {
    const proc = globalThis.process;
    if (proc) proc.exitCode = 1;
    else throw new Error(`${failed} events assertions failed`);
  }
}

run().catch((error) => {
  const proc = globalThis.process;
  if (proc) {
    proc.exitCode = 1;
    try {
      proc.stderr.write(`events.test.js crashed: ${error && error.stack ? error.stack : error}\n`);
    } catch (_) {
      // nothing else we can do
    }
  } else {
    throw error;
  }
});
