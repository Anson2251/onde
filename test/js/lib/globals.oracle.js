"use strict";

// Node-only differential test for js/lib/globals.js.
//
//   node test/js/lib/globals.oracle.js
//
// The same trial is executed once against our module and once against Node's
// globals, then the observable results are compared with assert.deepStrictEqual
// (or by error name/code when either side throws). Mismatches print the input
// and both results. Every case that is skipped is marked in the source with the
// reason; Node's implementation is richer or differently specified in those
// places and the gap is listed in docs/compat.md by the globals module owner.
//
// This file is not runtime-agnostic: it exists only to keep us honest against
// the Node behavioural oracle.

const assert = require("node:assert");
const { inspect } = require("node:util");

const ours = require("../../../js/lib/globals.js");
const nodeGlobals = globalThis;

let passed = 0;
let failed = 0;

function format(value) {
  try {
    return inspect(value, { depth: 5, breakLength: 140, maxArrayLength: 20 });
  } catch (_) {
    return String(value);
  }
}

function errorShape(error) {
  if (error === null || error === undefined) return null;
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    constructor: error.constructor && error.constructor.name,
  };
}

function report(label, equal, input, ourValue, nodeValue) {
  if (equal) {
    passed += 1;
    console.log("ok " + label);
    return;
  }
  failed += 1;
  console.log("not ok " + label);
  console.log("  input: " + format(input));
  console.log("  ours:  " + format(ourValue));
  console.log("  node:  " + format(nodeValue));
}

function compare(label, input, trial) {
  let ourValue;
  let nodeValue;
  let ourError;
  let nodeError;
  try {
    ourValue = trial(ours);
  } catch (error) {
    ourError = error;
  }
  try {
    nodeValue = trial(nodeGlobals);
  } catch (error) {
    nodeError = error;
  }
  if (ourError !== undefined || nodeError !== undefined) {
    const equal = ourError !== undefined && nodeError !== undefined &&
      ourError.name === nodeError.name && ourError.code === nodeError.code;
    report(label, equal, input, errorShape(ourError), errorShape(nodeError));
    return;
  }
  try {
    assert.deepStrictEqual(ourValue, nodeValue);
    report(label, true, input, ourValue, nodeValue);
  } catch (_) {
    report(label, false, input, ourValue, nodeValue);
  }
}

function compareSync(label, input, trial) {
  // Alias kept for readability at call sites that are obviously synchronous.
  compare(label, input, trial);
}

function skip(label, reason) {
  console.log("# skip " + label + ": " + reason);
}

// ---------------------------------------------------------------------------
// DOMException

compareSync("DOMException standard name/code table", "standard names", function (g) {
  const names = [
    "IndexSizeError", "DOMStringSizeError", "HierarchyRequestError", "WrongDocumentError",
    "InvalidCharacterError", "NoDataAllowedError", "NoModificationAllowedError", "NotFoundError",
    "NotSupportedError", "InUseAttributeError", "InvalidStateError", "SyntaxError",
    "InvalidModificationError", "NamespaceError", "InvalidAccessError", "ValidationError",
    "TypeMismatchError", "SecurityError", "NetworkError", "AbortError", "URLMismatchError",
    "QuotaExceededError", "TimeoutError", "InvalidNodeTypeError", "DataCloneError",
    "EncodingError", "NotReadableError", "UnknownError", "ConstraintError", "DataError",
    "TransactionInactiveError", "ReadOnlyError", "VersionError", "OperationError", "NotAllowedError",
  ];
  return names.map(function (name) {
    const error = new g.DOMException("m", name);
    return [name, error.name, error.code];
  });
});

compareSync("DOMException defaults", "new DOMException()", function (g) {
  const error = new g.DOMException();
  return [
    error.name,
    error.message,
    error.code,
    error instanceof Error,
    Object.prototype.toString.call(error),
  ];
});

compareSync("DOMException conversions", "number/null message and name", function (g) {
  const numeric = new g.DOMException(123, "AbortError");
  const numericName = new g.DOMException("m", 123);
  const nulls = new g.DOMException(null, null);
  return [
    numeric.message,
    numeric.name,
    numeric.code,
    numericName.name,
    nulls.message,
    nulls.name,
    nulls.code,
  ];
});

compareSync("DOMException stack exists", "new DOMException('m', 'AbortError')", function (g) {
  const error = new g.DOMException("m", "AbortError");
  return [typeof error.stack === "string", error.stack.length > 0];
});

// ---------------------------------------------------------------------------
// Event

