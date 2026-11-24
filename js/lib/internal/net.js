"use strict";

// `internal/net` — the shared core under `net` (and, through `handleIdOf`, `http`/`https`).
//
// A network handle is an id plus a task (ADR-0006). This module owns everything that is not
// socket behaviour:
//
//   * the one id source (`nextId`), the per-id sink registry (`register`/`release`) and the
//     command entry point (`command`, wrapping `host.net`),
//   * the symbol that carries a handle id on a surface object and `handleIdOf`, the published
//     contract `http` uses to reach the same handle its `net.Socket` owns,
//   * argument normalization for `connect`/`listen` (Node's overloads),
//   * the payload helpers: `addressToNode` and `errorFromPayload`.
//
// Everything here is dependency-free (`js/lib/net.js` supplies `Buffer`-aware behaviour), so a
// surface can require it without creating a cycle.

// The shared coded-error vocabulary. `internal/errors` is itself a leaf, so this keeps the
// module's dependency-free property.
const {
  coded: codedError,
  invalidArgType,
  invalidArgValue,
} = require("./errors.js");

const kHandle = Symbol("onde.handle");
const kHandleListeners = Symbol("onde.handle.listeners");
const kParsed = Symbol("onde.handle.parsed");

// id -> surface object, used only to notice mode changes made through `command` (the HTTP
// surface calls `httpAttach`/`detach` directly). Ids are removed on `release`, so this cannot
// outlive a handle.
const socketsById = new Map();

// --- host bridge -----------------------------------------------------------------------------

function hostObject() {
  const host = globalThis.__ln_host;
  if (host === undefined || host === null) {
    const error = new Error("onde: host primitives are missing (net is a lite builtin)");
    error.code = "ERR_IO_BRIDGE";
    throw error;
  }
  return host;
}

// One id space per isolate (m4-plan §2.1): handles and ops draw from the same sequence, so an id
// is never ambiguous. Always mint through the host, never from a counter here.
function nextId() {
  return hostObject().nextRequestId();
}

function handleRegistry() {
  const host = hostObject();
  const handles = host.handles;
  if (handles === undefined || handles === null || typeof handles.register !== "function") {
    const error = new Error("onde: the handle registry (host.handles) is not installed");
    error.code = "ERR_IO_BRIDGE";
    throw error;
  }
  return handles;
}

// `sink(name, payload)` is invoked in task order by `__ln_handle_event` (bootstrap.js).
function register(id, sink) {
  handleRegistry().register(id, sink);
}

function release(id) {
  handleRegistry().release(id);
  socketsById.delete(Number(id));
}

// `host.net(id, name, args)`: one command, positional args, synchronous Node-shaped throws.
//
// The wrapper also records raw/parsed mode: `net.Socket` must not issue a raw `read` once the
// HTTP codec owns the connection, and a `detach` must clear a stale "read in flight" flag so the
// upgraded socket can pull raw bytes again.
function command(id, name, args) {
  const list = args === undefined ? [] : args;
  if (!Array.isArray(list)) throw invalidArgType("args", "Array", list);
  const socket = socketsById.get(Number(id));
  if (socket !== undefined) {
    if (name === "httpAttach") {
      socket[kParsed] = true;
      socket._reading = false;
      socket._readPaused = false;
    } else if (name === "detach") {
      socket[kParsed] = false;
      socket._reading = false;
    }
  }
  return hostObject().net(id, name, list);
}

function isHttpParsed(socket) {
  return socket !== null && typeof socket === "object" && socket[kParsed] === true;
}

// --- the handle contract ---------------------------------------------------------------------

