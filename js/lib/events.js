"use strict";

// `events` — EventEmitter and the `once`/`on` helpers.
//
// This is a JS implementation over no host primitives. It is deliberately
// self-contained: `util`, `process` and `AbortSignal` are only consulted at
// call time, and only when present, so the module loads before the rest of the
// stdlib exists.
//
// Divergence from Node (tracked in docs/compat.md):
//   - Listeners removed during an `emit` are *not* called, and listeners added
//     during an `emit` are not called by that emit. Node snapshots too, but a
//     removal during emission does not take effect until the next emit.
//   - `EventEmitter.captureRejections` is a symbol (the flag key) rather than
//     Node's boolean global. Assigning `EventEmitter.captureRejections = true`
//     still changes the default, and the `{ captureRejections: true }`
//     constructor option is Node-compatible.

const kEvents = Symbol("lite.events.eventsFrames");
const kCapture = Symbol("lite.events.captureRejections");
const captureRejectionsSymbol = kCapture;
const captureRejectionSymbol = Symbol.for("nodejs.rejection");
const errorMonitor = Symbol("events.errorMonitor");

const { abortError, invalidArgType } = require("./internal/errors.js");

let defaultCapture = false;
let captureWasAssigned = false;

const MAX_LISTENERS = 10;

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const text = value.length > 28 ? value.slice(0, 25) + "..." : value;
    return `'${text}'`;
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (typeof value === "object") {
    try {
      const keys = Object.keys(value);
      if (keys.length === 0) return Array.isArray(value) ? "[]" : "{}";
      return Array.isArray(value) ? `[${value.length} items]` : `{ ${keys.slice(0, 3).join(", ")} }`;
    } catch (_) {
      return typeof value;
    }
  }
  return String(value);
}

function checkListener(listener, name) {
  if (typeof listener !== "function") {
    throw invalidArgType(name || "listener", "function", listener);
  }
}

function checkOptions(options) {
  if (options === undefined) return {};
  if (options === null || (typeof options !== "object" && typeof options !== "function")) {
    throw invalidArgType("options", "object", options);
  }
  return options;
}

function checkSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
  }
  return signal;
}

function addAbortListener(signal, listener) {
  if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", listener, { once: true });
    return function removeAbortListener() {
      if (typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", listener);
      }
    };
  }
  const previous = signal.onabort;
  const wrapper = function onabort(event) {
    if (typeof previous === "function") previous.call(this, event);
    listener();
  };
  signal.onabort = wrapper;
  return function removeAbortListener() {
    if (signal.onabort === wrapper) signal.onabort = previous || null;
  };
}

