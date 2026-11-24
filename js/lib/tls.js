"use strict";

// `tls` — Node's TLS surface over the M4 handle bridge.
//
// TLS is a transport wrapper, not a new protocol (ADR-0006 §2.9): rustls performs the handshake in
// the connection's task, and the resulting connection is the *same* `net.Socket`/handle a plain
// socket uses. Everything here is therefore argument normalization plus the options the bridge
// carries (`docs/m4-plan.md` §2.5):
//
//   connect: { servername, rejectUnauthorized, caPem, alpn }
//   listen:  { certPem, keyPem, alpn }
//
// The PEM files are read by the caller with `fs.readFileSync` and cross the boundary as bytes:
// one file-reading path, one error shape. rustls builds (and caches process-wide) one config per
// distinct option set, so an `https.Agent` with 100 sockets builds one config.
//
// Deliberately absent (recorded in `docs/compat.md` D41): renegotiation, session resumption
// (`isSessionReused()` is always false), client certificates, per-connection
// `minVersion`/`maxVersion`, and a full `getPeerCertificate()` (there is no X.509 parser in M4, so
// it returns `{}`).

const net = require("./net.js");
const internal = require("./internal/net.js");
const { invalidArgType, invalidArgValue } = require("./internal/errors.js");

let BufferCtor = null;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("./buffer.js");
}
const Buffer = BufferCtor;

/// Node's defaults for `tls.DEFAULT_MIN_VERSION` / `tls.DEFAULT_MAX_VERSION`. rustls negotiates
/// TLS 1.2/1.3; the constants are published for compatibility, not read per connection (D41).
const DEFAULT_MIN_VERSION = "TLSv1.2";
const DEFAULT_MAX_VERSION = "TLSv1.3";

function unsupported(feature) {
  const error = new Error(`${feature} is not supported by this runtime (TLS is rustls-based)`);
  error.code = "ERR_FEATURE_UNAVAILABLE";
  return error;
}

// --- PEM helpers -----------------------------------------------------------------------------

/// A PEM value: a string, a Buffer/Uint8Array, or an array of those concatenated with a newline
/// (Node allows `cert: [leaf, intermediate]`).
function pemBytes(value, name) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const part = pemBytes(item, name);
      if (part === null) throw invalidArgType(name, "string or an instance of Buffer", item);
      parts.push(part);
    }
    return Buffer.concat(parts.map((part) => Buffer.concat([part, Buffer.from("\n")])));
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw invalidArgType(name, "string or an instance of Buffer", value);
}

/// `ALPNProtocols` in preference order: an array of protocol names (strings or Buffers), or a
/// single name. An absent value means "do not offer ALPN".
function alpnList(value, name) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const protocols = [];
  for (const item of items) {
    if (typeof item === "string") {
      protocols.push(item);
    } else if (item instanceof Uint8Array) {
      protocols.push(Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString("latin1"));
    } else {
      throw invalidArgType(name, "string or an instance of Buffer", item);
    }
  }
  return protocols;
}

// --- option normalization --------------------------------------------------------------------

/// The TLS part of the client options, in Node's own key names so it can be spread back into a
/// second normalization pass (`https.Agent.createConnection` does exactly that).
function tlsOptionsFrom(options) {
  const ca = options.ca === undefined ? options.caPem : options.ca;
  return {
    servername: typeof options.servername === "string" ? options.servername : undefined,
    rejectUnauthorized: options.rejectUnauthorized !== false,
    ca: pemBytes(ca, "options.ca"),
    ALPNProtocols: alpnList(
      options.ALPNProtocols === undefined ? options.alpn : options.ALPNProtocols,
      "options.ALPNProtocols",
    ),
  };
}

/// The bridge's client payload (`{ servername, rejectUnauthorized, caPem, alpn }`).
function clientOptions(options) {
  const tls = tlsOptionsFrom(options);
  return {
    servername: tls.servername,
    rejectUnauthorized: tls.rejectUnauthorized,
    caPem: tls.ca,
    alpn: tls.ALPNProtocols,
  };
}

/// The bridge's server payload (`{ certPem, keyPem, alpn }`). Missing `cert`/`key` is an argument
/// error at creation, like Node's `tls.createServer` (the handshake itself is rustls').
function serverOptions(options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw invalidArgType("options", "object", opts);
  const cert = pemBytes(opts.cert, "options.cert");
  const key = pemBytes(opts.key, "options.key");
  if (cert === null || key === null) {
    throw invalidArgValue(
      "options",
      opts,
      'must contain "cert" and "key" for a TLS server',
    );
  }
  return {
    certPem: cert,
    keyPem: key,
    alpn: alpnList(opts.ALPNProtocols, "options.ALPNProtocols"),
  };
}