compareSync("Event defaults", "new Event('x')", function (g) {
  const event = new g.Event("x");
  return [
    event.type,
    event.bubbles,
    event.cancelable,
    event.composed,
    event.defaultPrevented,
    event.target,
    event.currentTarget,
    event.eventPhase,
    event.isTrusted,
    typeof event.timeStamp,
    Object.prototype.toString.call(event),
  ];
});

compareSync("Event options", "{bubbles, cancelable, composed}", function (g) {
  const event = new g.Event("x", { bubbles: true, cancelable: true, composed: true });
  const coerced = new g.Event("x", { bubbles: 1, cancelable: 0, composed: "yes" });
  return [event.bubbles, event.cancelable, event.composed, coerced.bubbles, coerced.cancelable, coerced.composed];
});

compareSync("Event constants", "Event.NONE/...", function (g) {
  return [g.Event.NONE, g.Event.CAPTURING_PHASE, g.Event.AT_TARGET, g.Event.BUBBLING_PHASE];
});

compareSync("Event preventDefault", "non-cancelable and cancelable", function (g) {
  const plain = new g.Event("x");
  plain.preventDefault();
  const cancelable = new g.Event("x", { cancelable: true });
  cancelable.preventDefault();
  const secondCall = new g.Event("x", { cancelable: true });
  secondCall.preventDefault();
  secondCall.preventDefault();
  const returned = secondCall.returnValue;
  return [plain.defaultPrevented, cancelable.defaultPrevented, secondCall.defaultPrevented, returned];
});

compareSync("Event composedPath outside dispatch", "new Event('x').composedPath()", function (g) {
  return new g.Event("x").composedPath();
});

compareSync("Event missing type error", "new Event()", function (g) {
  new g.Event();
});

compareSync("Event symbol type error", "new Event(Symbol())", function (g) {
  new g.Event(Symbol("type"));
});

compareSync("Event empty type", "new Event('')", function (g) {
  return new g.Event("").type;
});

compareSync("Event null options", "new Event('x', null)", function (g) {
  const event = new g.Event("x", null);
  return [event.bubbles, event.cancelable, event.composed];
});

// ---------------------------------------------------------------------------
// EventTarget

compareSync("EventTarget dispatch fields", "one listener observing dispatch", function (g) {
  const target = new g.EventTarget();
  const seen = [];
  function listener(event) {
    seen.push([
      event.type,
      event.eventPhase,
      event.target === target,
      event.currentTarget === target,
      this === target,
      event.bubbles,
      event.defaultPrevented,
      event.composedPath().length,
    ]);
  }
  target.addEventListener("x", listener);
  const event = new g.Event("x");
  const returned = target.dispatchEvent(event);
  return [returned, seen, event.target === target, event.currentTarget, event.eventPhase, event.composedPath().length];
});

compareSync("EventTarget duplicate suppression", "same callback and capture twice", function (g) {
  const target = new g.EventTarget();
  let calls = 0;
  const listener = function () { calls += 1; };
  target.addEventListener("dup", listener);
  target.addEventListener("dup", listener);
  target.dispatchEvent(new g.Event("dup"));
  return calls;
});

compareSync("EventTarget capture is part of the key", "same callback, capture false then true", function (g) {
  const target = new g.EventTarget();
  let calls = 0;
  const listener = function () { calls += 1; };
  target.addEventListener("dup", listener, false);
  target.addEventListener("dup", listener, true);
  target.dispatchEvent(new g.Event("dup"));
  return calls;
});

compareSync("EventTarget once", "once listener across two dispatches", function (g) {
  const target = new g.EventTarget();
  let calls = 0;
  target.addEventListener("once", function () { calls += 1; }, { once: true });
  target.dispatchEvent(new g.Event("once"));
  target.dispatchEvent(new g.Event("once"));
  return calls;
});

compareSync("EventTarget duplicate once does not upgrade", "plain then {once: true}", function (g) {
  const target = new g.EventTarget();
  let calls = 0;
  const listener = function () { calls += 1; };
  target.addEventListener("upgrade", listener);
  target.addEventListener("upgrade", listener, { once: true });
  target.dispatchEvent(new g.Event("upgrade"));
  target.dispatchEvent(new g.Event("upgrade"));
  return calls;
});

compareSync("EventTarget boolean capture option", "addEventListener(type, fn, true)", function (g) {
  const target = new g.EventTarget();
  let calls = 0;
  target.addEventListener("bool", function () { calls += 1; }, true);
  target.dispatchEvent(new g.Event("bool"));
  return calls;
});