// Attach the handle id to a surface object. Non-enumerable: it is internal state, not API.
function setHandleId(socket, id) {
  const previous = socket[kHandle];
  if (typeof previous === "number" && previous > 0 && socketsById.get(previous) === socket) {
    socketsById.delete(previous);
  }
  Object.defineProperty(socket, kHandle, {
    value: id,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  if (typeof id === "number" && id > 0) socketsById.set(id, socket);
  return id;
}

function handleIdOf(socket) {
  if (socket === null || typeof socket !== "object") {
    throw invalidArgType("socket", "net.Socket", socket);
  }
  const id = socket[kHandle];
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    const error = new TypeError(
      "The \"socket\" argument must be a net.Socket with a live handle id",
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  return id;
}

// Observe **every** handle event on `socket` without replacing the socket's own sink (the
// bootstrap registry keeps exactly one sink per id). Used by the HTTP surface to see
// request/response/body/messageEnd/upgrade/clientError while `net.Socket` keeps data/end/
// error/drain/closed. Returns an unsubscribe function.
//
// The listener runs after net.Socket has handled the event, so a `data` handler that pushes to
// the readable has already run when an observer sees the same event.
function onHandleEvent(socket, listener) {
  if (socket === null || typeof socket !== "object") {
    throw invalidArgType("socket", "object", socket);
  }
  if (typeof listener !== "function") throw invalidArgType("listener", "function", listener);
  let listeners = socket[kHandleListeners];
  if (listeners === undefined) {
    listeners = new Set();
    Object.defineProperty(socket, kHandleListeners, {
      value: listeners,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
  listeners.add(listener);
  return function unsubscribe() {
    listeners.delete(listener);
  };
}

// Called by the socket's own sink for every event, after its own dispatch.
function emitHandleEvent(socket, name, payload) {
  const listeners = socket[kHandleListeners];
  if (listeners === undefined || listeners.size === 0) return;
  for (const listener of Array.from(listeners)) {
    listener(name, payload);
  }
}

// --- errors ----------------------------------------------------------------------------------
//
// `codedError`, `invalidArgType` and `invalidArgValue` come from `internal/errors`; `describe`
// stays because the socket-specific errors below render values with it.

function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "function") return `function ${value.name || "anonymous"}`;
  const type = typeof value;
  if (type === "number" || type === "boolean" || type === "bigint") {
    return `type ${type} (${String(value)})`;
  }
  if (type === "symbol") return value.toString();
  const name = value && value.constructor && value.constructor.name;
  return `an instance of ${name || "Object"}`;
}

// Node uses ERR_SOCKET_BAD_PORT for both a wrong type and an out-of-range value in a port
// position; the error is a RangeError but the code is what callers match.
function socketBadPort(name, value) {
  return codedError(
    RangeError,
    "ERR_SOCKET_BAD_PORT",
    `${name} should be >= 0 and < 65536. Received ${describe(value)}.`,
  );
}

function missingArgs(names) {
  return codedError(
    TypeError,
    "ERR_MISSING_ARGS",
    `The ${names} argument must be specified`,
  );
}

// --- argument primitives ---------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFamily(family, name) {
  if (family === undefined || family === null || family === 0) return 0;
  if (family === 4 || family === "4" || family === "IPv4") return 4;
  if (family === 6 || family === "6" || family === "IPv6") return 6;
  throw invalidArgValue(name, family, "must be one of: 0, 4, 6");
}

function normalizePort(value, name) {
  // Node accepts a numeric string in `options.port` (`server.listen({ port: "8080" })`); it
  // still rejects a non-numeric one with ERR_SOCKET_BAD_PORT.
  let port = value;
  if (typeof port === "string" && port.length > 0) port = Number(port);
  if (
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw socketBadPort(name, value);
  }
  return port;
}

function normalizeBacklog(value) {
  if (value === undefined || value === null) return 511;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2147483647) {
    throw invalidArgType("options.backlog", "integer", value);
  }
  return value;
}

function normalizeOptionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidArgType(name, "string", value);
  return value;
}

function normalizePath(value, name) {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Uint8Array) {
    const BufferCtor = globalThis.Buffer;
    if (typeof BufferCtor === "function") {
      return BufferCtor.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
    }
    return new TextDecoder().decode(value);
  }
  if (typeof value !== "string") throw invalidArgType(name, "string", value);
  if (value.length === 0) throw invalidArgValue(name, value, "must be a non-empty string");
  return value;
}