// --- TLSSocket -------------------------------------------------------------------------------

/// A connected TLS socket. It *is* a `net.Socket`: the handle, the stream behaviour and the
/// options are shared, and only the `encrypted`/`authorized`/ALPN surface differs.
class TLSSocket extends net.Socket {
  constructor(options) {
    super(options);
    this._encrypted = true;
    this._servername =
      options !== undefined && options.tlsOptions !== undefined && options.tlsOptions !== null
        ? options.tlsOptions.servername
        : undefined;
    // Node emits `'secureConnect'` *after* `'connect'`; deferring one tick keeps a user's
    // `connect` listener ahead of the secure one, as in Node.
    this.on("connect", () => {
      process.nextTick(() => {
        if (!this.destroyed) this.emit("secureConnect");
      });
    });
  }

  /// Node reports the SNI name (the connect host when the caller did not pass one).
  get servername() {
    return this._servername;
  }

  /// No session cache exists in M4, so this is always false (D41).
  isSessionReused() {
    return false;
  }
}

// --- connect ---------------------------------------------------------------------------------

/// `tls.connect(options[, callback])`, plus Node's `(port[, host][, options][, callback])` and
/// `(path[, callback])` overloads. The callback is the `'secureConnect'` listener.
function normalizeConnectArgs(args) {
  const first = args[0];
  if (typeof first === "number" && internal.isObject(args[1])) {
    const options = Object.assign({}, args[1], { port: first });
    return { options, callback: args[2] };
  }
  if (typeof first === "number" && typeof args[1] === "string" && internal.isObject(args[2])) {
    const options = Object.assign({}, args[2], { port: first, host: args[1] });
    return { options, callback: args[3] };
  }
  return internal.normalizeConnectArgs(args);
}

function connect(...args) {
  const parsed = normalizeConnectArgs(args);
  let options = parsed.options;
  // An `https.Agent` hands `tls.connect` the request options plus the already-normalized TLS
  // payload (`options.tlsOptions`); merge it in so one normalization path serves both callers.
  if (internal.isObject(options.tlsOptions)) {
    options = Object.assign({}, options.tlsOptions, options);
  }
  if (options.socket !== undefined && options.socket !== null) {
    // Wrapping an existing socket is a separate feature (it needs a `startTls` command).
    throw unsupported("tls.connect({ socket })");
  }
  const tlsOptions = clientOptions(options);
  const socket = new TLSSocket({
    allowHalfOpen: options.allowHalfOpen === true,
    tlsOptions,
  });
  socket._servername = tlsOptions.servername;
  if (typeof parsed.callback === "function") socket.once("secureConnect", parsed.callback);
  socket.connect(options);
  return socket;
}

// --- Server ----------------------------------------------------------------------------------

/// A `net.Server` whose accepted connections are TLS sockets: the Rust listener performs the
/// handshake in the connection's child task, and only a successful handshake becomes a visible
/// `'connection'` (which this class also re-emits as `'secureConnection'`).
class Server extends net.Server {
  constructor(options, listener) {
    const settings = options === undefined || options === null ? {} : options;
    super(settings);
    this._tlsOptions = serverOptions(settings);
    if (typeof listener === "function") this.on("secureConnection", listener);
    // The accepted socket's `connected` event (ALPN, TLS version) is dispatched right after
    // `connection`; deferring one tick makes sure a `secureConnection` listener sees a fully
    // described socket, and matches Node (whose secureConnection follows the handshake).
    this.on("connection", (socket) => {
      process.nextTick(() => {
        if (!socket.destroyed) this.emit("secureConnection", socket);
      });
    });
  }

  /// Node's `server.setSecureContext(options)`, applied to future connections.
  setSecureContext(options) {
    this._tlsOptions = serverOptions(options);
    return this;
  }
}

function createServer(options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }
  return new Server(options, listener);
}

module.exports = {
  TLSSocket,
  Server,
  connect,
  createConnection: connect,
  createServer,
  DEFAULT_MIN_VERSION,
  DEFAULT_MAX_VERSION,
  // Internal, used by `https`: the bridge payloads, in one place.
  tlsOptionsFrom,
  clientOptions,
  serverOptions,
};
