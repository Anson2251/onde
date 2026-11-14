"use strict";

// Node-only differential test: js/lib/events.js against `node:events`.
//
// Run with: node test/js/lib/events.oracle.js
// (Only executed when the Node oracle is available; lite runs *.test.js.)

const assert = require("node:assert");
const nodeEvents = require("node:events");
const liteEvents = require("../../../js/lib/events.js");

function listenerNames(list) {
  return list.map((listener) => {
    if (listener && typeof listener.listener === "function") return `once:${listener.listener.name}`;
    return listener.name;
  });
}

function captureThrow(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function baseScenario(E) {
  const emitter = new E();
  const order = [];
  const args = [];
  function first(...values) {
    order.push("first");
    args.push(values);
  }
  function second() {
    order.push("second");
  }
  emitter.on("x", first);
  emitter.prependListener("x", () => order.push("prepended"));
  emitter.once("x", () => order.push("once"));
  emitter.addListener("x", second);

  const returns = [emitter.emit("x", 1, 2), emitter.emit("x", 3), emitter.emit("missing")];
  return {
    order,
    args,
    returns,
    listenerCount: emitter.listenerCount("x"),
    eventNames: emitter.eventNames(),
    listeners: listenerNames(emitter.listeners("x")),
    rawListeners: listenerNames(emitter.rawListeners("x")),
  };
}

function removalScenario(E) {
  const emitter = new E();
  const calls = [];
  function alpha() {
    calls.push("alpha");
  }
  function beta() {
    calls.push("beta");
  }
  emitter.on("x", alpha);
  emitter.on("x", beta);
  emitter.on("x", alpha);

  emitter.removeListener("x", alpha);
  const afterOne = {
    count: emitter.listenerCount("x"),
    alpha: emitter.listenerCount("x", alpha),
    raw: listenerNames(emitter.rawListeners("x")),
  };
  emitter.emit("x");
  emitter.removeAllListeners("x");

  return {
    afterOne,
    calls,
    offIsRemoveListener: emitter.off === E.prototype.removeListener,
    afterAll: emitter.eventNames(),
  };
}

function onceScenario(E) {
  const emitter = new E();
  function handler() {}
  emitter.once("x", handler);
  const raw = emitter.rawListeners("x");
  const result = {
    rawLength: raw.length,
    wrapper: raw[0] !== handler,
    wrapperListener: raw[0].listener === handler,
    listenersUnwrap: emitter.listeners("x")[0] === handler,
    rawName: raw[0].name,
  };
  emitter.removeListener("x", handler);
  result.afterRemoval = emitter.listenerCount("x");
  return result;
}

function metaScenario(E) {
  const emitter = new E();
  const log = [];
  emitter.on("newListener", (type, listener) => log.push(`new:${String(type)}:${typeof listener}`));
  emitter.on("removeListener", (type, listener) =>
    log.push(`remove:${String(type)}:${typeof listener}`)
  );
  function alpha() {}
  function beta() {}
  emitter.on("x", alpha);
  emitter.once("y", beta);
  emitter.removeListener("x", alpha);
  emitter.removeAllListeners("y");
  emitter.removeAllListeners();
  return log;
}

function maxScenario(E) {
  const emitter = new E();
  const values = [emitter.getMaxListeners(), E.getMaxListeners(emitter), E.defaultMaxListeners];
  emitter.setMaxListeners(3);
  values.push(emitter.getMaxListeners(), E.getMaxListeners(emitter), E.listenerCount(emitter, "x"));
  return values;
}

function errorScenario(E) {
  const original = new Error("boom");
  const uncaught = captureThrow(() => new E().emit("error", original));
  const primitive = captureThrow(() => new E().emit("error", "primitive"));
  const none = captureThrow(() => new E().emit("error"));

  const emitter = new E();
  const order = [];
  emitter.on(E.errorMonitor, (...args) => order.push(["monitor", args[0].message]));
  emitter.on("error", (...args) => order.push(["error", args[0].message]));
  const returnValue = emitter.emit("error", new Error("watched"));

  const monitorOnly = new E();
  let monitorOnlyCalls = 0;
  monitorOnly.on(E.errorMonitor, () => {
    monitorOnlyCalls += 1;
  });
  const monitorOnlyThrew = captureThrow(() => monitorOnly.emit("error", new Error("unhandled")));

  return {
    uncaughtSame: uncaught === original,
    uncaughtName: uncaught && uncaught.name,
    primitiveName: primitive && primitive.name,
    primitiveCode: primitive && primitive.code,
    primitiveMessage: primitive && primitive.message,
    noneName: none && none.name,
    noneCode: none && none.code,
    noneMessage: none && none.message,
    order,
    returnValue,
    monitorOnlyCalls,
    monitorOnlyThrew: Boolean(monitorOnlyThrew && monitorOnlyThrew.message),
  };
}

function staticScenario(E) {
  const emitter = new E();
  function handler() {}
  emitter.on("x", handler);
  emitter.on("x", handler);
  return {
    listenerCount: E.listenerCount(emitter, "x"),
    events: E.getEventListeners(emitter, "x").length,
    max: E.getMaxListeners(emitter),
  };
}

function thrownTypeScenario(E) {
  const badListener = captureThrow(() => new E().once("x", 42));
  const badEvent = captureThrow(() => new E().on(42, () => {}));
  return {
    listenerName: badListener && badListener.name,
    listenerCode: badListener && badListener.code,
    eventName: badEvent && badEvent.name,
    eventCode: badEvent && badEvent.code,
  };
}

async function captureScenario(E) {
  const emitter = new E({ captureRejections: true });
  const seen = [];
  emitter.on("error", (error) => seen.push(error.message));
  emitter.on("x", () => ({
    then(resolve, reject) {
      reject(new Error("thenable-rejection"));
    },
  }));
  emitter.emit("x");
  const synchronous = seen.slice();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const custom = new E({ captureRejections: true });
  const customSeen = [];
  custom[E.captureRejectionSymbol] = (error, type, ...args) => {
    customSeen.push([error.message, type, args]);
  };
  custom.on("y", () => ({
    then(resolve, reject) {
      reject(new Error("custom-rejection"));
    },
  }));
  custom.emit("y", 9);
  await new Promise((resolve) => setTimeout(resolve, 25));

  return { synchronous, seen, customSeen };
}

async function oncePromiseScenario(E) {
  const emitter = new E();
  const promise = E.once(emitter, "ready");
  emitter.emit("ready", 1, 2);
  const value = await promise;

  const failing = new E();
  const failure = new Error("early");
  const failedPromise = E.once(failing, "ready");
  failing.emit("error", failure);
  let caught = null;
  try {
    await failedPromise;
  } catch (error) {
    caught = error;
  }

  const errorName = new E();
  const errorPromise = E.once(errorName, "error");
  const emitted = new Error("observed");
  errorName.emit("error", emitted);
  const errorArgs = await errorPromise;

  return {
    value,
    readyListeners: emitter.listenerCount("ready"),
    errorListeners: emitter.listenerCount("error"),
    caughtSame: caught === failure,
    errorEventResolvedSame: errorArgs[0] === emitted,
  };
}

async function iteratorScenario(E) {
  const emitter = new E();
  const iterator = E.on(emitter, "data");
  const returned = [];
  setTimeout(() => {
    emitter.emit("data", "a");
    emitter.emit("data", "b");
  }, 0);
  for await (const value of iterator) {
    returned.push(value);
    if (returned.length === 2) break;
  }

  const pendingEmitter = new E();
  const pendingIterator = E.on(pendingEmitter, "data");
  const pending = pendingIterator.next();
  pendingEmitter.emit("data", 7);
  const pendingValue = await pending;
  await pendingIterator.return();
  const afterReturn = await pendingIterator.next();

  const failingEmitter = new E();
  const failingIterator = E.on(failingEmitter, "data");
  const failingPending = failingIterator.next();
  const failure = new Error("iterator-error");
  failingEmitter.emit("error", failure);
  let caught = null;
  try {
    await failingPending;
  } catch (error) {
    caught = error;
  }

  return {
    returned,
    pendingValue,
    afterReturn,
    caughtSame: caught === failure,
  };
}

async function abortScenario(E) {
  if (typeof AbortController !== "function") return null;
  const controller = new AbortController();
  const promise = E.once(new E(), "ready", { signal: controller.signal });
  const guarded = promise.catch((error) => error);
  controller.abort();
  const onceError = await guarded;

  const controller2 = new AbortController();
  const iterator = E.on(new E(), "data", { signal: controller2.signal });
  const pending = iterator.next();
  controller2.abort();
  let iteratorError = null;
  try {
    await pending;
  } catch (error) {
    iteratorError = error;
  }

  return {
    once: { name: onceError.name, code: onceError.code, message: onceError.message },
    iterator: iteratorError && {
      name: iteratorError.name,
      code: iteratorError.code,
      message: iteratorError.message,
    },
  };
}

async function main() {
  assert.strictEqual(typeof liteEvents, "function", "lite events exports a constructor");
  assert.strictEqual(liteEvents.EventEmitter, liteEvents, "lite EventEmitter self-reference");
  assert.strictEqual(nodeEvents.EventEmitter, nodeEvents, "node EventEmitter self-reference");
  assert.strictEqual(typeof liteEvents.errorMonitor, "symbol");
  assert.strictEqual(typeof nodeEvents.errorMonitor, "symbol");
  assert.strictEqual(typeof liteEvents.captureRejectionSymbol, "symbol");
  assert.strictEqual(
    String(liteEvents.captureRejectionSymbol),
    String(nodeEvents.captureRejectionSymbol),
    "captureRejectionSymbol identity"
  );
  assert.ok(new liteEvents() instanceof liteEvents);

  assert.deepStrictEqual(baseScenario(liteEvents), baseScenario(nodeEvents), "base scenario");
  assert.deepStrictEqual(removalScenario(liteEvents), removalScenario(nodeEvents), "removal scenario");
  assert.deepStrictEqual(onceScenario(liteEvents), onceScenario(nodeEvents), "once scenario");
  assert.deepStrictEqual(metaScenario(liteEvents), metaScenario(nodeEvents), "meta-event scenario");
  assert.deepStrictEqual(maxScenario(liteEvents), maxScenario(nodeEvents), "max listeners");
  assert.deepStrictEqual(errorScenario(liteEvents), errorScenario(nodeEvents), "error scenario");
  assert.deepStrictEqual(staticScenario(liteEvents), staticScenario(nodeEvents), "static helpers");
  assert.deepStrictEqual(
    thrownTypeScenario(liteEvents),
    thrownTypeScenario(nodeEvents),
    "argument validation"
  );

  assert.deepStrictEqual(
    await captureScenario(liteEvents),
    await captureScenario(nodeEvents),
    "captureRejections scenario"
  );
  assert.deepStrictEqual(
    await oncePromiseScenario(liteEvents),
    await oncePromiseScenario(nodeEvents),
    "events.once scenario"
  );
  assert.deepStrictEqual(
    await iteratorScenario(liteEvents),
    await iteratorScenario(nodeEvents),
    "events.on scenario"
  );
  assert.deepStrictEqual(
    await abortScenario(liteEvents),
    await abortScenario(nodeEvents),
    "abort scenario"
  );

  // Removal during emit follows Node: the listener array is snapshotted, so a listener removed
  // by an earlier listener still runs once, and never again.
  const liteEmitter = new liteEvents();
  const liteCalls = [];
  function liteSecond() {
    liteCalls.push("second");
  }
  function liteFirst() {
    liteCalls.push("first");
    liteEmitter.removeListener("x", liteSecond);
  }
  liteEmitter.on("x", liteFirst);
  liteEmitter.on("x", liteSecond);
  liteEmitter.emit("x");
  assert.deepStrictEqual(liteCalls, ["first", "second"], "lite removal-during-emit matches Node");

  const nodeEmitter = new nodeEvents();
  const nodeCalls = [];
  function nodeSecond() {
    nodeCalls.push("second");
  }
  function nodeFirst() {
    nodeCalls.push("first");
    nodeEmitter.removeListener("x", nodeSecond);
  }
  nodeEmitter.on("x", nodeFirst);
  nodeEmitter.on("x", nodeSecond);
  nodeEmitter.emit("x");
  assert.deepStrictEqual(nodeCalls, ["first", "second"], "node removal-during-emit behaviour");

  console.log("events.oracle.js: all differential checks passed");
}

main().catch((error) => {
  console.error("events.oracle.js failed:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