function normalizeBoolean(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw invalidArgType(name, "boolean", value);
  return value;
}

function normalizeU32(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw invalidArgType(name, "integer", value);
  }
  return value;
}

// A callback in the last position of any overload.
function takeCallback(args, index) {
  const value = args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw invalidArgType("callback", "function", value);
  return value;
}

// --- connect argument normalization ----------------------------------------------------------

// Node's overloads:
//   connect(port[, host][, cb])
//   connect(options[, cb])          // where options.path selects a Unix socket
//   connect(path[, cb])
function normalizeConnectArgs(args) {
  let options;
  let callback;
  if (args.length === 0 || args[0] === undefined || args[0] === null) {
    throw missingArgs('"options", "port", or "path"');
  }
  const first = args[0];
  if (typeof first === "number") {
    const callbackIndex = typeof args[1] === "function" ? 1 : 2;
    const host =
      callbackIndex === 1 ? undefined : normalizeOptionalString(args[1], "host");
    callback = takeCallback(args, callbackIndex);
    options = { port: first };
    if (host !== undefined) options.host = host;
  } else if (typeof first === "string" || first instanceof Uint8Array) {
    // A string in the port position is a pipe path, exactly like Node.
    callback = takeCallback(args, 1);
    options = { path: first };
  } else if (isObject(first)) {
    callback = takeCallback(args, 1);
    options = first;
  } else {
    throw invalidArgType("options", "object, string, or number", first);
  }
  return { options, callback };
}

function normalizeConnectOptions(options) {
  const path = normalizePath(options.path, "options.path");
  const host =
    path === undefined
      ? normalizeOptionalString(options.host, "options.host") || "localhost"
      : undefined;
  let port;
  if (path === undefined) {
    if (options.port === undefined || options.port === null) {
      // Node reports a connect with neither port nor path as ERR_MISSING_ARGS; listen({}) is a
      // different error (ERR_INVALID_ARG_VALUE).
      throw missingArgs('"options", "port", or "path"');
    }
    port = normalizePort(options.port, "options.port");
  }
  const family = normalizeFamily(options.family, "options.family");
  const localAddress = normalizeOptionalString(options.localAddress, "options.localAddress");
  const localPort =
    options.localPort === undefined || options.localPort === null
      ? undefined
      : normalizePort(options.localPort, "options.localPort");
  const noDelay = normalizeBoolean(options.noDelay, "options.noDelay", true);
  // `keepAlive` is Node's boolean; the bridge takes the initial delay as `keepAliveMs`, where
  // `null` means "leave the OS default alone".
  let keepAliveMs = null;
  if (options.keepAlive === true) {
    keepAliveMs = normalizeU32(options.keepAliveInitialDelay, "options.keepAliveInitialDelay", 0);
  }
  return {
    host,
    port,
    path,
    family,
    localAddress,
    localPort,
    noDelay,
    keepAliveMs,
  };
}

// `host, port, path, family, localAddress, localPort, noDelay, keepAliveMs, tls`
//
// `tls` is the normalized client payload from `js/lib/tls.js` (`{ servername, rejectUnauthorized,
// caPem, alpn }`) or `null` for plaintext; the bridge validates it synchronously.
function connectHostArgs(settings, tls) {
  return [
    settings.host === undefined ? null : settings.host,
    settings.port === undefined ? null : settings.port,
    settings.path === undefined ? null : settings.path,
    settings.family === undefined ? null : settings.family,
    settings.localAddress === undefined ? null : settings.localAddress,
    settings.localPort === undefined ? null : settings.localPort,
    settings.noDelay,
    settings.keepAliveMs,
    tls === undefined ? null : tls,
  ];
}

// --- listen argument normalization -----------------------------------------------------------

