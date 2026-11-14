"use strict";

// Web globals that Node provides but QuickJS does not:
// `DOMException`, `Event`, `EventTarget`, `AbortController`, `AbortSignal`, `structuredClone`.
//
// This module only defines them. Installation is `bootstrap.js`'s job:
//
//   const g = require("globals");
//   globalThis.EventTarget = g.EventTarget; // ...
//
// Everything here is plain ES2023 and must also run under `node` (see
// test/js/lib/globals.test.js), so there is no `node:` import and no host access.
//
// Two deliberate extensions/shapes worth knowing about:
//
// * EventTarget has no DOM tree, so capture/bubble propagation is opt-in: a target
//   participates in a tree when it exposes `parentNode` (or `parent`) pointing at
//   another EventTarget. A plain `new EventTarget()` behaves exactly like Node's
//   single-node implementation.
// * Listener exceptions are caught and re-thrown from a microtask (Node reports them
//   from `process.nextTick`). Dispatch itself continues and is not affected.

// ---------------------------------------------------------------------------
// small helpers

function defineCode(error, code) {
  Object.defineProperty(error, "code", {
    value: code,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function makeError(Ctor, code, message) {
  const error = new Ctor(message);
  if (code !== undefined) defineCode(error, code);
  return error;
}

function missingArgs(message) {
  return makeError(TypeError, "ERR_MISSING_ARGS", message);
}

function invalidArg(message) {
  return makeError(TypeError, "ERR_INVALID_ARG_TYPE", message);
}

function outOfRange(message) {
  return makeError(RangeError, "ERR_OUT_OF_RANGE", message);
}

function clampTag(proto, tag) {
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: tag,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

// WebIDL DOMString conversion: symbols are a hard error (String(symbol) is not).
function toDOMString(value, error) {
  if (typeof value === "symbol") throw error;
  return String(value);
}

function describeValue(value) {
  const type = typeof value;
  if (type === "number") return "type number (" + String(value) + ")";
  if (type === "string") return "type string (" + JSON.stringify(value) + ")";
  if (type === "symbol") return "type symbol";
  if (type === "boolean") return "type boolean (" + String(value) + ")";
  if (value === null) return "null";
  if (type === "object") {
    const name = value.constructor && value.constructor.name;
    return "an instance of " + (name || "Object");
  }
  return "type " + type;
}

function createDataProperty(object, key, value) {
  Object.defineProperty(object, key, {
    value: value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// Listener errors in Node surface asynchronously, out of band with dispatch.
function reportListenerError(error) {
  const queue = typeof globalThis === "object" && globalThis !== null
    ? globalThis.queueMicrotask
    : undefined;
  if (typeof queue === "function") {
    queue(function microtaskListenerError() {
      throw error;
    });
    return;
  }
  throw error;
}

// ---------------------------------------------------------------------------
// DOMException

const DOM_EXCEPTION_CONSTANTS = [
  ["INDEX_SIZE_ERR", 1],
  ["DOMSTRING_SIZE_ERR", 2],
  ["HIERARCHY_REQUEST_ERR", 3],
  ["WRONG_DOCUMENT_ERR", 4],
  ["INVALID_CHARACTER_ERR", 5],
  ["NO_DATA_ALLOWED_ERR", 6],
  ["NO_MODIFICATION_ALLOWED_ERR", 7],
  ["NOT_FOUND_ERR", 8],
  ["NOT_SUPPORTED_ERR", 9],
  ["INUSE_ATTRIBUTE_ERR", 10],
  ["INVALID_STATE_ERR", 11],
  ["SYNTAX_ERR", 12],
  ["INVALID_MODIFICATION_ERR", 13],
  ["NAMESPACE_ERR", 14],
  ["INVALID_ACCESS_ERR", 15],
  ["VALIDATION_ERR", 16],
  ["TYPE_MISMATCH_ERR", 17],
  ["SECURITY_ERR", 18],
  ["NETWORK_ERR", 19],
  ["ABORT_ERR", 20],
  ["URL_MISMATCH_ERR", 21],
  ["QUOTA_EXCEEDED_ERR", 22],
  ["TIMEOUT_ERR", 23],
  ["INVALID_NODE_TYPE_ERR", 24],
  ["DATA_CLONE_ERR", 25],
];

// Node's DOMException reports 0 for a handful of legacy names (DOMStringSizeError,
// NoDataAllowedError, ValidationError) even though their constants still exist; the
// table below mirrors Node rather than the DOM spec. Unknown names report 0 too.
const DOM_EXCEPTION_CODES = Object.create(null);
for (const entry of DOM_EXCEPTION_CONSTANTS) {
  DOM_EXCEPTION_CODES[entry[0]] = entry[1];
}
DOM_EXCEPTION_CODES.IndexSizeError = 1;
DOM_EXCEPTION_CODES.HierarchyRequestError = 3;
DOM_EXCEPTION_CODES.WrongDocumentError = 4;
DOM_EXCEPTION_CODES.InvalidCharacterError = 5;
DOM_EXCEPTION_CODES.NoModificationAllowedError = 7;
DOM_EXCEPTION_CODES.NotFoundError = 8;
DOM_EXCEPTION_CODES.NotSupportedError = 9;
DOM_EXCEPTION_CODES.InUseAttributeError = 10;
DOM_EXCEPTION_CODES.InvalidStateError = 11;
DOM_EXCEPTION_CODES.SyntaxError = 12;
DOM_EXCEPTION_CODES.InvalidModificationError = 13;
DOM_EXCEPTION_CODES.NamespaceError = 14;
DOM_EXCEPTION_CODES.InvalidAccessError = 15;
DOM_EXCEPTION_CODES.TypeMismatchError = 17;
DOM_EXCEPTION_CODES.SecurityError = 18;
DOM_EXCEPTION_CODES.NetworkError = 19;
DOM_EXCEPTION_CODES.AbortError = 20;
DOM_EXCEPTION_CODES.URLMismatchError = 21;
DOM_EXCEPTION_CODES.QuotaExceededError = 22;
DOM_EXCEPTION_CODES.TimeoutError = 23;
DOM_EXCEPTION_CODES.InvalidNodeTypeError = 24;
DOM_EXCEPTION_CODES.DataCloneError = 25;

class DOMException extends Error {
  constructor(message, name) {
    const text = message === undefined ? "" : String(message);
    const label = name === undefined ? "Error" : String(name);
    super(text);
    Object.defineProperty(this, "name", {
      value: label,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  get code() {
    const label = this.name;
    return Object.prototype.hasOwnProperty.call(DOM_EXCEPTION_CODES, label)
      ? DOM_EXCEPTION_CODES[label]
      : 0;
  }
}

clampTag(DOMException.prototype, "DOMException");
for (const entry of DOM_EXCEPTION_CONSTANTS) {
  DOMException[entry[0]] = entry[1];
  Object.defineProperty(DOMException.prototype, entry[0], {
    value: entry[1],
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Event

const EVENT_STATE = new WeakMap();

function eventState(event) {
  const state = EVENT_STATE.get(event);
  if (state === undefined) throw new TypeError("Illegal invocation");
  return state;
}

function timestampMs() {
  const performanceObject = typeof globalThis === "object" && globalThis !== null
    ? globalThis.performance
    : undefined;
  if (performanceObject && typeof performanceObject.now === "function") {
    return performanceObject.now();
  }
  return Date.now();
}

class Event {
  constructor(type, options) {
    if (arguments.length === 0) {
      throw missingArgs('The "type" argument must be specified');
    }
    const opts = options === undefined || options === null ? null : Object(options);
    EVENT_STATE.set(this, {
      type: toDOMString(type, new TypeError("Cannot convert a Symbol value to a string")),
      bubbles: opts === null ? false : Boolean(opts.bubbles),
      cancelable: opts === null ? false : Boolean(opts.cancelable),
      composed: opts === null ? false : Boolean(opts.composed),
      defaultPrevented: false,
      target: null,
      currentTarget: null,
      eventPhase: 0,
      propagationStopped: false,
      immediateStopped: false,
      path: null,
      inDispatch: false,
      trusted: false,
      timeStamp: timestampMs(),
    });
  }

  get type() {
    return eventState(this).type;
  }

  get bubbles() {
    return eventState(this).bubbles;
  }

  get cancelable() {
    return eventState(this).cancelable;
  }

  get composed() {
    return eventState(this).composed;
  }

  get defaultPrevented() {
    return eventState(this).defaultPrevented;
  }

  get target() {
    return eventState(this).target;
  }

  get currentTarget() {
    return eventState(this).currentTarget;
  }

  get eventPhase() {
    return eventState(this).eventPhase;
  }

  get isTrusted() {
    return eventState(this).trusted;
  }

  get timeStamp() {
    return eventState(this).timeStamp;
  }

  // Legacy DOM alias for `target`.
  get srcElement() {
    return eventState(this).target;
  }

  // Legacy DOM alias: true when stopPropagation() has been called.
  get cancelBubble() {
    return eventState(this).propagationStopped;
  }

  set cancelBubble(value) {
    if (value) this.stopPropagation();
  }

  // Legacy DOM alias: false once preventDefault() succeeded.
  get returnValue() {
    return !eventState(this).defaultPrevented;
  }

  set returnValue(value) {
    if (!value) this.preventDefault();
  }

  preventDefault() {
    const state = eventState(this);
    if (state.cancelable) state.defaultPrevented = true;
  }

  stopPropagation() {
    eventState(this).propagationStopped = true;
  }

  stopImmediatePropagation() {
    const state = eventState(this);
    state.propagationStopped = true;
    state.immediateStopped = true;
  }

  composedPath() {
    const state = eventState(this);
    return state.path === null ? [] : state.path.slice();
  }

  initEvent(type, bubbles, cancelable) {
    const state = eventState(this);
    state.type = toDOMString(type, new TypeError("Cannot convert a Symbol value to a string"));
    state.bubbles = Boolean(bubbles);
    state.cancelable = Boolean(cancelable);
    state.defaultPrevented = false;
  }
}

Event.NONE = 0;
Event.CAPTURING_PHASE = 1;
Event.AT_TARGET = 2;
Event.BUBBLING_PHASE = 3;
clampTag(Event.prototype, "Event");

// ---------------------------------------------------------------------------
// EventTarget

const TARGET_LISTENERS = new WeakMap();

function listenerMap(target) {
  let map = TARGET_LISTENERS.get(target);
  if (map === undefined) {
    map = new Map();
    TARGET_LISTENERS.set(target, map);
  }
  return map;
}

function listenersFor(target, type) {
  const map = TARGET_LISTENERS.get(target);
  return map === undefined ? undefined : map.get(type);
}

function removeListenerRecord(target, record) {
  if (record.removed) return;
  record.removed = true;
  const map = TARGET_LISTENERS.get(target);
  if (map !== undefined) {
    const list = map.get(record.type);
    if (list !== undefined) {
      const index = list.indexOf(record);
      if (index !== -1) list.splice(index, 1);
      if (list.length === 0) map.delete(record.type);
    }
  }
  if (record.signal !== undefined && record.abortHandler !== null) {
    const handler = record.abortHandler;
    record.abortHandler = null;
    record.signal.removeEventListener("abort", handler);
  }
}

function readListenerOptions(options) {
  const result = { once: false, capture: false, passive: false, signal: undefined };
  if (typeof options === "boolean") {
    result.capture = options;
    return result;
  }
  if (options === undefined || options === null) return result;
  const opts = Object(options);
  // Node reads the members in this order; getters observe it.
  result.once = Boolean(opts.once);
  result.capture = Boolean(opts.capture);
  result.passive = Boolean(opts.passive);
  result.signal = opts.signal;
  return result;
}

function validateListener(callback) {
  const type = typeof callback;
  if (type === "function" || type === "object") return true;
  throw invalidArg('The "listener" argument must be of type function. Received ' + describeValue(callback));
}

// The propagation tree is an extension: EventTarget has no DOM tree. A target that
// exposes `parentNode` (or `parent`) as another EventTarget gets capture/bubble
// propagation. The deleted-DOM equivalent of this is `Node.parentNode`.
function eventParent(target) {
  let parent = target.parentNode;
  if (parent === undefined || parent === null) parent = target.parent;
  return parent;
}

function buildEventPath(target) {
  const path = [target];
  const seen = new Set();
  seen.add(target);
  let node = target;
  for (;;) {
    const parent = eventParent(node);
    if (!(parent instanceof EventTarget) || seen.has(parent)) break;
    path.push(parent);
    seen.add(parent);
    node = parent;
  }
  return path;
}

function invokeListeners(target, event, state, mode) {
  const list = listenersFor(target, state.type);
  if (list === undefined || list.length === 0) return;
  state.currentTarget = target;
  const snapshot = list.slice();
  for (let index = 0; index < snapshot.length; index += 1) {
    if (state.immediateStopped) break;
    const record = snapshot[index];
    if (record.removed) continue;
    if (mode === "capture" && !record.capture) continue;
    if (mode === "bubble" && record.capture) continue;
    if (record.once) removeListenerRecord(target, record);
    try {
      if (typeof record.callback === "function") {
        record.callback.call(target, event);
      } else {
        const handleEvent = record.callback.handleEvent;
        if (typeof handleEvent !== "function") {
          throw invalidArg('The "listener" argument must have a "handleEvent" method');
        }
        handleEvent.call(record.callback, event);
      }
    } catch (error) {
      reportListenerError(error);
    }
  }
}

class EventTarget {
  addEventListener(type, callback, options) {
    if (arguments.length < 2) {
      throw missingArgs('The "type" and "listener" arguments must be specified');
    }
    const eventType = toDOMString(type, invalidArg('The "type" argument must be of type string. Received ' + describeValue(type)));
    if (callback === null || callback === undefined) return;
    validateListener(callback);
    const settings = readListenerOptions(options);
    if (settings.signal !== undefined) {
      if (!(settings.signal instanceof AbortSignal)) {
        throw invalidArg('The "signal" option must be an AbortSignal. Received ' + describeValue(settings.signal));
      }
      if (settings.signal.aborted) return;
    }
    const map = listenerMap(this);
    let list = map.get(eventType);
    if (list === undefined) {
      list = [];
      map.set(eventType, list);
    }
    for (let index = 0; index < list.length; index += 1) {
      const existing = list[index];
      if (existing.callback === callback && existing.capture === settings.capture) return;
    }
    const record = {
      type: eventType,
      callback: callback,
      capture: settings.capture,
      once: settings.once,
      passive: settings.passive,
      signal: settings.signal,
      abortHandler: null,
      removed: false,
    };
    list.push(record);
    if (settings.signal !== undefined) {
      const target = this;
      const abortHandler = function abortListener() {
        removeListenerRecord(target, record);
      };
      record.abortHandler = abortHandler;
      settings.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  removeEventListener(type, callback, options) {
    if (arguments.length < 2) {
      throw missingArgs('The "type" and "listener" arguments must be specified');
    }
    const eventType = toDOMString(type, invalidArg('The "type" argument must be of type string. Received ' + describeValue(type)));
    if (callback === null || callback === undefined) return;
    validateListener(callback);
    const settings = readListenerOptions(options);
    const list = listenersFor(this, eventType);
    if (list === undefined) return;
    for (let index = 0; index < list.length; index += 1) {
      const record = list[index];
      if (record.callback === callback && record.capture === settings.capture) {
        removeListenerRecord(this, record);
        return;
      }
    }
  }

  dispatchEvent(event) {
    if (arguments.length === 0) {
      throw missingArgs('The "event" argument must be specified');
    }
    if (!(event instanceof Event)) {
      throw invalidArg('The "event" argument must be an instance of Event. Received ' + describeValue(event));
    }
    const state = eventState(event);
    if (state.inDispatch) {
      throw makeError(Error, "ERR_EVENT_RECURSION", 'The event "' + state.type + '" is already being dispatched');
    }
    const path = buildEventPath(this);

    state.target = this;
    state.currentTarget = null;
    state.eventPhase = Event.NONE;
    state.path = path;
    state.propagationStopped = false;
    state.immediateStopped = false;
    state.inDispatch = true;

    try {
      // Capture: root towards the target's parent.
      for (let index = path.length - 1; index >= 1; index -= 1) {
        if (state.propagationStopped) break;
        state.eventPhase = Event.CAPTURING_PHASE;
        invokeListeners(path[index], event, state, "capture");
      }
      // At target: every listener, in registration order, regardless of capture.
      if (!state.propagationStopped && !state.immediateStopped) {
        state.eventPhase = Event.AT_TARGET;
        invokeListeners(this, event, state, "target");
      }
      // Bubble: target's parent towards the root, only when bubbles is set.
      if (state.bubbles && !state.propagationStopped && !state.immediateStopped) {
        for (let index = 1; index < path.length; index += 1) {
          if (state.propagationStopped) break;
          state.eventPhase = Event.BUBBLING_PHASE;
          invokeListeners(path[index], event, state, "bubble");
        }
      }
    } finally {
      state.currentTarget = null;
      state.eventPhase = Event.NONE;
      state.path = null;
      state.inDispatch = false;
    }

    return !state.defaultPrevented;
  }
}

clampTag(EventTarget.prototype, "EventTarget");

// ---------------------------------------------------------------------------
// AbortSignal / AbortController

const SIGNAL_STATE = new WeakMap();
const SIGNAL_HANDLERS = new WeakMap();
const SIGNAL_TOKEN = Symbol("AbortSignal internal");

function signalState(signal) {
  const state = SIGNAL_STATE.get(signal);
  if (state === undefined) throw new TypeError("Illegal invocation");
  return state;
}

function createAbortSignal() {
  return new AbortSignal(SIGNAL_TOKEN);
}

function makeAbortError() {
  return new DOMException("This operation was aborted", "AbortError");
}

function abortSignal(signal, reason) {
  const state = signalState(signal);
  if (state.aborted) return;
  state.aborted = true;
  state.reason = reason;
  const event = new Event("abort");
  eventState(event).trusted = true;
  signal.dispatchEvent(event);
}

class AbortSignal extends EventTarget {
  constructor(token) {
    if (token !== SIGNAL_TOKEN) throw makeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    super();
    SIGNAL_STATE.set(this, { aborted: false, reason: undefined });
    SIGNAL_HANDLERS.set(this, { handler: null, wrapper: null });
  }

  get aborted() {
    return signalState(this).aborted;
  }

  get reason() {
    return signalState(this).reason;
  }

  get onabort() {
    return SIGNAL_HANDLERS.get(this).handler;
  }

  set onabort(value) {
    const record = SIGNAL_HANDLERS.get(this);
    if (record.wrapper !== null) {
      this.removeEventListener("abort", record.wrapper);
      record.wrapper = null;
    }
    let handler = null;
    if (typeof value === "function" || (typeof value === "object" && value !== null)) {
      handler = value;
    }
    record.handler = handler;
    if (handler === null) return;
    const signal = this;
    const wrapper = function onabortHandler(event) {
      if (typeof handler === "function") {
        handler.call(signal, event);
        return;
      }
      const handleEvent = handler.handleEvent;
      if (typeof handleEvent !== "function") {
        throw invalidArg('The "onabort" handler must be a function or have a "handleEvent" method');
      }
      handleEvent.call(handler, event);
    };
    record.wrapper = wrapper;
    this.addEventListener("abort", wrapper);
  }

  throwIfAborted() {
    const state = signalState(this);
    if (state.aborted) throw state.reason;
  }
}

AbortSignal.abort = function abort(reason) {
  const signal = createAbortSignal();
  abortSignal(signal, reason === undefined ? makeAbortError() : reason);
  return signal;
};

AbortSignal.timeout = function timeout(milliseconds) {
  if (typeof milliseconds !== "number") {
    throw invalidArg('The "delay" argument must be of type number. Received ' + describeValue(milliseconds));
  }
  if (!Number.isFinite(milliseconds) || !Number.isInteger(milliseconds) || milliseconds < 0) {
    throw outOfRange('The value of "delay" is out of range. It must be a non-negative integer. Received ' + String(milliseconds));
  }
  const signal = createAbortSignal();
  const timer = globalThis.setTimeout(function timeoutElapsed() {
    abortSignal(signal, new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, milliseconds);
  // Node does not keep the loop alive for a timeout signal.
  if (timer !== null && typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  return signal;
};

AbortSignal.any = function any(signals) {
  if (signals === null || (typeof signals !== "object" && typeof signals !== "function") ||
      typeof signals[Symbol.iterator] !== "function") {
    throw invalidArg('The "signals" argument must be an iterable of AbortSignal. Received ' + describeValue(signals));
  }
  const list = [];
  for (const signal of signals) {
    if (!(signal instanceof AbortSignal)) {
      throw invalidArg('The "signals" argument must be an iterable of AbortSignal. Received ' + describeValue(signal));
    }
    list.push(signal);
  }
  for (let index = 0; index < list.length; index += 1) {
    if (list[index].aborted) return AbortSignal.abort(list[index].reason);
  }
  const derived = createAbortSignal();
  if (list.length === 0) return derived;

  const subscriptions = [];
  function cleanup() {
    for (let index = 0; index < subscriptions.length; index += 1) {
      const subscription = subscriptions[index];
      subscription.signal.removeEventListener("abort", subscription.handler);
    }
    subscriptions.length = 0;
  }
  for (let index = 0; index < list.length; index += 1) {
    const source = list[index];
    const handler = function sourceAborted() {
      if (derived.aborted) return;
      cleanup();
      abortSignal(derived, source.reason);
    };
    subscriptions.push({ signal: source, handler: handler });
    source.addEventListener("abort", handler);
  }
  return derived;
};

clampTag(AbortSignal.prototype, "AbortSignal");

const CONTROLLER_SIGNAL = new WeakMap();

class AbortController {
  constructor() {
    CONTROLLER_SIGNAL.set(this, createAbortSignal());
  }

  get signal() {
    return CONTROLLER_SIGNAL.get(this);
  }

  abort(reason) {
    const signal = CONTROLLER_SIGNAL.get(this);
    if (signal.aborted) return;
    abortSignal(signal, reason === undefined ? makeAbortError() : reason);
  }
}

clampTag(AbortController.prototype, "AbortController");

// ---------------------------------------------------------------------------
// structuredClone

const UNSUPPORTED_CLONE_TAGS = new Set([
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Promise",
  "Symbol",
  "URL",
  "URLSearchParams",
  "MessagePort",
  "Blob",
  "File",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
]);

function dataCloneError(message) {
  return new DOMException(message || "The object could not be cloned.", "DataCloneError");
}

function tagOf(value) {
  return Object.prototype.toString.call(value);
}

function cloneArrayBufferSource(source) {
  const length = source.byteLength;
  const copy = new ArrayBuffer(length);
  new Uint8Array(copy).set(new Uint8Array(source));
  return copy;
}

function cloneBuffer(source, memo) {
  const existing = memo.get(source);
  if (existing !== undefined) return existing;
  let copy;
  try {
    copy = cloneArrayBufferSource(source);
  } catch (_) {
    throw dataCloneError("An ArrayBuffer is detached and could not be cloned.");
  }
  memo.set(source, copy);
  return copy;
}

function cloneSharedArrayBuffer(source, memo) {
  const existing = memo.get(source);
  if (existing !== undefined) return existing;
  if (typeof SharedArrayBuffer !== "function") {
    throw dataCloneError("SharedArrayBuffer is not available and could not be cloned.");
  }
  let copy;
  try {
    copy = new SharedArrayBuffer(source.byteLength);
    new Uint8Array(copy).set(new Uint8Array(source));
  } catch (_) {
    throw dataCloneError("A SharedArrayBuffer could not be cloned.");
  }
  memo.set(source, copy);
  return copy;
}

function cloneErrorObject(value, memo) {
  let Ctor = Error;
  if (value instanceof TypeError) Ctor = TypeError;
  else if (value instanceof RangeError) Ctor = RangeError;
  else if (value instanceof SyntaxError) Ctor = SyntaxError;
  else if (value instanceof ReferenceError) Ctor = ReferenceError;
  else if (value instanceof EvalError) Ctor = EvalError;
  else if (value instanceof URIError) Ctor = URIError;

  const clone = new Ctor(value.message);
  memo.set(value, clone);
  if (typeof value.stack === "string") clone.stack = value.stack;
  if (Object.prototype.hasOwnProperty.call(value, "cause")) {
    // Node serializes `cause` as a non-enumerable own property (like the Error
    // constructor's `{ cause }` option), so JSON and for-in do not see it.
    Object.defineProperty(clone, "cause", {
      value: cloneValue(value.cause, memo),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  return clone;
}

function cloneDOMExceptionObject(value, memo) {
  const clone = new DOMException(value.message, value.name);
  memo.set(value, clone);
  if (typeof value.stack === "string") clone.stack = value.stack;
  return clone;
}

function cloneTypedArray(value, tag, memo) {
  const name = tag.slice(8, -1);
  const Ctor = globalThis[name];
  if (typeof Ctor !== "function") throw dataCloneError("Cannot clone object of unsupported type.");
  let buffer;
  let byteOffset;
  let length;
  try {
    buffer = cloneBuffer(value.buffer, memo);
    byteOffset = value.byteOffset;
    length = value.length;
  } catch (error) {
    if (error instanceof DOMException) throw error;
    throw dataCloneError("An ArrayBuffer is detached and could not be cloned.");
  }
  const clone = new Ctor(buffer, byteOffset, length);
  memo.set(value, clone);
  return clone;
}

function cloneDataViewObject(value, memo) {
  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = cloneBuffer(value.buffer, memo);
    byteOffset = value.byteOffset;
    byteLength = value.byteLength;
  } catch (error) {
    if (error instanceof DOMException) throw error;
    throw dataCloneError("An ArrayBuffer is detached and could not be cloned.");
  }
  const clone = new DataView(buffer, byteOffset, byteLength);
  memo.set(value, clone);
  return clone;
}

function cloneValue(value, memo) {
  if (value === null) return null;

  const type = typeof value;
  if (type === "undefined" || type === "boolean" || type === "number" ||
      type === "string" || type === "bigint") {
    return value;
  }
  if (type === "symbol") throw dataCloneError(tagOf(value) + " could not be cloned.");
  if (type === "function") throw dataCloneError("A function could not be cloned.");

  const memoized = memo.get(value);
  if (memoized !== undefined) return memoized;

  if (Array.isArray(value)) {
    const clone = new Array(value.length);
    memo.set(value, clone);
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      createDataProperty(clone, keys[index], cloneValue(value[keys[index]], memo));
    }
    return clone;
  }

  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    memo.set(value, clone);
    return clone;
  }

  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    memo.set(value, clone);
    return clone;
  }

  if (value instanceof Map) {
    const clone = new Map();
    memo.set(value, clone);
    for (const entry of value) {
      clone.set(cloneValue(entry[0], memo), cloneValue(entry[1], memo));
    }
    return clone;
  }

  if (value instanceof Set) {
    const clone = new Set();
    memo.set(value, clone);
    for (const item of value) clone.add(cloneValue(item, memo));
    return clone;
  }

  if (ArrayBuffer.isView(value)) {
    const tag = tagOf(value);
    if (tag === "[object DataView]") return cloneDataViewObject(value, memo);
    return cloneTypedArray(value, tag, memo);
  }

  const tag = tagOf(value);

  if (tag === "[object ArrayBuffer]") return cloneBuffer(value, memo);
  if (tag === "[object SharedArrayBuffer]") return cloneSharedArrayBuffer(value, memo);

  if (value instanceof DOMException || tag === "[object DOMException]") {
    return cloneDOMExceptionObject(value, memo);
  }

  if (value instanceof Error) return cloneErrorObject(value, memo);

  if (tag === "[object Number]" || tag === "[object String]" || tag === "[object Boolean]") {
    const name = tag.slice(8, -1);
    const clone = new globalThis[name](value.valueOf());
    memo.set(value, clone);
    return clone;
  }

  if (tag === "[object BigInt]") {
    const clone = Object(value.valueOf());
    memo.set(value, clone);
    return clone;
  }

  if (tag !== "[object Object]") {
    const tagName = tag.slice(8, -1);
    if (UNSUPPORTED_CLONE_TAGS.has(tagName) || tag === "[object Function]") {
      throw dataCloneError(tagName + " could not be cloned.");
    }
    // Anything else (a class instance, an object with a custom Symbol.toStringTag)
    // is serialized as a plain object, which is what Node's structured clone does.
  }

  const clone = {};
  memo.set(value, clone);
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    createDataProperty(clone, keys[index], cloneValue(value[keys[index]], memo));
  }
  return clone;
}

function normalizeTransferList(options) {
  if (options === undefined || options === null) return [];
  if (typeof options !== "object" && typeof options !== "function") return [];
  const transfer = options.transfer;
  if (transfer === undefined) return [];
  if (transfer === null || typeof transfer === "string" ||
      typeof transfer[Symbol.iterator] !== "function") {
    throw invalidArg("Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.");
  }
  const list = [];
  for (const item of transfer) {
    if (!(item instanceof ArrayBuffer) && tagOf(item) !== "[object ArrayBuffer]") {
      throw dataCloneError("Found invalid value in transferList.");
    }
    if (item.detached === true) {
      throw dataCloneError("Cannot transfer object of unsupported type.");
    }
    if (list.indexOf(item) !== -1) {
      throw dataCloneError("Transfer list contains duplicate ArrayBuffer");
    }
    list.push(item);
  }
  return list;
}

// Detaching is only possible through the engine's ArrayBuffer.prototype.transfer*.
// On an engine without it the clone is still produced; the source simply stays
// attached (a documented gap, not silently wrong data).
function detachBuffer(buffer) {
  try {
    if (typeof buffer.transfer === "function") {
      buffer.transfer(0);
      return;
    }
    if (typeof buffer.transferToFixedLength === "function") {
      buffer.transferToFixedLength(0);
      return;
    }
  } catch (_) {
    // Ignore: the clone itself is already correct.
  }
}

function structuredClone(value, options) {
  const transferList = normalizeTransferList(options);
  const memo = new Map();

  for (let index = 0; index < transferList.length; index += 1) {
    const source = transferList[index];
    let copy;
    try {
      copy = cloneArrayBufferSource(source);
    } catch (_) {
      throw dataCloneError("An ArrayBuffer is detached and could not be cloned.");
    }
    memo.set(source, copy);
  }

  const clone = cloneValue(value, memo);

  // Node only detaches the sources once serialization has succeeded.
  for (let index = 0; index < transferList.length; index += 1) {
    detachBuffer(transferList[index]);
  }
  return clone;
}

module.exports = {
  DOMException,
  Event,
  EventTarget,
  AbortController,
  AbortSignal,
  structuredClone,
};
