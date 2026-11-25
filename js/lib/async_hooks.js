"use strict";

// `async_hooks` — createHook, executionAsyncId, AsyncLocalStorage and AsyncResource (M6).
//
// The identities come from the engine: every async resource is an id minted by Rust, every
// promise is tagged with its id, and every job carries the tag of the promise whose reaction it
// is (see docs/engine-patch.md and crates/ln-runtime/src/async_hooks.rs). This file owns the
// parts that are policy, not identity:
//
//   * the hook list and its five callbacks;
//   * the `id -> { type, trigger }` table behind `triggerAsyncId()` and
//     `executionAsyncResource()`;
//   * `AsyncLocalStorage`'s store table, and the inheritance rule that makes a store follow
//     `await`, `then`, timers, ticks and I/O callbacks;
//   * `AsyncResource`.
//
// Rust pushes events through `__ln_async_event` (installed below) and calls back into
// `host.asyncEnter`/`asyncLeave` around every callback, so the events are delivered in the same
// order they happen in the engine.
//
// Loading this module is what turns tracking on: until it runs (or `--async-stack-traces` is
// passed), the stdlib mints no ids and enters no contexts, so a program that never asks for
// `async_hooks` pays nothing per callback.
//
// Divergences from Node (docs/compat.md, D54-D58):
//   * `promiseResolve` fires for rejections too (Node's "settled"); the quickjs-ng upstream hook
//     only fired for fulfilments.
//   * Resources created before this module was loaded have no async id (D54).
//   * `AsyncLocalStorage.snapshot()` is absent (D55).
//   * A promise's `destroy` is emitted by a `FinalizationRegistry`, so it depends on a GC exactly
//     as in Node (D58).
//   * Net/http sockets and child processes do not mint their own resource ids yet: callbacks
//     inherit the context of whatever dispatched them (D57).

const { invalidArgType } = require("./internal/errors.js");

const host = globalThis.__ln_host;

const kInit = 0;
const kBefore = 1;
const kAfter = 2;
const kDestroy = 3;
const kResolve = 4;

// asyncId -> { type, trigger, resource }
const resources = new Map();

// Enabled hooks, split by callback so the hot paths do not re-check five properties. Rebuilt by
// `refresh()` whenever a hook is enabled or disabled.
const active = { init: [], before: [], after: [], destroy: [], promiseResolve: [] };
let tracking = false;

const alsInstances = new Set();

// Pruning for the resource table. An entry must not keep a promise alive (that would turn every
// tracked promise into a leak): the entry is deleted when the promise is collected, which is also
// when Node emits a promise's `destroy`.
let promiseFinalizer = null;

function invalidCallback(name) {
  const error = new TypeError(`hook.${name} must be a function`);
  error.code = "ERR_ASYNC_CALLBACK";
  return error;
}

// --- tracking switch -------------------------------------------------------------------------

// Rust emits only the kinds JavaScript subscribed to (bit `n` = event kind `n`). `init` is always
// wanted once tracking is on: it is what fills the trigger table and what carries an
// AsyncLocalStorage store into a child resource.
const WANT_INIT = 1;
const WANT_BEFORE = 2;
const WANT_AFTER = 4;
const WANT_DESTROY = 8;
const WANT_RESOLVE = 16;

const enabledHooks = [];

// Loading this module is what starts tracking: until then the runtime mints no ids and enters no
// contexts, so a program that never asks for `async_hooks` pays nothing per callback. Once
// started it stays on — a hook disabled later must not renumber or retag anything.
function ensureTracking() {
  if (tracking) return;
  tracking = true;
  host.asyncStart();
  host.asyncEnable(WANT_INIT);
}

function refresh() {
  for (const key of Object.keys(active)) active[key].length = 0;
  let mask = WANT_INIT;
  for (const hook of enabledHooks) {
    if (hook._init !== undefined) active.init.push(hook._init);
    if (hook._before !== undefined) {
      active.before.push(hook._before);
      mask |= WANT_BEFORE;
    }
    if (hook._after !== undefined) {
      active.after.push(hook._after);
      mask |= WANT_AFTER;
    }
    if (hook._destroy !== undefined) {
      active.destroy.push(hook._destroy);
      mask |= WANT_DESTROY;
    }
    if (hook._promiseResolve !== undefined) {
      active.promiseResolve.push(hook._promiseResolve);
      mask |= WANT_RESOLVE;
    }
  }
  if (promiseFinalizer === null) {
    // Prunes the resource table when a promise is collected, which is also when Node emits a
    // promise's `destroy`. Without it the table would retain one entry per promise forever.
    promiseFinalizer = new FinalizationRegistry((id) => {
      if (!resources.delete(id)) return;
      for (let i = 0, n = active.destroy.length; i < n; i++) {
        if (active.destroy[i] !== undefined) active.destroy[i](id);
      }
    });
  }
  if (tracking) host.asyncEnable(mask);
  return mask;
}

// --- the Rust -> JS event dispatch -------------------------------------------------------------