// Node's overloads:
//   listen(port[, host][, cb])
//   listen(options[, cb])          // where options.path selects a Unix socket
//   listen(path[, cb])
function normalizeListenArgs(args) {
  let options;
  let callback;
  if (args.length === 0) {
    // Node's `server.listen()` binds port 0 on the unspecified address.
    return { options: { port: 0 }, callback: undefined };
  }
  if (args[0] === undefined || args[0] === null) {
    throw invalidArgValue("options", args[0], "must have the property \"port\" or \"path\"");
  }
  const first = args[0];
  if (typeof first === "number") {
    // listen(port[, host][, backlog][, cb])
    let index = 1;
    let host;
    if (typeof args[1] === "string") {
      host = args[1];
      index = 2;
    }
    options = { port: first };
    if (host !== undefined) options.host = host;
    if (typeof args[index] === "number") {
      options.backlog = args[index];
      index += 1;
    }
    callback = takeCallback(args, index);
  } else if (typeof first === "string" || first instanceof Uint8Array) {
    callback = takeCallback(args, 1);
    options = { path: first };
  } else if (isObject(first)) {
    callback = takeCallback(args, 1);
    options = first;
  } else {
    throw invalidArgType("options", "object, string, or number", first);
  }
  return { options, callback };
}

function normalizeListenOptions(options) {
  const path = normalizePath(options.path, "options.path");
  const host =
    path === undefined ? normalizeOptionalString(options.host, "options.host") : undefined;
  let port;
  if (path === undefined) {
    if (options.port === undefined || options.port === null) {
      throw invalidArgValue("options", options, "must have the property \"port\" or \"path\"");
    }
    port = normalizePort(options.port, "options.port");
  }
  return {
    // An omitted host binds the unspecified address (dual-stack `::`, then `0.0.0.0`): the Rust
    // listener treats the empty string as "no host" (m4-plan §4).
    host: host === undefined ? "" : host,
    port,
    path,
    backlog: normalizeBacklog(options.backlog),
    ipv6Only: normalizeBoolean(options.ipv6Only, "options.ipv6Only", false),
    exclusive: normalizeBoolean(options.exclusive, "options.exclusive", false),
  };
}

// `host, port, path, backlog, ipv6Only, exclusive, tls`
//
// `tls` is the normalized server payload from `js/lib/tls.js` (`{ certPem, keyPem, alpn }`).
function listenHostArgs(settings, tls) {
  return [
    settings.host === undefined ? null : settings.host,
    settings.port === undefined ? null : settings.port,
    settings.path === undefined ? null : settings.path,
    settings.backlog,
    settings.ipv6Only,
    settings.exclusive,
    tls === undefined ? null : tls,
  ];
}

// --- payload helpers -------------------------------------------------------------------------

// `{ address, family, port }` in Node's shape. Unix sockets report `family: "unix"` and `port: 0`
// (the host's `Addr::Unix` mapping), which is what `socket.address()` returns here.
function addressToNode(addr) {
  if (addr === null || addr === undefined || typeof addr !== "object") return null;
  return {
    address: String(addr.address),
    family: addr.family,
    port: addr.port,
  };
}

// The host converts a task error with the same table the op path uses, so the payload already is
// a JS `Error` with `code`/`errno` (negative)/`syscall`. Pass it through unchanged: wrapping it
// would lose the identity a `destroy(err)` round-trip relies on.
function errorFromPayload(payload) {
  return payload;
}

module.exports = {
  kHandle,
  kHandleListeners,
  nextId,
  register,
  release,
  command,
  setHandleId,
  handleIdOf,
  isHttpParsed,
  onHandleEvent,
  emitHandleEvent,
  addressToNode,
  errorFromPayload,
  // validation shared with the public surface and http
  invalidArgType,
  invalidArgValue,
  socketBadPort,
  missingArgs,
  normalizeFamily,
  normalizePort,
  normalizeConnectArgs,
  normalizeConnectOptions,
  connectHostArgs,
  normalizeListenArgs,
  normalizeListenOptions,
  listenHostArgs,
  normalizeBacklog,
  normalizeBoolean,
  normalizeU32,
  normalizeOptionalString,
  normalizePath,
  isObject,
};