compareSync("EventTarget removeEventListener capture mismatch", "remove with wrong capture", function (g) {
  const target = new g.EventTarget();
  let calls = 0;
  const listener = function () { calls += 1; };
  target.addEventListener("remove", listener, true);
  target.removeEventListener("remove", listener, false);
  target.dispatchEvent(new g.Event("remove"));
  target.removeEventListener("remove", listener, true);
  target.dispatchEvent(new g.Event("remove"));
  return calls;
});

compareSync("EventTarget handleEvent listener", "listener object", function (g) {
  const target = new g.EventTarget();
  const object = {
    seen: null,
    sameThis: false,
    handleEvent(event) {
      this.seen = event.type;
      this.sameThis = this === object;
    },
  };
  target.addEventListener("object", object);
  target.dispatchEvent(new g.Event("object"));
  return [object.seen, object.sameThis];
});

compareSync("EventTarget order at target", "bubble listener registered before capture listener", function (g) {
  const target = new g.EventTarget();
  const order = [];
  target.addEventListener("order", function () { order.push("bubble"); });
  target.addEventListener("order", function () { order.push("capture"); }, true);
  target.addEventListener("order", function () { order.push("bubble2"); });
  target.dispatchEvent(new g.Event("order"));
  return order;
});

compareSync("EventTarget stopImmediatePropagation", "two listeners", function (g) {
  const target = new g.EventTarget();
  const order = [];
  target.addEventListener("stop", function (event) {
    order.push(1);
    event.stopImmediatePropagation();
  });
  target.addEventListener("stop", function () { order.push(2); });
  target.dispatchEvent(new g.Event("stop"));
  return order;
});

compareSync("EventTarget stopPropagation at target", "two listeners", function (g) {
  const target = new g.EventTarget();
  const order = [];
  target.addEventListener("stop", function (event) {
    order.push(1);
    event.stopPropagation();
  });
  target.addEventListener("stop", function () { order.push(2); });
  target.dispatchEvent(new g.Event("stop"));
  return order;
});

compareSync("EventTarget cancelation return value", "cancelable event with preventDefault", function (g) {
  const cancelable = new g.EventTarget();
  cancelable.addEventListener("cancel", function (event) { event.preventDefault(); });
  const event = new g.Event("cancel", { cancelable: true });
  const canceled = cancelable.dispatchEvent(event);

  const plain = new g.EventTarget();
  plain.addEventListener("plain", function (event) { event.preventDefault(); });
  const plainEvent = new g.Event("plain");
  const notCanceled = plain.dispatchEvent(plainEvent);

  return [canceled, event.defaultPrevented, notCanceled, plainEvent.defaultPrevented];
});

compareSync("EventTarget no listeners", "dispatch on an empty target", function (g) {
  return new g.EventTarget().dispatchEvent(new g.Event("empty"));
});

// Node's EventTarget iterates its live listener list in some cases, so a listener
// added during dispatch can run in that same dispatch. The DOM algorithm snapshots
// the list (a listener added during dispatch runs on the *next* dispatch), and this
// module follows the DOM. Skipping the differential is deliberate.
skip(
  "listener added during dispatch",
  "Node can invoke a listener added mid-dispatch (live list iteration); DOM and this module snapshot the list"
);

compareSync("EventTarget listener removed during dispatch", "remove a later listener", function (g) {
  const target = new g.EventTarget();
  const order = [];
  const removed = function () { order.push("removed"); };
  target.addEventListener("remove", function () {
    order.push("first");
    target.removeEventListener("remove", removed);
  });
  target.addEventListener("remove", removed);
  target.dispatchEvent(new g.Event("remove"));
  return order;
});

compareSync("EventTarget invalid listener type", "addEventListener(type, 3)", function (g) {
  new g.EventTarget().addEventListener("x", 3);
});

compareSync("EventTarget missing listener argument", "addEventListener('x')", function (g) {
  new g.EventTarget().addEventListener("x");
});

compareSync("EventTarget symbol type error", "addEventListener(Symbol(), fn)", function (g) {
  new g.EventTarget().addEventListener(Symbol("type"), function () {});
});

compareSync("EventTarget dispatch non-Event", "dispatchEvent({type: 'x'})", function (g) {
  new g.EventTarget().dispatchEvent({ type: "x" });
});

compareSync("EventTarget reentrant dispatch", "dispatch the same event from a listener", function (g) {
  const target = new g.EventTarget();
  const event = new g.Event("recursive");
  const observed = [];
  target.addEventListener("recursive", function () {
    try {
      target.dispatchEvent(event);
    } catch (error) {
      observed.push(error.name, error.code);
    }
  });
  target.dispatchEvent(event);
  return observed;
});