function dispatchAsyncEvent(kind, id, trigger, type, current, resource) {
  switch (kind) {
    case kInit: {
      const isPromise = type === "PROMISE" && resource !== null && typeof resource === "object";
      // A promise is held weakly, and only when a `destroy` hook may hand it back through
      // `executionAsyncResource()`; otherwise the entry is just the trigger and the registry
      // prunes it when the promise dies. Every other resource is a handle the stdlib owns anyway.
      const weak = isPromise && active.destroy.length !== 0;
      resources.set(id, {
        type,
        trigger,
        resource: weak ? new WeakRef(resource) : isPromise ? undefined : resource,
      });
      if (isPromise && promiseFinalizer !== null) promiseFinalizer.register(resource, id);
      if (alsInstances.size !== 0) {
        for (const als of alsInstances) {
          const store = als._stores.get(current);
          if (store !== undefined) als._stores.set(id, store);
        }
      }
      for (let i = 0, n = active.init.length; i < n; i++) {
        if (active.init[i] !== undefined) active.init[i](id, type, trigger, resource);
      }
      return;
    }
    case kBefore: {
      for (let i = 0, n = active.before.length; i < n; i++) {
        if (active.before[i] !== undefined) active.before[i](id);
      }
      return;
    }
    case kAfter: {
      for (let i = 0, n = active.after.length; i < n; i++) {
        if (active.after[i] !== undefined) active.after[i](id);
      }
      return;
    }
    case kDestroy: {
      const known = resources.delete(id);
      if (!known) return;
      for (let i = 0, n = active.destroy.length; i < n; i++) {
        if (active.destroy[i] !== undefined) active.destroy[i](id);
      }
      return;
    }
    case kResolve: {
      for (let i = 0, n = active.promiseResolve.length; i < n; i++) {
        if (active.promiseResolve[i] !== undefined) active.promiseResolve[i](id);
      }
      return;
    }
    default:
      return;
  }
}

Object.defineProperty(globalThis, "__ln_async_event", {
  value: dispatchAsyncEvent,
  writable: false,
  enumerable: false,
  configurable: false,
});

// Tell the stdlib that ids and contexts are wanted from here on. The flags are read per callback
// on the scheduling paths, so this is the one place that turns M6 tracking on.
const control = globalThis.__ln_async_control;
if (control !== undefined && control !== null) control.started = true;
ensureTracking();

// --- public ids --------------------------------------------------------------------------------

function executionAsyncId() {
  return host.asyncCurrent();
}

function triggerAsyncId() {
  const entry = resources.get(host.asyncCurrent());
  return entry === undefined ? 0 : entry.trigger;
}

function executionAsyncResource() {
  const entry = resources.get(host.asyncCurrent());
  if (entry === undefined || entry.resource === undefined) return {};
  if (entry.resource instanceof WeakRef) {
    const target = entry.resource.deref();
    return target === undefined ? {} : target;
  }
  return entry.resource;
}

// --- createHook --------------------------------------------------------------------------------

const kEnabled = Symbol("onde.async_hooks.enabled");

class AsyncHook {
  constructor(callbacks) {
    if (callbacks === null || typeof callbacks !== "object") {
      throw invalidArgType("options", "object", callbacks);
    }
    this._init = callbacks.init;
    this._before = callbacks.before;
    this._after = callbacks.after;
    this._destroy = callbacks.destroy;
    this._promiseResolve = callbacks.promiseResolve;
    for (const [name, value] of [
      ["init", this._init],
      ["before", this._before],
      ["after", this._after],
      ["destroy", this._destroy],
      ["promiseResolve", this._promiseResolve],
    ]) {
      if (value !== undefined && typeof value !== "function") {
        throw invalidCallback(name);
      }
    }
    this[kEnabled] = false;
  }

  // Node aliases the camelCase property; keep the same names for feature detection.
  get promiseResolve() {
    return this._promiseResolve;
  }

  enable() {
    if (this[kEnabled]) return this;
    this[kEnabled] = true;
    ensureTracking();
    enabledHooks.push(this);
    refresh();
    return this;
  }

  disable() {
    if (!this[kEnabled]) return this;
    this[kEnabled] = false;
    const index = enabledHooks.indexOf(this);
    if (index !== -1) enabledHooks.splice(index, 1);
    refresh();
    return this;
  }
}

function createHook(callbacks) {
  return new AsyncHook(callbacks);
}

// --- AsyncResource -----------------------------------------------------------------------------

const kId = Symbol("onde.async_hooks.id");
const kType = Symbol("onde.async_hooks.type");
const kTrigger = Symbol("onde.async_hooks.trigger");
const kDestroyed = Symbol("onde.async_hooks.destroyed");

