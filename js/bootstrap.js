// Bootstrap for lite-node: installs the Node surface on top of the host primitives.
//
// This file is evaluated as a classic script (global code, sloppy) before the entry point. It is
// deliberately the *only* global-installing code: stdlib modules live in js/lib/ and are loaded
// through the CommonJS loader defined in js/lib/loader.js.
//
// Order matters:
//   1. loader (needs only `host`)
//   2. timers and the callback table (process.nextTick needs the tick queue)
//   3. events -> process -> console
//   4. globals that other modules read at load time (TextEncoder, URL, Buffer, EventTarget)
//   5. module facade, rejection table, Rust->JS hooks.
(function () {
  "use strict";

  const g = globalThis;
  const host = g.__ln_host;
  if (host === undefined || host === null) {
    throw new Error("lite-node: host primitives are missing");
  }

  // --- internal module evaluation -------------------------------------------------------------

  function evalInternal(name) {
    const source = host.builtinSource(name);
    if (source === null || source === undefined) {
      throw new Error("lite-node: missing internal module " + name);
    }
    const module = {
      exports: {},
      filename: "<lite:" + name + ">",
      loaded: false,
      children: [],
      parent: null,
    };
    host.evalCjs(
      module.filename,
      source,
      module.exports,
      null,
      module,
      module.filename,
      "<lite>",
    );
    module.loaded = true;
    return module.exports;
  }

  Object.freeze(host);
  const loader = evalInternal("internal/loader");
  loader.install(host);

  // --- timers and callback dispatch -----------------------------------------------------------

  const TIMEOUT_MAX = 2147483647;

  function invalidArgType(name, expected, actual) {
    const received = typeof actual === "string" ? `'${actual}'` : String(actual);
    const error = new TypeError(
      `The "${name}" argument must be of type ${expected}. Received ${received}`,
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    return error;
  }

  // Node truncates the delay and clamps anything below 1 ms (or non-finite) to 1 ms.
  function normalizeDelay(value) {
    const delay = Number(value);
    if (!Number.isFinite(delay) || delay < 1 || delay > TIMEOUT_MAX) return 1;
    return Math.trunc(delay);
  }

  let nextCallbackId = 1;
  const callbacks = new Map(); // id -> { fn, args, repeat }
  const timerHandles = new Map(); // driver timer id -> Timeout
  const immediateHandles = new Map(); // driver immediate id -> Immediate

  function register(callback, args, repeat) {
    const id = nextCallbackId++;
    callbacks.set(id, { fn: callback, args, repeat });
    return id;
  }

  class Timeout {
    constructor(id, callbackId, repeat) {
      this._id = id;
      this._callbackId = callbackId;
      this._repeat = repeat;
      this._refed = true;
    }
    ref() {
      if (!this._refed) {
        this._refed = true;
        host.timerRef(this._id, true);
      }
      return this;
    }
    unref() {
      if (this._refed) {
        this._refed = false;
        host.timerRef(this._id, false);
      }
      return this;
    }
    hasRef() {
      return this._refed;
    }
    refresh() {
      return this;
    }
    close() {
      clearTimer(this);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  class Immediate {
    constructor(id, callbackId) {
      this._id = id;
      this._callbackId = callbackId;
      this._refed = true;
    }
    ref() {
      if (!this._refed) {
        this._refed = true;
        host.immediateRef(this._id, true);
      }
      return this;
    }
    unref() {
      if (this._refed) {
        this._refed = false;
        host.immediateRef(this._id, false);
      }
      return this;
    }
    hasRef() {
      return this._refed;
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  function timerIdOf(handle) {
    if (handle !== null && typeof handle === "object" && typeof handle._id === "number") {
      return handle._id;
    }
    if (typeof handle === "number") {
      return Number.isInteger(handle) && handle >= 0 ? handle : null;
    }
    if (typeof handle === "string") {
      const id = Number(handle);
      return Number.isInteger(id) && id >= 0 ? id : null;
    }
    // Node ignores anything else (undefined, null, symbols) instead of throwing.
    return null;
  }

  function timeout(callback, after, args, repeat) {
    if (typeof callback !== "function") {
      throw invalidArgType("callback", "function", callback);
    }
    const delay = normalizeDelay(after);
    const callbackId = register(callback, args, repeat);
    const id = host.setTimer(callbackId, delay, repeat);
    const handle = new Timeout(id, callbackId, repeat);
    timerHandles.set(id, handle);
    return handle;
  }

  function clearTimer(handle) {
    const id = timerIdOf(handle);
    if (id === null) return;
    if (host.clearTimer(id)) {
      const timer = timerHandles.get(id);
      if (timer !== undefined) {
        callbacks.delete(timer._callbackId);
        timerHandles.delete(id);
      }
    }
  }

  function setImmediateFn(callback, ...args) {
    if (typeof callback !== "function") {
      throw invalidArgType("callback", "function", callback);
    }
    const callbackId = register(callback, args, false);
    const id = host.setImmediate(callbackId);
    const handle = new Immediate(id, callbackId);
    immediateHandles.set(id, handle);
    return handle;
  }

  function clearImmediate(handle) {
    const id = timerIdOf(handle);
    if (id === null) return;
    if (host.clearImmediate(id)) {
      const immediate = immediateHandles.get(id);
      if (immediate !== undefined) {
        callbacks.delete(immediate._callbackId);
        immediateHandles.delete(id);
      }
    }
  }

  function scheduleTick(callback, args) {
    host.nextTick(register(callback, args, false));
  }

  // --- async ops ------------------------------------------------------------------------------

  // `__ln_op(name, args, options)` is the single bridge between the `fs` surfaces and the Rust
  // op table. Rust never holds a JS function: it calls `__ln_op_done(opId, error, value)` from
  // the completion dispatch, and the settler registered here runs synchronously inside that
  // dispatch (Node's callback semantics, including the throw path).

  let nextOpId = 1;
  const opSettlers = new Map(); // opId -> { resolve, reject } or { callback }

  function makeAbortError() {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    return error;
  }

  function removeAbortListener(entry) {
    if (entry.onAbort === undefined) return;
    try {
      entry.signal.removeEventListener("abort", entry.onAbort);
    } catch (_) {
      // A signal-like object with a throwing remover must not break settling.
    }
  }

  // Settle exactly once: the map entry is deleted before the callback runs, so a throw from the
  // user callback propagates out of `__ln_op_done` (routed to `uncaughtException`) and cannot
  // settle the same op again.
  function opDone(id, error, value) {
    const entry = opSettlers.get(id);
    if (entry === undefined) return;
    opSettlers.delete(id);
    removeAbortListener(entry);
    // An abort that raced the completion wins: ADR-0005 §2.7 says the promise settles once, with
    // ABORT_ERR, even when the syscall had already produced a value. Rust usually reports
    // `OpDone::Aborted`, but the flag can be set after the payload was parked.
    if ((error === undefined || error === null) && entry.signal !== undefined) {
      let aborted = false;
      try {
        aborted = entry.signal.aborted === true;
      } catch (_) {
        aborted = false;
      }
      if (aborted) error = makeAbortError();
    }
    if (entry.callback !== undefined) {
      entry.callback(error === undefined || error === null ? null : error, value);
      return;
    }
    if (error === undefined || error === null) entry.resolve(value);
    else entry.reject(error);
  }

  function op(name, args, options) {
    const settings = options === undefined || options === null ? {} : options;
    const id = nextOpId++;
    const callback = settings.callback;
    let entry;
    let result;
    if (callback !== undefined) {
      if (typeof callback !== "function") {
        throw invalidArgType("callback", "function", callback);
      }
      entry = { callback };
      result = undefined;
    } else {
      entry = {};
      result = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
    }
    opSettlers.set(id, entry);

    const signal = settings.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        // Node settles asynchronously even when the signal was already aborted.
        host.nextTick(register(() => opDone(id, makeAbortError(), undefined), [], false));
        return result;
      }
      const onAbort = () => {
        host.fsCancel(id);
      };
      entry.signal = signal;
      entry.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      host.fsAsync(id, name, args);
    } catch (error) {
      // Invalid arguments throw synchronously from both the callback and promise entry points
      // (Node does the same). Forget the settler and let the exception reach the caller.
      opSettlers.delete(id);
      removeAbortListener(entry);
      throw error;
    }
    return result;
  }

  // --- events, process, console ---------------------------------------------------------------

  const EventEmitter = loader.requireBuiltin("events");
  const createProcess = evalInternal("internal/process");
  const process = createProcess(host, EventEmitter, { nextTick: scheduleTick });
  g.process = process;

  g.console = loader.requireBuiltin("console");

  // Node installs the `perf_hooks` performance wrapper as the global at startup, so
  // `performance.mark`/`measure` exist without requiring the module. The module is standalone
  // (no stream/fs dependency), so evaluating it here is cheap.
  loader.requireBuiltin("perf_hooks");

  // --- globals that stdlib modules expect -----------------------------------------------------

  const url = loader.requireBuiltin("url");
  if (typeof g.URL !== "function") g.URL = url.URL;
  if (typeof g.URLSearchParams !== "function") g.URLSearchParams = url.URLSearchParams;

  const buffer = loader.requireBuiltin("buffer");
  if (typeof g.Buffer !== "function") g.Buffer = buffer.Buffer;

  let textcodec;
  try {
    textcodec = loader.requireBuiltin("internal/textcodec");
  } catch (_) {
    textcodec = null;
  }
  if (textcodec !== null) {
    if (typeof g.TextEncoder !== "function") g.TextEncoder = textcodec.TextEncoder;
    if (typeof g.TextDecoder !== "function") g.TextDecoder = textcodec.TextDecoder;
  }

  let web = {};
  try {
    web = loader.requireBuiltin("internal/globals");
  } catch (_) {
    web = {};
  }
  for (const name of [
    "Event",
    "EventTarget",
    "AbortController",
    "AbortSignal",
    "DOMException",
    "structuredClone",
  ]) {
    if (typeof g[name] === "undefined" && web[name] !== undefined) g[name] = web[name];
  }

  if (typeof g.atob !== "function") {
    g.atob = (input) => buffer.Buffer.from(String(input), "base64").toString("latin1");
  }
  if (typeof g.btoa !== "function") {
    g.btoa = (input) => buffer.Buffer.from(String(input), "latin1").toString("base64");
  }

  g.global = g;

  g.setTimeout = (callback, after, ...args) => timeout(callback, after, args, false);
  g.setInterval = (callback, after, ...args) => timeout(callback, after, args, true);
  g.clearTimeout = clearTimer;
  g.clearInterval = clearTimer;
  g.setImmediate = setImmediateFn;
  g.clearImmediate = clearImmediate;

  // --- module facade --------------------------------------------------------------------------

  const Module = loader.requireBuiltin("module");
  Module._install({
    createRequire: loader.createRequire,
    isBuiltin: loader.isBuiltin,
    builtinModules: loader.builtinNames(),
    cache: loader.cache,
    get main() {
      return loader.main;
    },
  });

  // --- rejection tracking ---------------------------------------------------------------------

  // The engine's rejection tracker calls `trackRejection` at settle (`is_handled === false`)
  // and when a handler is attached (`true`). `false` is a *candidate*, not "unhandled": the
  // host reports it only at the end of a checkpoint in which no handler appeared.
  const promiseIds = new WeakMap();
  const rejections = new Map(); // id -> { promise, reason, reported }
  let nextRejectionId = 1;

  function describe(value) {
    try {
      if (value instanceof Error) return value.name + ": " + value.message;
      return String(value);
    } catch (_) {
      return "<unprintable>";
    }
  }

  function trackRejection(promise, reason, isHandled) {
    let id = promiseIds.get(promise);
    if (!isHandled) {
      if (id !== undefined) return;
      id = nextRejectionId++;
      promiseIds.set(promise, id);
      rejections.set(id, { promise, reason, reported: false, weak: false });
      host.reject(id, describe(reason));
      return;
    }

    if (id === undefined) return;
    promiseIds.delete(promise);
    const state = rejections.get(id);
    if (state === undefined) return;
    if (state.weak) {
      // The reported promise is only held weakly; this tracker call has the real value again.
      state.promise = promise;
      state.weak = false;
    }
    state.reason = undefined;
    state.reported = true;
    host.handle(id);
  }

  function forgetRejection(id) {
    rejections.delete(id);
  }

  function makeError(name, message, stack, code) {
    const error = new Error(message);
    if (name) error.name = name;
    if (code !== undefined && code !== null) error.code = code;
    if (stack !== undefined && stack !== null) error.stack = stack;
    return error;
  }

  function emitUncaught(error) {
    if (process.listenerCount("uncaughtException") === 0) return false;
    process.emit("uncaughtException", error);
    return true;
  }

  function emitUnhandled(id) {
    const state = rejections.get(id);
    const reason = state === undefined ? undefined : state.reason;
    const promise = state === undefined ? undefined : state.promise;
    if (state !== undefined) state.reported = true;

    if (process.listenerCount("unhandledRejection") === 0) {
      // Node's default: an unhandled rejection becomes an uncaught exception. Rust catches this
      // throw and routes it through `uncaughtException`, so a listener there gets its chance.
      throw reason;
    }
    process.emit("unhandledRejection", reason, promise);
    // Keep only a weak reference after reporting: a rejection nobody ever handles must not pin
    // the promise forever. A late handler arrives with the promise itself, so it can be
    // re-strengthened for the deferred `rejectionHandled` event.
    if (state !== undefined) {
      state.promise = new WeakRef(state.promise);
      state.weak = true;
      state.reason = undefined;
    }
  }

  function emitRejectionHandled(id) {
    const state = rejections.get(id);
    if (state === undefined) return;
    rejections.delete(id);
    const promise = state.weak ? state.promise.deref() : state.promise;
    if (promise === undefined) return;
    process.emit("rejectionHandled", promise);
  }

  function emitBeforeExit(code) {
    process.emit("beforeExit", code);
  }

  function emitExit(code) {
    // Exit listeners observe the code that is about to become the process status.
    process.exitCode = code;
    process.emit("exit", code);
  }

  // --- Rust -> JS dispatch --------------------------------------------------------------------

  // kind: 0 = timer, 1 = immediate, 2 = nextTick, 3 = completion
  function dispatch(callbackId, handleId, kind) {
    const entry = callbacks.get(callbackId);
    if (entry === undefined) return;

    let thisArg;
    if (kind === 0) {
      const timer = timerHandles.get(handleId);
      if (!entry.repeat) {
        callbacks.delete(callbackId);
        timerHandles.delete(handleId);
      }
      thisArg = timer;
    } else if (kind === 1) {
      callbacks.delete(callbackId);
      thisArg = immediateHandles.get(handleId);
      immediateHandles.delete(handleId);
    } else {
      callbacks.delete(callbackId);
    }
    entry.fn.apply(thisArg, entry.args);
  }

  function requireCjsNamespace(filename) {
    return loader.loadCjsFile(filename, null);
  }

  function requireBuiltinExports(specifier) {
    return loader.requireBuiltin(specifier);
  }

  function builtinExportNames(specifier) {
    const namespace = loader.requireBuiltin(specifier);
    const names = new Set(Object.keys(namespace));
    // `process`, `console` and the module classes expose their methods on the prototype.
    // ESM facades must still re-export them: Node's `node:process` has `cwd`, `on`, ...
    let proto = Object.getPrototypeOf(namespace);
    while (proto !== null && proto !== Object.prototype && proto !== Function.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === "constructor") continue;
        try {
          if (namespace[key] !== undefined) names.add(key);
        } catch (_) {
          // A throwing getter is not an export we can copy; skip it like Node's facade would.
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    return Array.from(names);
  }

  function metaResolve(specifier, base) {
    return host.metaResolve(specifier, base);
  }

  function runCjsEntry(filename) {
    return loader.runMain(filename);
  }

  function formatResult(value) {
    const type = typeof value;
    if (value === null || (type !== "object" && type !== "function")) return String(value);
    try {
      return loader.requireBuiltin("util").inspect(value);
    } catch (_) {
      return String(value);
    }
  }

  function exposeRequire(directory) {
    const separator = host.platform === "win32" ? "\\" : "/";
    const root = String(directory).replace(/[\\/]+$/, "");
    const filename = root + separator + "[eval]";
    const require = loader.createRequire(filename);
    // Node's `-e` runs a synthetic module: `__filename` is "[eval]", `__dirname` is ".",
    // `module.id` is "[eval]" and the module is not `require.main`.
    const evalModule = {
      id: "[eval]",
      path: root,
      filename,
      exports: {},
      loaded: true,
      children: [],
      parent: null,
      paths: [],
      require,
    };
    for (const [name, value] of Object.entries({
      require,
      module: evalModule,
      __filename: "[eval]",
      __dirname: ".",
    })) {
      Object.defineProperty(g, name, {
        value,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    return require;
  }

  // Rust calls these functions; define them as non-enumerable so they do not show up in user
  // reflection but remain callable across the boundary.
  for (const [name, value] of Object.entries({
    __ln_track_rejection: trackRejection,
    __ln_make_error: makeError,
    __ln_forget_rejection: forgetRejection,
    __ln_emit_uncaught: emitUncaught,
    __ln_emit_unhandled: emitUnhandled,
    __ln_emit_rejection_handled: emitRejectionHandled,
    __ln_emit_before_exit: emitBeforeExit,
    __ln_emit_exit: emitExit,
    __ln_dispatch: dispatch,
    __ln_op: op,
    __ln_op_done: opDone,
    __ln_cjs_namespace: requireCjsNamespace,
    __ln_builtin_exports: requireBuiltinExports,
    __ln_builtin_export_names: builtinExportNames,
    __ln_meta_resolve: metaResolve,
    __ln_run_cjs: runCjsEntry,
    __ln_format_result: formatResult,
    __ln_expose_require: exposeRequire,
  })) {
    Object.defineProperty(g, name, {
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
})();