compareSync("EventTarget signal option", "AbortSignal removes the listener", function (g) {
  const target = new g.EventTarget();
  const controller = new g.AbortController();
  let calls = 0;
  target.addEventListener("signal", function () { calls += 1; }, { signal: controller.signal });
  target.dispatchEvent(new g.Event("signal"));
  controller.abort();
  target.dispatchEvent(new g.Event("signal"));
  return calls;
});

compareSync("EventTarget already-aborted signal", "add a listener with an aborted signal", function (g) {
  const target = new g.EventTarget();
  const controller = new g.AbortController();
  controller.abort();
  let calls = 0;
  target.addEventListener("signal", function () { calls += 1; }, { signal: controller.signal });
  target.dispatchEvent(new g.Event("signal"));
  return calls;
});

compareSync("EventTarget invalid signal option", "signal: {}", function (g) {
  new g.EventTarget().addEventListener("x", function () {}, { signal: {} });
});

// Skips: places where Node's DOM implementation does something we deliberately
// do not model, so a differential comparison would be meaningless or unfixable.
skip(
  "capture/bubble over a parentNode tree",
  "Node's EventTarget has no tree; propagation is a documented lite extension"
);
skip(
  "listener exception reporting",
  "Node reports via process.nextTick; this module uses queueMicrotask as specified"
);
skip(
  "invalid handleEvent object error",
  "reported asynchronously by both runtimes through different queues; not comparable without hooks"
);
skip(
  "addEventListener null/undefined warning",
  "Node emits AddEventListenerArgumentTypeWarning; this module is silent"
);
skip(
  "passive listener option effects",
  "no scrolling/layout in either runtime; the flag is accepted but unobservable"
);

// ---------------------------------------------------------------------------
// AbortController / AbortSignal

compareSync("AbortSignal defaults", "new AbortController().signal", function (g) {
  const controller = new g.AbortController();
  const signal = controller.signal;
  return [
    signal.aborted,
    signal.reason,
    signal instanceof g.AbortSignal,
    signal instanceof g.EventTarget,
    Object.prototype.toString.call(signal),
    Object.prototype.toString.call(controller),
  ];
});

compareSync("AbortController default abort reason", "controller.abort()", function (g) {
  const controller = new g.AbortController();
  controller.abort();
  return [
    controller.signal.aborted,
    controller.signal.reason.name,
    controller.signal.reason.code,
    controller.signal.reason.message,
    controller.signal.reason instanceof g.DOMException,
    typeof controller.signal.reason.stack === "string",
  ];
});

compareSync("AbortController abort is idempotent", "abort twice with listeners", function (g) {
  const controller = new g.AbortController();
  let calls = 0;
  controller.signal.addEventListener("abort", function () { calls += 1; });
  controller.abort();
  controller.abort();
  return [calls, controller.signal.aborted];
});

compareSync("AbortController arbitrary reason", "abort(object) then abort('ignored')", function (g) {
  const controller = new g.AbortController();
  const reason = { code: "custom" };
  controller.abort(reason);
  const first = controller.signal.reason;
  controller.abort("ignored");
  return [first === reason, controller.signal.reason === reason];
});

compareSync("AbortController null reason", "abort(null)", function (g) {
  const controller = new g.AbortController();
  controller.abort(null);
  return controller.signal.reason;
});

compareSync("AbortSignal throwIfAborted", "before and after abort", function (g) {
  const controller = new g.AbortController();
  const signal = controller.signal;
  let before = "no throw";
  try {
    signal.throwIfAborted();
  } catch (_) {
    before = "threw";
  }
  const reason = { reason: true };
  controller.abort(reason);
  let thrown;
  try {
    signal.throwIfAborted();
  } catch (error) {
    thrown = error;
  }
  return [before, thrown === reason];
});

compareSync("AbortSignal listener order", "listener, onabort, listener", function (g) {
  const controller = new g.AbortController();
  const order = [];
  controller.signal.addEventListener("abort", function () { order.push("l1"); });
  controller.signal.onabort = function () { order.push("onabort"); };
  controller.signal.addEventListener("abort", function () { order.push("l2"); });
  controller.abort();
  return order;
});

compareSync("AbortSignal onabort identity", "set, read, clear", function (g) {
  const controller = new g.AbortController();
  const handler = function () {};
  controller.signal.onabort = handler;
  const readBack = controller.signal.onabort;
  controller.signal.onabort = null;
  return [readBack === handler, controller.signal.onabort];
});

