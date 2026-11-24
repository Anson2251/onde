"use strict";

// `internal/worker` — the shared core under `worker_threads` (M5, ADR-0008).
//
// Two roles, one module:
//
//   * on the main isolate it exports the `Worker` class and the in-thread `MessageChannel`;
//   * on a worker isolate it also owns `parentPort`, whose messages arrive through
//     `__ln_parent_message` (a global installed by `bootstrap.js`).
//
// Message payloads cross the Rust boundary, never a JS object directly: `host.worker` serializes a
// value on the calling isolate and the receiving isolate reconstructs it. A `SharedArrayBuffer`
// is the exception that matters: the engine's serializer shares the backing memory, so workers
// see each other's `Atomics` stores.

const { EventEmitter } = require("./events.js");
const { invalidArgType } = require("./errors.js");

const host = globalThis.__ln_host;
const info = host.workerInfo;
const isMainThread = info === null || info === undefined;
const threadId = isMainThread ? 0 : info.threadId;
const workerData = isMainThread ? null : info.workerData;

function dataCloneError(message) {
  const error = new Error(message);
  error.name = "DataCloneError";
  return error;
}

const untransferable = new WeakSet();

function markAsUntransferable(value) {
  if (value === null || typeof value !== "object") {
    throw invalidArgType("object", "object", value);
  }
  untransferable.add(value);
}

function isSharedArrayBuffer(value) {
  return typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
}

/// Validate Node's `transferList` shape. A `MessagePort` cannot be transferred between threads in
/// onde (D49); a marked-`untransferable` value is ignored rather than detaching.
function transferableBuffers(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw invalidArgType("transferList", "Array", list);
  const seen = new Set();
  const buffers = [];
  for (const item of list) {
    if (item instanceof MessagePort) {
      throw dataCloneError("Transferring MessagePort between threads is not supported by onde");
    }
    if (item instanceof ArrayBuffer) {
      if (seen.has(item)) throw dataCloneError("Transfer list contains duplicate ArrayBuffer");
      seen.add(item);
      if (!untransferable.has(item)) buffers.push(item);
      continue;
    }
    if (isSharedArrayBuffer(item)) continue; // already shared; Node ignores it here too
    throw dataCloneError(
      "Value in transferList must be an ArrayBuffer, SharedArrayBuffer or MessagePort",
    );
  }
  return buffers;
}

function detachBuffers(buffers) {
  for (const buffer of buffers) {
    try {
      host.detachBuffer(buffer);
    } catch {
      // A detached buffer is already unusable; nothing left to do.
    }
  }
}

// --- MessagePort -----------------------------------------------------------------------------

class MessagePort extends EventEmitter {
  constructor() {
    super();
    this._queue = [];
    this._other = null;
    this._started = false;
    this._closed = false;
    this._scheduled = false;
    this._onmessage = null;
    this._onmessageListener = null;
    // Set for `parentPort`: messages go to the parent through the host, not a local peer.
    this._parentId = null;
  }

  postMessage(value, transferList) {
    if (this._closed) return;
    const buffers = transferableBuffers(transferList);
    if (this._parentId !== null) {
      // The host serializes on this isolate; transfer entries are detached after the write.
      host.worker(this._parentId, "postMessage", [value, buffers]);
      return;
    }
    const peer = this._other;
    if (peer === null || peer._closed) return;
    // In-thread delivery copies (the sender keeps its buffer) but Node detaches the source on a
    // transfer, so match the observable half of that contract.
    detachBuffers(buffers);
    peer._enqueue(value);
  }

  _enqueue(value) {
    if (this._closed) return;
    this._queue.push(value);
    if (this._started) this._schedule();
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => {
      this._scheduled = false;
      while (!this._closed && this._queue.length > 0) {
        const value = this._queue.shift();
        this.emit("message", value);
      }
    });
  }

  // EventEmitter listeners are Node's auto-start: `parentPort.on("message", ...)` keeps a worker
  // alive until the port is closed or unref'd.
  on(event, listener) {
    super.on(event, listener);
    if (event === "message") this.start();
    return this;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  once(event, listener) {
    super.once(event, listener);
    if (event === "message") this.start();
    return this;
  }

  start() {
    if (this._started) return this;
    this._started = true;
    // Only `parentPort` has a parent-side loop ref to manage; in-thread ports are pure JS.
    if (this._parentId !== null) host.worker(this._parentId, "ref", []);
    if (this._queue.length > 0) this._schedule();
    return this;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._queue.length = 0;
    if (this._parentId !== null) host.worker(this._parentId, "unref", []);
    this.emit("close");
  }

  ref() {
    if (this._parentId !== null) host.worker(this._parentId, "ref", []);
    return this;
  }

  unref() {
    if (this._parentId !== null) host.worker(this._parentId, "unref", []);
    return this;
  }

  get onmessage() {
    return this._onmessageListener;
  }

  set onmessage(listener) {
    if (this._onmessage !== null) this.removeListener("message", this._onmessage);
    this._onmessageListener = typeof listener === "function" ? listener : null;
    if (this._onmessageListener === null) {
      this._onmessage = null;
      return;
    }
    const port = this;
    // Node's `onmessage` is the EventTarget face: the handler receives a MessageEvent, while
    // `port.on("message")` receives the value directly.
    this._onmessage = function (value) {
      listener.call(port, { type: "message", data: value, target: port });
    };
    this.on("message", this._onmessage);
    this.start();
  }
}

