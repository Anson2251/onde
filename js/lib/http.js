"use strict";

// `http` — Node's HTTP/1.1 surface over `internal/http` and `net`.
//
// The public shape is Node's: `createServer`, `request`/`get`, `Server`, `Agent`/`globalAgent`,
// `STATUS_CODES`, `METHODS`, `maxHeaderSize` and the two header validators. Everything framing-
// related lives in `internal/http` (headers, `writeHead`, serialization, the message objects) and
// everything byte-level lives in Rust (`ln_http` through the handle bridge); see ADR-0007.
//
// `Server` *is* a `net.Server`: it inherits `listen`/`address`/`close`/`ref`/`unref`, and adds the
// HTTP policy — codec attach on `'connection'`, request/response objects, `checkContinue`,
// upgrades, `clientError` and the JS keep-alive/headers/request timers.

const internal = require("./internal/http.js");
const net = require("./net.js");
const { Server: NetServer } = net;

const {
  STATUS_CODES,
  METHODS,
  maxHeaderSize,
  DEFAULT_MAX_HEADERS,
  validateHeaderName,
  validateHeaderValue,
  attachServerSocket,
  IncomingMessage,
  OutgoingMessage,
  ServerResponse,
  ClientRequest,
  Agent,
  request: requestInternal,
} = internal;

// --- Server ----------------------------------------------------------------------------------

class Server extends NetServer {
  constructor(options, requestListener) {
    super(options);
    const settings = options === undefined || options === null ? {} : options;
    if (typeof settings !== "object") {
      throw internal.invalidArgType("options", "object", settings);
    }
    this.keepAliveTimeout = settings.keepAliveTimeout === undefined ? 5000 : settings.keepAliveTimeout;
    this.headersTimeout =
      settings.headersTimeout === undefined ? 60000 : settings.headersTimeout;
    this.requestTimeout =
      settings.requestTimeout === undefined ? 300000 : settings.requestTimeout;
    this.timeout = settings.timeout === undefined ? 0 : settings.timeout;
    this.maxRequestsPerSocket =
      settings.maxRequestsPerSocket === undefined ? 0 : settings.maxRequestsPerSocket;
    this.maxHeadersCount =
      settings.maxHeadersCount === undefined ? DEFAULT_MAX_HEADERS : settings.maxHeadersCount;
    this.maxHeaderSize =
      settings.maxHeaderSize === undefined ? maxHeaderSize : settings.maxHeaderSize;
    this._sessions = new Set();
    this._closing = false;

    if (typeof requestListener === "function") this.on("request", requestListener);

    // Runs before a user `'connection'` listener added after construction: the codec is attached
    // and the session's event observer installed before the first `read` can be issued.
    this.on("connection", (socket) => {
      if (this._closing) {
        socket.destroy();
        return;
      }
      attachServerSocket(this, socket);
    });
  }

  close(callback) {
    this._closing = true;
    return super.close(callback);
  }

  /// Node's Tier B convenience methods. They walk sockets rather than sessions: a session is
  /// created on the first byte (D73), so a connection that has not sent one has no session and is
  /// idle by definition.
  closeAllConnections() {
    if (this._sockets === undefined) return;
    for (const socket of this._sockets) socket.destroy();
  }

  closeIdleConnections() {
    if (this._sockets === undefined) return;
    for (const socket of this._sockets) {
      const session = socket._lnSession;
      if (session === undefined || (session.req === null && session.res === null)) {
        socket.destroy();
      }
    }
  }

  getConnections(callback) {
    const count = this._sockets === undefined ? 0 : this._sockets.size;
    if (typeof callback === "function") process.nextTick(callback, null, count);
    return count;
  }
}

/// Node's internal connection listener, exported for parity; `Server` attaches through
/// `attachServerSocket` directly.
function _connectionListener(socket) {
  attachServerSocket(this, socket);
}

function createServer(options, requestListener) {
  if (typeof options === "function") {
    requestListener = options;
    options = undefined;
  }
  return new Server(options, requestListener);
}

// --- client ----------------------------------------------------------------------------------

const globalAgent = new Agent();
internal.setGlobalAgent(globalAgent);

function request(...args) {
  return requestInternal(...args);
}

function get(...args) {
  const req = requestInternal(...args);
  req.end();
  return req;
}

// --- exports ---------------------------------------------------------------------------------

module.exports = {
  STATUS_CODES,
  METHODS,
  maxHeaderSize,
  Agent,
  globalAgent,
  ClientRequest,
  Server,
  ServerResponse,
  IncomingMessage,
  OutgoingMessage,
  _connectionListener,
  createServer,
  request,
  get,
  validateHeaderName,
  validateHeaderValue,
};