compareSync("AbortSignal abort event shape", "onabort event", function (g) {
  const controller = new g.AbortController();
  const signal = controller.signal;
  let shape = null;
  signal.onabort = function (event) {
    shape = [
      event.type,
      event.bubbles,
      event.cancelable,
      event.target === signal,
      event.currentTarget === signal,
      event.eventPhase,
      event.isTrusted,
      event.composedPath().length,
    ];
  };
  controller.abort();
  return shape;
});

compareSync("AbortSignal listener this", "addEventListener callback this", function (g) {
  const controller = new g.AbortController();
  let sameThis = false;
  controller.signal.addEventListener("abort", function () {
    sameThis = this === controller.signal;
  });
  controller.abort();
  return sameThis;
});

compareSync("AbortSignal manual abort dispatch", "dispatchEvent(new Event('abort'))", function (g) {
  const controller = new g.AbortController();
  let calls = 0;
  controller.signal.onabort = function () { calls += 1; };
  controller.signal.dispatchEvent(new g.Event("abort"));
  return [calls, controller.signal.aborted, controller.signal.reason];
});

compareSync("AbortSignal.abort static", "AbortSignal.abort() / abort('x')", function (g) {
  const defaultAbort = g.AbortSignal.abort();
  const customAbort = g.AbortSignal.abort("custom");
  return [
    defaultAbort.aborted,
    defaultAbort.reason.name,
    defaultAbort.reason.code,
    defaultAbort.reason.message,
    customAbort.reason,
  ];
});

compareSync("AbortSignal.timeout argument validation", "-1, 1.5, NaN, '5', null, undefined", function (g) {
  const results = [];
  const values = [-1, 1.5, NaN, Infinity, "5", null, undefined];
  for (let index = 0; index < values.length; index += 1) {
    try {
      g.AbortSignal.timeout(values[index]);
      results.push("ok");
    } catch (error) {
      results.push(error.name + "/" + error.code);
    }
  }
  return results;
});

compareSync("AbortSignal.any semantics", "empty, combined, preset and invalid inputs", function (g) {
  const first = new g.AbortController();
  const second = new g.AbortController();
  const combined = g.AbortSignal.any([first.signal, second.signal]);
  let events = 0;
  combined.addEventListener("abort", function () { events += 1; });
  second.abort("second");
  first.abort("first");

  const empty = g.AbortSignal.any([]);
  const preset = g.AbortSignal.any([g.AbortSignal.abort("preset"), new g.AbortController().signal]);

  const errors = [];
  const invalid = [null, 3, [{}], [new g.EventTarget()]];
  for (let index = 0; index < invalid.length; index += 1) {
    try {
      g.AbortSignal.any(invalid[index]);
      errors.push("ok");
    } catch (error) {
      errors.push(error.name + "/" + error.code);
    }
  }

  return [combined.aborted, combined.reason, events, empty.aborted, preset.aborted, preset.reason, errors];
});

compareSync("AbortSignal illegal constructor", "new AbortSignal()", function (g) {
  new g.AbortSignal();
});

// ---------------------------------------------------------------------------
// structuredClone

function cloneTrial(makeValue) {
  return function (g) {
    return g.structuredClone(makeValue());
  };
}

compareSync("structuredClone primitives", "number/string/boolean/null/undefined/bigint", cloneTrial(function () {
  return [1, "x", true, null, undefined, 10n];
}));

compareSync("structuredClone nested object", "{a, b:{c:[...]}}", cloneTrial(function () {
  return { a: 1, b: { c: [1, 2, { d: "e" }] } };
}));

compareSync("structuredClone sparse array with extra property", "[, , 1] + .extra", cloneTrial(function () {
  const value = [, , 1];
  value.extra = "kept";
  return value;
}));

compareSync("structuredClone Map", "Map with primitive and object keys", function (g) {
  const key = { key: true };
  const value = new Map([["a", 1], [3, { v: 2 }], [key, "object-key"]]);
  const clone = g.structuredClone(value);
  const clonedKey = clone.keys().next().value;
  return [
    clone instanceof Map,
    clone.size,
    clone.get("a"),
    clone.get(3),
    clone.get(clonedKey),
    clonedKey !== key,
    clonedKey.key,
    clone.get(3) !== value.get(3),
  ];
});

compareSync("structuredClone Set", "Set of primitives and object", function (g) {
  const value = new Set([1, "a"]);
  const clone = g.structuredClone(value);
  return [clone instanceof Set, clone.size, Array.from(clone)[0], Array.from(clone)[1]];
});