function scheduleRejection(emitter, type, args, reason) {
  const task = function emitCapturedRejection() {
    const custom = emitter[captureRejectionSymbol];
    if (typeof custom === "function") {
      custom.call(emitter, reason, type, ...args);
      return;
    }
    emitter.emit("error", reason);
  };
  const proc = globalThis.process;
  if (proc && typeof proc.nextTick === "function") {
    proc.nextTick(task);
  } else if (typeof queueMicrotask === "function") {
    queueMicrotask(task);
  } else {
    Promise.resolve().then(task);
  }
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function unwrapOnce(listener) {
  return listener && typeof listener.listener === "function" ? listener.listener : listener;
}

function matches(listener, wanted) {
  return listener === wanted || (listener && listener.listener === wanted);
}

function unhandledError(args) {
  const value = args[0];
  if (value instanceof Error) return value;
  const err = new Error(`Unhandled error. (${describeValue(value)})`);
  err.code = "ERR_UNHANDLED_ERROR";
  err.context = value;
  return err;
}

// ---------------------------------------------------------------------------
// EventEmitter

function EventEmitter(options) {
  if (!(this instanceof EventEmitter)) return new EventEmitter(options);
  EventEmitter.init.call(this, options);
}

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = MAX_LISTENERS;
EventEmitter.errorMonitor = errorMonitor;
EventEmitter.captureRejectionSymbol = captureRejectionSymbol;

// The flag is a symbol (see the module comment), but the static property is an
// accessor so `EventEmitter.captureRejections = true` keeps working like Node's
// boolean default.
Object.defineProperty(EventEmitter, "captureRejections", {
  enumerable: true,
  configurable: true,
  get() {
    // Default reads expose the symbol flag (the onde API); after an
    // assignment, expose the assigned boolean like Node's static default.
    return captureWasAssigned ? defaultCapture : captureRejectionsSymbol;
  },
  set(value) {
    defaultCapture = Boolean(value);
    captureWasAssigned = true;
  },
});

EventEmitter.init = function init(options) {
  // Node's emitter internals are non-enumerable: `Object.keys(emitter)` is [].
  if (this._events === undefined) {
    Object.defineProperty(this, "_events", {
      value: Object.create(null),
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_eventsCount", {
      value: 0,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  if (this._maxListeners === undefined) {
    Object.defineProperty(this, "_maxListeners", {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  if (options !== undefined && options !== null) {
    if (typeof options !== "object" && typeof options !== "function") {
      throw invalidArgType("options", "object", options);
    }
  } else {
    options = undefined;
  }

  let capture;
  if (options !== undefined && options.captureRejections !== undefined) {
    if (typeof options.captureRejections !== "boolean") {
      throw invalidArgType("options.captureRejections", "boolean", options.captureRejections);
    }
    capture = options.captureRejections;
  } else if (this[kCapture] !== undefined) {
    capture = Boolean(this[kCapture]);
  } else {
    capture = defaultCapture;
  }

  Object.defineProperty(this, kCapture, {
    value: capture,
    writable: true,
    configurable: true,
    enumerable: false,
  });
};

EventEmitter.prototype._addListener = function addListenerInternal(type, listener, prepend) {
  checkListener(listener);

  const events = this._events;
  if (events.newListener !== undefined) {
    this.emit("newListener", type, unwrapOnce(listener));
  }

  const existing = events[type];
  if (existing === undefined) {
    events[type] = listener;
    this._eventsCount += 1;
  } else if (typeof existing === "function") {
    events[type] = prepend ? [listener, existing] : [existing, listener];
  } else if (prepend) {
    existing.unshift(listener);
  } else {
    existing.push(listener);
  }
  return this;
};

EventEmitter.prototype.on = function on(type, listener) {
  return this._addListener(type, listener, false);
};

EventEmitter.prototype.addListener = EventEmitter.prototype.on;

EventEmitter.prototype.prependListener = function prependListener(type, listener) {
  return this._addListener(type, listener, true);
};

EventEmitter.prototype.once = function once(type, listener) {
  checkListener(listener);
  this.on(type, onceWrapper(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener = function prependOnceListener(type, listener) {
  checkListener(listener);
  this.prependListener(type, onceWrapper(this, type, listener));
  return this;
};

function onceWrapper(target, type, listener) {
  let fired = false;
  function wrapper(...args) {
    if (fired) return undefined;
    fired = true;
    target.removeListener(type, wrapper);
    return listener.apply(this, args);
  }
  wrapper.listener = listener;
  return wrapper;
}

EventEmitter.prototype._pushFrame = function pushFrame(type, listeners) {
  let frames = this[kEvents];
  if (frames === undefined) {
    frames = Object.create(null);
    Object.defineProperty(this, kEvents, {
      value: frames,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  let stack = frames[type];
  if (stack === undefined) stack = frames[type] = [];
  const entries = new Array(listeners.length);
  for (let i = 0; i < listeners.length; i += 1) {
    entries[i] = { fn: listeners[i], active: true };
  }
  stack.push(entries);
  return entries;
};

EventEmitter.prototype._popFrame = function popFrame(type) {
  const frames = this[kEvents];
  if (frames === undefined) return;
  const stack = frames[type];
  if (stack === undefined) return;
  stack.pop();
  if (stack.length === 0) delete frames[type];
};

EventEmitter.prototype._deactivate = function deactivate(type, listener, all) {
  const frames = this[kEvents];
  if (frames === undefined) return;
  const stack = frames[type];
  if (stack === undefined || stack.length === 0) return;
  const entries = stack[stack.length - 1];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry.active) continue;
    if (all || matches(entry.fn, listener)) {
      entry.active = false;
      if (!all) return;
    }
  }
};

EventEmitter.prototype._captureRejection = function captureRejection(result, type, args) {
  if (!isThenable(result)) return;
  let scheduled = false;
  const onRejected = function onRejected(reason) {
    if (scheduled) return;
    scheduled = true;
    scheduleRejection(this, type, args, reason);
  }.bind(this);
  try {
    result.then(undefined, onRejected);
  } catch (err) {
    onRejected(err);
  }
};

EventEmitter.prototype.emit = function emit(type, ...args) {
  if (type === "error") {
    const events = this._events;
    if (events !== undefined && events[errorMonitor] !== undefined) {
      this.emit(errorMonitor, ...args);
    }
    if (this._events === undefined || this._events.error === undefined) {
      throw unhandledError(args);
    }
  }

  const events = this._events;
  const handler = events === undefined ? undefined : events[type];
  if (handler === undefined) return false;

  const capture = Boolean(this[kCapture]);

  if (typeof handler === "function") {
    const entries = this._pushFrame(type, [handler]);
    try {
      const result = handler.apply(this, args);
      if (capture) this._captureRejection(result, type, args);
    } finally {
      this._popFrame(type);
    }
    return true;
  }

  const entries = this._pushFrame(type, handler.slice());
  try {
    // Node snapshots the listener array and calls every entry: a listener removed by an
    // earlier listener still runs in this emit (it is gone for the next one). The `active`
    // flag only keeps the removed entry out of later snapshots.
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const result = entry.fn.apply(this, args);
      if (capture) this._captureRejection(result, type, args);
    }
  } finally {
    this._popFrame(type);
  }
  return true;
};

EventEmitter.prototype.removeListener = function removeListener(type, listener) {
  checkListener(listener);

  const events = this._events;
  const list = events[type];
  if (list === undefined) return this;

  this._deactivate(type, listener, false);

  if (typeof list === "function") {
    if (matches(list, listener)) {
      delete events[type];
      this._eventsCount -= 1;
      this._emitRemoveListener(type, unwrapOnce(list));
    }
    return this;
  }

  let position = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (matches(list[i], listener)) {
      position = i;
      break;
    }
  }
  if (position < 0) return this;

  const removed = list[position];
  list.splice(position, 1);
  if (list.length === 0) {
    delete events[type];
    this._eventsCount -= 1;
  } else if (list.length === 1) {
    events[type] = list[0];
  }
  this._emitRemoveListener(type, unwrapOnce(removed));
  return this;
};

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype._emitRemoveListener = function emitRemoveListener(type, listener) {
  const events = this._events;
  if (events !== undefined && events.removeListener !== undefined) {
    this.emit("removeListener", type, listener);
  }
};

EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
  const events = this._events;

  if (arguments.length === 0 || type === undefined) {
    const names = Reflect.ownKeys(events);
    for (let i = 0; i < names.length; i += 1) this.removeAllListeners(names[i]);
    this._events = Object.create(null);
    this._eventsCount = 0;
    return this;
  }

  const list = events[type];
  if (list === undefined) return this;

  this._deactivate(type, undefined, true);
  delete events[type];
  this._eventsCount -= 1;

  if (events.removeListener !== undefined) {
    if (typeof list === "function") {
      this.emit("removeListener", type, unwrapOnce(list));
    } else {
      const copy = list.slice();
      for (let i = 0; i < copy.length; i += 1) {
        this.emit("removeListener", type, unwrapOnce(copy[i]));
      }
    }
  }
  return this;
};

EventEmitter.prototype.listeners = function listeners(type) {
  const raw = this.rawListeners(type);
  const result = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) result[i] = unwrapOnce(raw[i]);
  return result;
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  const events = this._events;
  const list = events === undefined ? undefined : events[type];
  if (list === undefined) return [];
  return typeof list === "function" ? [list] : list.slice();
};

EventEmitter.prototype.listenerCount = function listenerCount(type, listener) {
  return countListeners(this, type, listener);
};

EventEmitter.prototype.eventNames = function eventNames() {
  return Reflect.ownKeys(this._events);
};

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== "number" || Number.isNaN(n) || n < 0) {
    const err = new RangeError(
      `The value of "n" is out of range. It must be a non-negative number. Received ${String(n)}`
    );
    err.code = "ERR_OUT_OF_RANGE";
    throw err;
  }
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  if (this._maxListeners === undefined) return EventEmitter.defaultMaxListeners;
  return this._maxListeners;
};

function countListeners(emitter, type, listener) {
  const events = emitter._events;
  const list = events === undefined ? undefined : events[type];
  if (list === undefined) return 0;
  if (typeof list === "function") {
    if (listener === undefined) return 1;
    return matches(list, listener) ? 1 : 0;
  }
  if (listener === undefined) return list.length;
  let count = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (matches(list[i], listener)) count += 1;
  }
  return count;
}

EventEmitter.listenerCount = function listenerCount(emitter, type, listener) {
  return countListeners(emitter, type, listener);
};

EventEmitter.getEventListeners = function getEventListeners(emitter, type) {
  if (emitter === null || typeof emitter !== "object") {
    throw invalidArgType("emitter", "EventEmitter or EventTarget", emitter);
  }
  if (typeof emitter.rawListeners === "function") return emitter.rawListeners(type);
  if (typeof emitter.listeners === "function") return emitter.listeners(type);
  return [];
};

EventEmitter.getMaxListeners = function getMaxListeners(emitter) {
  if (emitter && typeof emitter.getMaxListeners === "function") return emitter.getMaxListeners();
  return EventEmitter.defaultMaxListeners;
};

EventEmitter.setMaxListeners = function setMaxListeners(n, ...emitters) {
  for (let i = 0; i < emitters.length; i += 1) {
    const emitter = emitters[i];
    if (emitter && typeof emitter.setMaxListeners === "function") emitter.setMaxListeners(n);
  }
  return emitters;
};

// ---------------------------------------------------------------------------
// events.once

function attachOnce(emitter, name, listener) {
  if (emitter && typeof emitter.once === "function") {
    emitter.once(name, listener);
    return;
  }
  if (emitter && typeof emitter.addEventListener === "function") {
    emitter.addEventListener(name, listener, { once: true });
    return;
  }
  throw invalidArgType("emitter", "EventEmitter or EventTarget", emitter);
}

function attach(emitter, name, listener) {
  if (emitter && typeof emitter.on === "function") {
    emitter.on(name, listener);
    return;
  }
  if (emitter && typeof emitter.addEventListener === "function") {
    emitter.addEventListener(name, listener);
    return;
  }
  throw invalidArgType("emitter", "EventEmitter or EventTarget", emitter);
}

function detach(emitter, name, listener) {
  if (emitter && typeof emitter.removeListener === "function") {
    emitter.removeListener(name, listener);
    return;
  }
  if (emitter && typeof emitter.removeEventListener === "function") {
    emitter.removeEventListener(name, listener);
  }
}

EventEmitter.once = function once(emitter, name, options) {
  const opts = checkOptions(options);
  const signal = checkSignal(opts.signal);
  if (signal !== null && signal.aborted) {
    return Promise.reject(abortError(signal && "reason" in signal ? signal.reason : undefined));
  }

  return new Promise(function oncePromise(resolve, reject) {
    let settled = false;
    let removeAbort = null;

    function cleanup() {
      detach(emitter, name, resolver);
      if (name !== "error") detach(emitter, "error", errorListener);
      if (removeAbort !== null) {
        removeAbort();
        removeAbort = null;
      }
    }

    function resolver(...args) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(args);
    }

    function errorListener(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function abortListener() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal && "reason" in signal ? signal.reason : undefined));
    }

    attachOnce(emitter, name, resolver);
    if (name !== "error") attachOnce(emitter, "error", errorListener);
    if (signal !== null) removeAbort = addAbortListener(signal, abortListener);
  });
};

// ---------------------------------------------------------------------------
// events.on

EventEmitter.on = function on(emitter, name, options) {
  const opts = checkOptions(options);
  const signal = checkSignal(opts.signal);

  const queue = [];
  const pending = [];
  let storedError = null;
  let finished = false;
  let removeAbort = null;

  function cleanup() {
    detach(emitter, name, eventHandler);
    if (name !== "error") detach(emitter, "error", errorHandler);
    if (removeAbort !== null) {
      removeAbort();
      removeAbort = null;
    }
  }

  function eventHandler(...args) {
    if (finished) return;
    if (pending.length > 0) {
      pending.shift().resolve({ value: args, done: false });
    } else {
      queue.push(args);
    }
  }

  function errorHandler(err) {
    if (finished) return;
    if (pending.length > 0) {
      pending.shift().reject(err);
      const done = { value: undefined, done: true };
      while (pending.length > 0) pending.shift().resolve(done);
    } else if (storedError === null) {
      storedError = err;
    }
    finished = true;
    cleanup();
  }

  const iterator = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift(), done: false });
      }
      if (storedError !== null) {
        const err = storedError;
        storedError = null;
        return Promise.reject(err);
      }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise(function wait(resolve, reject) {
        pending.push({ resolve, reject });
      });
    },

    return() {
      finished = true;
      storedError = null;
      cleanup();
      const done = { value: undefined, done: true };
      while (pending.length > 0) pending.shift().resolve(done);
      return Promise.resolve(done);
    },

    throw(err) {
      if (!(err instanceof Error)) {
        throw invalidArgType("EventEmitter.AsyncIterator", "Error", err);
      }
      errorHandler(err);
      return undefined;
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  if (signal !== null && signal.aborted) {
    storedError = abortError(signal && "reason" in signal ? signal.reason : undefined);
    finished = true;
  } else {
    attach(emitter, name, eventHandler);
    if (name !== "error") attach(emitter, "error", errorHandler);
    if (signal !== null) {
      removeAbort = addAbortListener(signal, function abortListener() {
        errorHandler(abortError(signal && "reason" in signal ? signal.reason : undefined));
      });
    }
  }

  return iterator;
};

module.exports = EventEmitter;
