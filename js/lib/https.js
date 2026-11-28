"use strict";

// `https` — the same surfaces as `http`, over a TLS transport.
//
// Nothing here re-implements HTTP: `internal/http` owns the object graph and the codec, and `tls`
// owns the handshake options. `https` contributes exactly three things (Node's own layering):
//
//   * `Agent.createConnection` is `tls.connect`, so the pool's sockets are TLS sockets and the
//     TLS options travel with the request options (they are never dropped by the agent),
//   * `Server` is an `http.Server` that carries `{ certPem, keyPem, alpn }` into `listen`, so the
//     Rust listener performs the handshake and only a successful one becomes a visible socket,
//   * the request defaults: an `https:` URL and port 443.
//
// `ca`, `cert`, `key`, `rejectUnauthorized`, `servername` and `ALPNProtocols` are the honoured
// options (m4-plan §2.5). Renegotiation, session reuse, client certificates and a full
// `getPeerCertificate()` are not implemented; D41 records that.

const http = require("./http.js");
const tls = require("./tls.js");
const internal = require("./internal/http.js");

let BufferCtor = null;
try {
    BufferCtor = require("buffer").Buffer;
} catch (_) {
    BufferCtor = require("./buffer.js");
}
const Buffer = BufferCtor;

// --- Agent -----------------------------------------------------------------------------------

/// The pooling layer for HTTPS. Everything (keep-alive, free sockets, queueing) is `http.Agent`;
/// only the socket factory and the protocol differ.
class Agent extends http.Agent {
    constructor(options) {
        super(options);
        this.protocol = "https:";
    }

    createConnection(options) {
        // `tls.connect` knows how to consume `options.tlsOptions` (see `tls.connect`), which is where
        // `ca`/`cert`/`key`/`rejectUnauthorized`/`servername`/`ALPNProtocols` live after
        // `https.request` normalized them.
        return tls.connect(options);
    }

    /// The pool key must include the TLS options: a socket opened with one `ca` (or with
    /// verification disabled) must never be reused for a request that asked for another. Node's
    /// `https.Agent.getName` appends the same fields for the same reason.
    getName(options) {
        return super.getName(options) + tlsPoolKey(options.tlsOptions);
    }
}

/// A compact, stable rendering of the TLS options for the agent's pool key.
function tlsPoolKey(tlsOptions) {
    if (tlsOptions === undefined || tlsOptions === null) return "";
    const ca =
        tlsOptions.ca === undefined || tlsOptions.ca === null
            ? ""
            : Buffer.from(tlsOptions.ca).toString("base64");
    const alpn = (tlsOptions.ALPNProtocols || []).join(",");
    return `:${tlsOptions.servername || ""}:${tlsOptions.rejectUnauthorized !== false}:${ca}:${alpn}`;
}

const globalAgent = new Agent({ keepAlive: true });

// --- Server ----------------------------------------------------------------------------------

class Server extends http.Server {
    constructor(options, requestListener) {
        super(options, requestListener);
        const settings = options === undefined || options === null ? {} : options;
        // Validated at creation like Node's `tls.createServer`: a missing cert/key is a throw, not a
        // surprise `error` on the first connection.
        this._tlsOptions = tls.serverOptions(settings);
        // Node's https.Server is a tls.Server, so it also reports `'secureConnection'`, after the
        // socket's TLS details are known (the `connected` event follows `connection`).
        this.on("connection", (socket) => {
            process.nextTick(() => {
                if (!socket.destroyed) this.emit("secureConnection", socket);
            });
        });
    }

    setSecureContext(options) {
        this._tlsOptions = tls.serverOptions(options);
        return this;
    }
}

function createServer(options, requestListener) {
    if (typeof options === "function") {
        requestListener = options;
        options = undefined;
    }
    return new Server(options, requestListener);
}

// --- client ----------------------------------------------------------------------------------

/// Normalize the arguments exactly like `http.request`, then add the two HTTPS differences: the
/// TLS payload and the default agent. `internal/http` does the rest, so header handling, framing
/// and keep-alive are one implementation.
function request(input, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = undefined;
    }
    const opts = internal.normalizeRequestOptions(input, options, "https:", 443);
    opts._tls = tls.tlsOptionsFrom(opts);
    if (opts.agent === undefined || opts.agent === null) {
        opts.agent = globalAgent;
    } else if (opts.agent === false) {
        opts.agent = new Agent({ keepAlive: false, maxSockets: 1 });
    }
    return internal.sendRequest(opts, callback);
}

function get(...args) {
    const req = request(...args);
    req.end();
    return req;
}

// --- exports ---------------------------------------------------------------------------------

module.exports = {
    STATUS_CODES: http.STATUS_CODES,
    METHODS: http.METHODS,
    maxHeaderSize: http.maxHeaderSize,
    Agent,
    globalAgent,
    Server,
    ClientRequest: http.ClientRequest,
    ServerResponse: http.ServerResponse,
    IncomingMessage: http.IncomingMessage,
    OutgoingMessage: http.OutgoingMessage,
    _connectionListener: http._connectionListener,
    createServer,
    request,
    get,
    validateHeaderName: http.validateHeaderName,
    validateHeaderValue: http.validateHeaderValue,
};