compareSync("structuredClone Date and RegExp", "Date and lastIndex on RegExp", function (g) {
  const date = g.structuredClone(new Date(123456789));
  const source = /ab+c/gi;
  source.lastIndex = 3;
  const regexp = g.structuredClone(source);
  return [
    date instanceof Date,
    date.getTime(),
    regexp instanceof RegExp,
    regexp.source,
    regexp.flags,
    regexp.lastIndex,
  ];
});

compareSync("structuredClone ArrayBuffer", "4-byte buffer with byte 7", function (g) {
  const source = new ArrayBuffer(4);
  new Uint8Array(source)[0] = 7;
  const clone = g.structuredClone(source);
  return [clone instanceof ArrayBuffer, clone.byteLength, new Uint8Array(clone)[0], clone !== source];
});

compareSync("structuredClone typed array and DataView", "Uint8Array view over a larger buffer", function (g) {
  const source = new ArrayBuffer(16);
  new Uint8Array(source).fill(7);
  const view = g.structuredClone(new Uint8Array(source, 4, 3));
  const dataView = g.structuredClone(new DataView(source, 4, 3));
  return [
    view instanceof Uint8Array,
    view.byteOffset,
    view.byteLength,
    view.buffer.byteLength,
    Array.from(view),
    new Uint8Array(view.buffer)[0],
    dataView instanceof DataView,
    dataView.byteOffset,
    dataView.byteLength,
    dataView.buffer.byteLength,
  ];
});

compareSync("structuredClone typed array subclasses", "class extends Uint8Array", function (g) {
  class Bytes extends Uint8Array {}
  const clone = g.structuredClone(new Bytes([1, 2]));
  return [clone.constructor.name, clone instanceof Uint8Array, Array.from(clone)];
});

compareSync("structuredClone BigInt64Array", "BigInt64Array([1n, 2n])", cloneTrial(function () {
  return new BigInt64Array([1n, 2n]);
}));

compareSync("structuredClone boxed primitives", "Object(3), Object('x'), Object(true), Object(5n)", function (g) {
  const values = g.structuredClone([Object(3), Object("x"), Object(true), Object(5n)]);
  return values.map(function (value) {
    return [typeof value, value instanceof Object, value.valueOf()];
  });
});

compareSync("structuredClone class instance", "class with own field and method", function (g) {
  class Point {
    constructor() {
      this.x = 1;
    }
    method() {
      return "method";
    }
  }
  const clone = g.structuredClone(new Point());
  return [clone, Object.getPrototypeOf(clone) === Object.prototype, clone.constructor === Object, clone.method];
});

compareSync("structuredClone null prototype object", "Object.create(null) with own field", function (g) {
  const source = Object.create(null);
  source.a = 1;
  const clone = g.structuredClone(source);
  return [clone.a, Object.getPrototypeOf(clone) === Object.prototype, clone.constructor === Object];
});

compareSync("structuredClone custom toStringTag object", "class with Symbol.toStringTag", function (g) {
  class Tagged {
    constructor() {
      this.x = 1;
    }
    get [Symbol.toStringTag]() {
      return "Tagged";
    }
  }
  return g.structuredClone(new Tagged());
});

compareSync("structuredClone DOM class instances", "EventTarget/Event/AbortSignal clone as plain objects", function (g) {
  const controller = new g.AbortController();
  const values = [
    g.structuredClone(new g.EventTarget()),
    g.structuredClone(new g.Event("x")),
    g.structuredClone(controller.signal),
  ];
  return values.map(function (value) {
    return [Object.prototype.toString.call(value), Object.getPrototypeOf(value) === Object.prototype, Object.keys(value)];
  });
});

compareSync("structuredClone Error", "TypeError with extra own props", function (g) {
  const source = new TypeError("bad");
  source.code = "E_BAD";
  source.extra = { not: "cloned" };
  const clone = g.structuredClone(source);
  return [
    clone.constructor.name,
    clone.name,
    clone.message,
    typeof clone.stack === "string",
    clone.code,
    clone.extra,
    Object.getOwnPropertyNames(clone).sort(),
  ];
});

compareSync("structuredClone Error cause", "new Error('m', {cause})", function (g) {
  const clone = g.structuredClone(new Error("m", { cause: { x: 1 } }));
  return [clone.cause, Object.keys(clone), Object.getOwnPropertyNames(clone).sort()];
});