class AsyncResource {
  constructor(type, opts) {
    if (typeof type !== "string") {
      throw invalidArgType("type", "string", type);
    }
    if (type.length === 0) {
      const error = new TypeError(`Invalid name for async "type": ${type}`);
      error.code = "ERR_ASYNC_TYPE";
      throw error;
    }
    ensureTracking();
    let trigger = 0;
    if (opts !== undefined && opts !== null && typeof opts === "object") {
      if (opts.triggerAsyncId !== undefined) {
        if (!Number.isInteger(opts.triggerAsyncId)) {
          throw invalidArgType("options.triggerAsyncId", "integer", opts.triggerAsyncId);
        }
        trigger = opts.triggerAsyncId;
      }
      if (opts.requireManualDestroy !== undefined && typeof opts.requireManualDestroy !== "boolean") {
        throw invalidArgType(
          "options.requireManualDestroy",
          "boolean",
          opts.requireManualDestroy,
        );
      }
    }
    this[kId] = host.asyncInit(type, trigger);
    this[kType] = type;
    this[kTrigger] = trigger > 0 ? trigger : host.asyncCurrent();
    this[kDestroyed] = false;
  }

  asyncId() {
    return this[kId];
  }

  triggerAsyncId() {
    return this[kTrigger];
  }

  runInAsyncScope(fn, thisArg, ...args) {
    if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
    const id = this[kId];
    const previous = host.asyncEnter(id);
    try {
      return fn.apply(thisArg, args);
    } finally {
      host.asyncLeave(id, previous);
    }
  }

  emitDestroy() {
    if (this[kDestroyed]) return;
    this[kDestroyed] = true;
    host.asyncDestroy(this[kId]);
  }

  bind(fn, thisArg) {
    if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
    const self = this;
    const receiver = thisArg;
    function bound(...args) {
      return self.runInAsyncScope(fn, receiver, ...args);
    }
    Object.defineProperty(bound, "name", { value: fn.name, configurable: true });
    return bound;
  }

  static bind(fn, type, thisArg) {
    if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
    const resource = new AsyncResource(type === undefined ? "bound-anonymous-fn" : type);
    return resource.bind(fn, thisArg);
  }
}

// --- AsyncLocalStorage -------------------------------------------------------------------------

// The store table is keyed by async id, not by a stack, which is what makes a store survive
// `await`: the continuation runs as a *job* whose id was created while the store was current, so
// `init` copied the store into that id before anything ran. `getStore()` is then one map lookup
// against `executionAsyncId()`.
//
// Inheritance happens at `init` time from the *currently executing* id (`current`), not from the
// trigger id: `p.then(cb)` inside `run()` must see the store even though `p` itself was created
// outside it, which is exactly Node's rule.
class AsyncLocalStorage {
  constructor(options) {
    this._stores = new Map();
    this._enabled = false;
    this._name = options !== undefined && options !== null ? options.name : undefined;
  }

  _enable() {
    if (this._enabled) return;
    this._enabled = true;
    ensureTracking();
    alsInstances.add(this);
    refresh();
  }

  run(store, callback, ...args) {
    if (typeof callback !== "function") throw invalidArgType("callback", "function", callback);
    this._enable();
    // One resource per `run`, so nested runs do not overwrite each other's store.
    const resource = new AsyncResource("AsyncLocalStorage");
    this._stores.set(resource.asyncId(), store);
    return resource.runInAsyncScope(callback, null, ...args);
  }

  // Node 24's explicit-resource-management form: bind the store to the current scope, run the
  // callback (whose return value is discarded, as in Node), and hand back a disposable scope.
  // The store stays active until `dispose()`, which is what `using scope = als.withScope(...)`
  // relies on.
  withScope(store, callback) {
    if (typeof callback !== "function") throw invalidArgType("callback", "function", callback);
    this._enable();
    const id = host.asyncCurrent();
    const had = this._stores.has(id);
    const previous = this._stores.get(id);
    this._stores.set(id, store);
    callback();
    const stores = this._stores;
    return new RunScope(() => {
      if (had) stores.set(id, previous);
      else stores.delete(id);
    });
  }

  enterWith(store) {
    this._enable();
    this._stores.set(host.asyncCurrent(), store);
  }

  exit(callback, ...args) {
    this._enable();
    const id = host.asyncCurrent();
    const had = this._stores.has(id);
    const previous = this._stores.get(id);
    this._stores.delete(id);
    try {
      return callback(...args);
    } finally {
      if (had) this._stores.set(id, previous);
    }
  }

  getStore() {
    return this._stores.get(host.asyncCurrent());
  }

  disable() {
    this._enabled = false;
    alsInstances.delete(this);
    this._stores.clear();
  }
}

// The handle `AsyncLocalStorage#withScope` returns (Node's `using` form).
class RunScope {
  constructor(restore) {
    // Non-enumerable so `util.inspect` prints `RunScope {}` like Node's internal class.
    Object.defineProperty(this, "_restore", {
      value: restore,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  dispose() {
    if (this._restore !== undefined) {
      const restore = this._restore;
      this._restore = undefined;
      restore();
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

// Node's provider table. Only the types onde actually mints appear; the rest are absent rather
// than lying about support.
const asyncWrapProviders = Object.freeze({
  NONE: 0,
  PROMISE: 1,
  Timeout: 2,
  Immediate: 3,
  TickObject: 4,
  Microtask: 5,
  FSREQCALLBACK: 6,
  GETADDRINFOREQWRAP: 7,
  AsyncLocalStorage: 8,
});

module.exports = {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