class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._other = this.port2;
    this.port2._other = this.port1;
  }
}

function receiveMessageOnPort(port) {
  if (!(port instanceof MessagePort)) {
    throw invalidArgType("port", "an instance of MessagePort", port);
  }
  if (port._queue.length === 0) return undefined;
  return { message: port._queue.shift() };
}

// --- parentPort (worker side only) ------------------------------------------------------------

const parentPort = isMainThread ? null : new MessagePort();
if (parentPort !== null) {
  parentPort._parentId = info.id;
  // Not started: an active listener starts the port and takes the worker's loop ref, exactly like
  // a Node worker that stays alive only while `parentPort` is listened to or `ref()`ed.
}

function onParentMessage(value) {
  if (parentPort !== null) parentPort._enqueue(value);
}

function onParentMessageError(message) {
  if (parentPort === null) return;
  const error = new Error(message);
  error.name = "DataCloneError";
  parentPort.emit("messageerror", error);
}

// --- Worker (main side, and nested workers) ---------------------------------------------------

class Worker extends EventEmitter {
  constructor(filename, options) {
    super();
    const settings = options === undefined || options === null ? {} : options;
    if (typeof settings !== "object") {
      throw invalidArgType("options", "object", settings);
    }

    let target = filename;
    if (target !== null && typeof target === "object" && typeof target.href === "string") {
      target = require("./url.js").fileURLToPath(target);
    }
    if (typeof target !== "string") {
      throw invalidArgType("filename", "string or an instance of URL", target);
    }

    const evalMode = settings.eval === true;
    const source = evalMode ? target : null;
    const path = evalMode ? "[worker eval]" : require("./path.js").resolve(target);

    this.threadId = undefined;
    this.argv = Array.isArray(settings.argv) ? settings.argv.slice() : [];
    this.resourceLimits = settings.resourceLimits === undefined ? {} : settings.resourceLimits;
    this._id = host.nextRequestId();
    this._exitResolvers = [];
    this._sink = (name, payload) => this._dispatch(name, payload);
    host.workers.register(this._id, this._sink);

    let assignedThreadId;
    try {
      const transfers = transferableBuffers(settings.transferList);
      assignedThreadId = host.worker(this._id, "spawn", [
        path,
        source,
        settings.workerData === undefined ? null : settings.workerData,
        this.argv.length > 0 ? this.argv : null,
        transfers,
      ]);
    } catch (error) {
      host.workers.release(this._id);
      throw error;
    }
    if (typeof assignedThreadId === "number") this.threadId = assignedThreadId;
  }

  _dispatch(name, payload) {
    switch (name) {
      case "online":
        if (typeof payload.threadId === "number") this.threadId = payload.threadId;
        this.emit("online");
        break;
      case "message":
        this.emit("message", payload);
        break;
      case "messageerror": {
        const error = new Error(payload.message);
        error.name = "DataCloneError";
        this.emit("messageerror", error);
        break;
      }
      case "error":
        // `payload` is already an Error built by the host from the worker's uncaught error.
        this.emit("error", payload);
        break;
      case "exit": {
        this.exitCode = payload.code;
        host.workers.release(this._id);
        this.emit("exit", payload.code);
        const resolvers = this._exitResolvers;
        this._exitResolvers = [];
        for (const resolve of resolvers) resolve(payload.code);
        break;
      }
      default:
        break;
    }
  }

  postMessage(value, transferList) {
    const buffers = transferableBuffers(transferList);
    // The host serializes and detaches the transferred buffers after a successful write.
    host.worker(this._id, "postMessage", [value, buffers]);
  }

  terminate() {
    return new Promise((resolve) => {
      this._exitResolvers.push(resolve);
      host.worker(this._id, "terminate", []);
    });
  }

  ref() {
    host.worker(this._id, "ref", []);
    return this;
  }

  unref() {
    host.worker(this._id, "unref", []);
    return this;
  }
}

// --- environment data ------------------------------------------------------------------------

// Process-wide in Node. onde keeps it per isolate for now: a worker starts with an empty map
// (M5 divergence, recorded in docs/compat.md).
const environmentData = new Map();

function setEnvironmentData(key, value) {
  if (typeof key === "string") environmentData.set(key, value);
}
function getEnvironmentData(key) {
  return environmentData.get(key);
}

module.exports = {
  isMainThread,
  parentPort,
  threadId,
  workerData,
  Worker,
  MessageChannel,
  MessagePort,
  receiveMessageOnPort,
  markAsUntransferable,
  getEnvironmentData,
  setEnvironmentData,
  onParentMessage,
  onParentMessageError,
  SHARE_ENV: Symbol("SHARE_ENV"),
};