compareSync("structuredClone Error subclasses", "custom Error name and AggregateError", function (g) {
  class CustomError extends Error {
    constructor(message) {
      super(message);
      this.name = "CustomError";
    }
  }
  const custom = g.structuredClone(new CustomError("custom"));
  const aggregate = g.structuredClone(new AggregateError([new Error("inner")], "aggregate"));
  return [
    custom.constructor.name,
    custom.name,
    custom.message,
    aggregate.constructor.name,
    aggregate.name,
    aggregate.message,
    aggregate.errors,
  ];
});

compareSync("structuredClone DOMException", "DOMException('message', 'AbortError')", function (g) {
  const clone = g.structuredClone(new g.DOMException("message", "AbortError"));
  return [
    clone.constructor.name,
    Object.prototype.toString.call(clone),
    clone.name,
    clone.message,
    clone.code,
    clone instanceof g.DOMException,
    typeof clone.stack === "string",
  ];
});

compareSync("structuredClone cycles", "object and Map self references", function (g) {
  const object = { name: "cyclic" };
  object.self = object;
  const objectClone = g.structuredClone(object);
  const map = new Map();
  map.set("self", map);
  const mapClone = g.structuredClone(map);
  return [objectClone !== object, objectClone.self === objectClone, mapClone.get("self") === mapClone];
});

compareSync("structuredClone alias preservation", "same object and same ArrayBuffer twice", function (g) {
  const shared = { value: 1 };
  const pair = g.structuredClone([shared, shared]);
  const buffer = new ArrayBuffer(4);
  const buffers = g.structuredClone([buffer, buffer]);
  return [pair[0] === pair[1], buffers[0] === buffers[1]];
});

compareSync("structuredClone symbol keys", "symbol-keyed property is dropped", function (g) {
  const source = { a: 1 };
  source[Symbol("hidden")] = 2;
  const clone = g.structuredClone(source);
  return [clone.a, Reflect.ownKeys(clone)];
});

compareSync("structuredClone non-enumerable function", "hidden function property is skipped", function (g) {
  const source = {};
  Object.defineProperty(source, "fn", { value: function () {}, enumerable: false });
  const clone = g.structuredClone(source);
  return [Object.keys(clone), Reflect.ownKeys(clone)];
});

compareSync("structuredClone frozen object", "Object.freeze", function (g) {
  const clone = g.structuredClone(Object.freeze({ a: 1 }));
  return [clone, Object.isFrozen(clone)];
});

compareSync("structuredClone SharedArrayBuffer", "SharedArrayBuffer(4)", function (g) {
  if (typeof SharedArrayBuffer !== "function") return "not available";
  const source = new SharedArrayBuffer(4);
  new Uint8Array(source)[0] = 3;
  const clone = g.structuredClone(source);
  return [clone.constructor.name, clone.byteLength, new Uint8Array(clone)[0], clone !== source];
});

compareSync("structuredClone transfer detaches source", "ArrayBuffer transfer", function (g) {
  const source = new ArrayBuffer(4);
  new Uint8Array(source)[0] = 9;
  const clone = g.structuredClone(source, { transfer: [source] });
  return [
    clone.byteLength,
    new Uint8Array(clone)[0],
    source.byteLength,
    source.detached,
    clone !== source,
  ];
});

compareSync("structuredClone transfer through a view", "Uint8Array view with its buffer transferred", function (g) {
  const source = new ArrayBuffer(8);
  new Uint8Array(source).fill(5);
  const view = new Uint8Array(source, 2, 3);
  const clone = g.structuredClone(view, { transfer: [source] });
  return [clone.byteOffset, clone.byteLength, clone.buffer.byteLength, Array.from(clone), source.detached];
});

compareSync("structuredClone transfer keeps sharing", "buffer and view in the same value", function (g) {
  const source = new ArrayBuffer(8);
  new Uint8Array(source).fill(5);
  const view = new Uint8Array(source, 2, 3);
  const clone = g.structuredClone({ buffer: source, view: view }, { transfer: [source] });
  return [clone.buffer === clone.view.buffer, clone.view.byteOffset, clone.view.byteLength, Array.from(clone.view)];
});

compareSync("structuredClone transfer of unused buffer", "value is a primitive", function (g) {
  const source = new ArrayBuffer(4);
  const result = g.structuredClone(1, { transfer: [source] });
  return [result, source.byteLength, source.detached];
});

compareSync("structuredClone transfer failure keeps source", "function value with transfer list", function (g) {
  const source = new ArrayBuffer(4);
  let error = null;
  try {
    g.structuredClone(function () {}, { transfer: [source] });
  } catch (caught) {
    error = caught;
  }
  return [error && error.name, error && error.code, source.byteLength, source.detached];
});

