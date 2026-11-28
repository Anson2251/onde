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

const { unrefTimer } = internal;
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
        this.keepAliveTimeout =
            settings.keepAliveTimeout === undefined ? 5000 : settings.keepAliveTimeout;
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
        this._closing = false;
        // One timer for every connection waiting on its first head (see `_armHeadersTimer`). A timer
        // per connection was the first thing this milestone removed: at 2,000 half-open connections it
        // cost ~1.2 KB each. The sweep keeps the deadline as a number on the socket instead.
        this._headersTimer = null;
        this._headersEarliest = Infinity;
        // Sockets accepted by this server, including sessionless ones. Not `net`'s `_connections`: for
        // https the socket handed to the HTTP layer is the TLS one, which belongs to the TLS server's
        // set, and this set is also what the deadline sweep walks. It is the one membership list the
        // close helpers and the first-head bound share (m7-plan §12.6).
        this._sockets = new Set();

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
        // Keep sweeping: a peer that was half-open at close() still holds a descriptor, and the
        // deadline it was given is the only thing that will reclaim it (D73, §12.6). The timer is
        // unref'd, so it cannot hold the loop open on its own.
        this._armHeadersTimer();
        return super.close(callback);
    }

    /// Arm the sweep for the earliest connection still waiting on its first request head.
    ///
    /// Node emits its headers timeout per socket; onde keeps a deadline on the socket and one sweep
    /// here, because a timer object per idle peer is exactly the per-connection cost the lazy session
    /// exists to avoid. Exactness is preserved: the timer is set for the earliest deadline and
    /// re-armed after each sweep.
    ///
    /// `deadline` is the one just taken at accept. When the armed timer already fires no later than
    /// it, nothing needs doing — which is the common case, because deadlines move forward with the
    /// clock. Without that shortcut every accept would rescan every socket, O(n²) on a 2,000-peer
    /// burst.
    _armHeadersTimer(deadline) {
        if (
            deadline !== undefined &&
            this._headersTimer !== null &&
            this._headersEarliest <= deadline
        ) {
            return;
        }
        let earliest = deadline === undefined ? Infinity : deadline;
        for (const socket of this._sockets) {
            const candidate = socket._lnHeadersDeadline;
            if (candidate !== undefined && candidate < earliest) earliest = candidate;
        }
        if (this._headersTimer !== null) {
            clearTimeout(this._headersTimer);
            this._headersTimer = null;
        }
        this._headersEarliest = Infinity;
        if (earliest === Infinity) return;
        this._headersEarliest = earliest;
        this._headersTimer = unrefTimer(
            setTimeout(() => this._sweepHeaders(), Math.max(0, earliest - Date.now())),
        );
    }

    _sweepHeaders() {
        this._headersTimer = null;
        this._headersEarliest = Infinity;
        const now = Date.now();
        const expired = [];
        for (const socket of this._sockets) {
            const deadline = socket._lnHeadersDeadline;
            if (deadline !== undefined && deadline <= now) expired.push(socket);
        }
        for (const socket of expired) {
            socket._lnHeadersDeadline = undefined;
            socket.destroy();
        }
        this._armHeadersTimer();
    }

    /// Node's Tier B convenience methods. They walk sockets rather than sessions: a session is
    /// created on the first byte (D73), so a connection that has not sent one has no session and is
    /// idle by definition.
    closeAllConnections() {
        // `Array.from`, like `net`'s own helpers: destroying a socket removes it from the set it is
        // being iterated.
        for (const socket of Array.from(this._sockets)) socket.destroy();
    }

    closeIdleConnections() {
        for (const socket of Array.from(this._sockets)) {
            const session = socket._lnSession;
            if (session === undefined || (session.req === null && session.res === null)) {
                socket.destroy();
            }
        }
    }

    getConnections(callback) {
        const count = this._sockets.size;
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