compareSync("structuredClone transfer validation", "view/duplicate/detached/invalid list", function (g) {
  const results = [];
  function capture(fn) {
    try {
      fn();
      results.push("ok");
    } catch (error) {
      results.push(error.name + "/" + error.code);
    }
  }
  const first = new ArrayBuffer(4);
  capture(function () { g.structuredClone(1, { transfer: [new Uint8Array(first)] }); });
  const second = new ArrayBuffer(4);
  capture(function () { g.structuredClone(1, { transfer: [second, second] }); });
  const third = new ArrayBuffer(4);
  third.transfer(0);
  capture(function () { g.structuredClone(1, { transfer: [third] }); });
  capture(function () { g.structuredClone(1, { transfer: "invalid" }); });
  capture(function () { g.structuredClone(1, { transfer: { length: 0 } }); });
  return results;
});

compareSync("structuredClone uncloneable values", "function/symbol/WeakMap/WeakSet/Promise", function (g) {
  const attempts = [
    function () { g.structuredClone(function () {}); },
    function () { g.structuredClone(Symbol("nope")); },
    function () { g.structuredClone(new WeakMap()); },
    function () { g.structuredClone(new WeakSet()); },
    function () { g.structuredClone(Promise.resolve(1)); },
    function () { g.structuredClone({ nested: { fn: function () {} } }); },
  ];
  return attempts.map(function (attempt) {
    try {
      attempt();
      return "ok";
    } catch (error) {
      return error.name + "/" + error.code;
    }
  });
});

compareSync("structuredClone URL values", "URL and URLSearchParams", function (g) {
  const attempts = [
    function () { g.structuredClone(new URL("https://example.com/a")); },
    function () { g.structuredClone(new URLSearchParams("a=1")); },
  ];
  return attempts.map(function (attempt) {
    try {
      attempt();
      return "ok";
    } catch (error) {
      return error.name + "/" + error.code;
    }
  });
});

compareSync("structuredClone detached ArrayBuffer", "transfer(0) then clone", function (g) {
  const source = new ArrayBuffer(4);
  source.transfer(0);
  try {
    g.structuredClone(source);
    return "ok";
  } catch (error) {
    return error.name + "/" + error.code;
  }
});

compareSync("structuredClone options nullish", "null and undefined options", function (g) {
  return [g.structuredClone({ a: 1 }, null), g.structuredClone({ a: 1 }, undefined)];
});

skip(
  "structuredClone of a Proxy",
  "pure JS has no way to detect a Proxy; Node throws DataCloneError, this module clones it"
);
skip(
  "structuredClone of Blob/File/MessagePort/streams",
  "not part of the M2 subset; this module throws DataCloneError instead of cloning them"
);
skip(
  "DOMException prototype accessors and event legacy properties",
  "Node uses WebIDL accessors; this module uses equivalent own data properties, observable shape differs"
);

// ---------------------------------------------------------------------------
// Async cases: AbortSignal.timeout firing

function waitForAbort(signal) {
  return new Promise(function (resolve) {
    const fallback = setTimeout(function () { resolve("fallback"); }, 500);
    signal.addEventListener("abort", function () {
      clearTimeout(fallback);
      resolve("aborted");
    });
  });
}

async function compareTimeoutFiring() {
  const ourSignal = ours.AbortSignal.timeout(5);
  const nodeSignal = nodeGlobals.AbortSignal.timeout(5);
  const outcomes = await Promise.all([waitForAbort(ourSignal), waitForAbort(nodeSignal)]);
  const ourShape = [
    outcomes[0],
    ourSignal.aborted,
    ourSignal.reason.name,
    ourSignal.reason.code,
    ourSignal.reason.message,
    ourSignal.reason instanceof ours.DOMException,
  ];
  const nodeShape = [
    outcomes[1],
    nodeSignal.aborted,
    nodeSignal.reason.name,
    nodeSignal.reason.code,
    nodeSignal.reason.message,
    nodeSignal.reason instanceof nodeGlobals.DOMException,
  ];
  try {
    assert.deepStrictEqual(ourShape, nodeShape);
    report("AbortSignal.timeout firing", true, "AbortSignal.timeout(5)", ourShape, nodeShape);
  } catch (_) {
    report("AbortSignal.timeout firing", false, "AbortSignal.timeout(5)", ourShape, nodeShape);
  }
}

// ---------------------------------------------------------------------------
// Summary

(async function run() {
  await compareTimeoutFiring();

  console.log("# " + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})().catch(function (error) {
  console.error("not ok harness: " + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
