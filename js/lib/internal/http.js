"use strict";

// `internal/http` — the HTTP/1.1 object graph and policy layer over the bridge.
//
// The split is ADR-0007's: Rust (`ln-http`, through `ln_io`'s connection task) owns framing and
// parsing; this module owns everything that has to throw at the call site or make a policy
// decision:
//
//   * header validation (`ERR_INVALID_HTTP_TOKEN`, `ERR_INVALID_CHAR`), the lowercased `headers`
//     map and `rawHeaders` in wire order,
//   * `writeHead`, `Date`/`Connection`/`Transfer-Encoding`/`Content-Length` and the serialized
//     response head (the codec only parses it to learn the framing; it never re-serializes),
//   * `IncomingMessage` (a `Readable`), `OutgoingMessage`/`ServerResponse` (a `Writable`) and
//     `ClientRequest`,
//   * `Agent`, the idle-socket pool.
//
// Communication is one `host.net(id, name, args)` command stream and one event sink per handle.
// Handle events arrive through `internal/net`'s `onHandleEvent`, which composes with the socket's
// own sink: `net.Socket` keeps data/end/error/drain/closed, HTTP sees
// request/response/body/messageEnd/upgrade/clientError from the same connection.
//
// Deferred (recorded in the WP5 report): outbound trailers (`addTrailers` validates and stores
// them, but `ln-http`'s `finish` writes no trailer fields — Tier B), `writeEarlyHints`,
// `headersDistinct`, CONNECT tunnelling beyond the upgrade handover, and TLS (`https` surfaces
// `ERR_FEATURE_UNAVAILABLE` until WP6).

const host = globalThis.__ln_host;

let BufferCtor = null;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("../buffer.js");
}
const Buffer = BufferCtor;

let EventEmitterCtor = null;
try {
  EventEmitterCtor = require("events");
} catch (_) {
  EventEmitterCtor = require("../events.js");
}
const EventEmitter = EventEmitterCtor;

let streamModule = null;
try {
  streamModule = require("stream");
} catch (_) {
  streamModule = require("../stream.js");
}
const { Readable, Writable } = streamModule;

// The shared coded-error vocabulary. `internal/errors` is a leaf, so requiring it here cannot
// create a load-order cycle.
const {
  coded: codedError,
  invalidArgType,
  invalidArgValue,
} = require("./errors.js");

// `internal/net` owns the id source, the single-sink registry and `onHandleEvent`. `net` owns the
// socket and server classes. Both are loaded lazily so this module can be required first.
let internalNetModule = null;
function internalNet() {
  if (internalNetModule === null) {
    internalNetModule = require("./net.js");
  }
  return internalNetModule;
}

let netModule = null;
function net() {
  if (netModule === null) {
    netModule = require("../net.js");
  }
  return netModule;
}

// --- constants -------------------------------------------------------------------------------

const STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

const METHODS = [
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
];

/// Node's default `--max-http-header-size`; the codec's `Limits::default().max_head_bytes`.
const maxHeaderSize = 16 * 1024;
const DEFAULT_MAX_HEADERS = 2000;

/// Methods for which Node gives an empty body an explicit `Content-Length: 0`.
const EXPECTS_BODY = new Set(["POST", "PUT", "PATCH"]);

// --- errors ----------------------------------------------------------------------------------
//
// `codedError`, `invalidArgType` and `invalidArgValue` come from `internal/errors`; `describe`
// stays because the HTTP-specific errors below render values with it.

function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "function") return `function ${value.name || "anonymous"}`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `type ${typeof value} (${String(value)})`;
  }
  if (typeof value === "symbol") return value.toString();
  const name = value && value.constructor && value.constructor.name;
  return `an instance of ${name || "Object"}`;
}

function httpTokenError(name) {
  return codedError(
    TypeError,
    "ERR_INVALID_HTTP_TOKEN",
    `Header name must be a valid HTTP token [${JSON.stringify(String(name))}]`,
  );
}

function invalidCharError(what) {
  return codedError(TypeError, "ERR_INVALID_CHAR", `Invalid character in ${what}`);
}

function headersSentError() {
  return codedError(
    Error,
    "ERR_HTTP_HEADERS_SENT",
    "Cannot write headers after they are sent to the client",
  );
}

// --- header validation -----------------------------------------------------------------------

// RFC 9110 `token`: what `setHeader`/`writeHead`/`http.request` accept as a field name.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Node's `checkInvalidHeaderChar`: TAB plus visible ASCII plus obs-text. CR, LF, NUL and every
// other control byte are rejected, which is the request-smuggling defence that has to happen
// before the head is serialized.
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

function validateHeaderName(name) {
  if (typeof name !== "string" || name.length === 0 || !TOKEN.test(name)) {
    throw httpTokenError(name);
  }
}

function checkHeaderValue(name, value) {
  if (value === undefined) {
    throw codedError(
      TypeError,
      "ERR_HTTP_INVALID_HEADER_VALUE",
      `Invalid value "undefined" for header ${JSON.stringify(name)}`,
    );
  }
  let text;
  try {
    text = String(value);
  } catch (_) {
    throw invalidArgType("value", "string", value);
  }
  if (INVALID_HEADER_CHAR.test(text)) throw invalidCharError(`header content [${JSON.stringify(name)}]`);
}

function validateHeaderValue(name, value) {
  validateHeaderName(name);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) checkHeaderValue(String(name), value[i]);
    return;
  }
  checkHeaderValue(String(name), value);
}

function normalizeHeaderValue(name, value) {
  validateHeaderName(name);
  if (Array.isArray(value)) {
    const list = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      checkHeaderValue(String(name), value[i]);
      list[i] = String(value[i]);
    }
    return list;
  }
  checkHeaderValue(String(name), value);
  return String(value);
}

// --- inbound headers -------------------------------------------------------------------------

/// Wire-order `[name, value, ...]` -> Node's lowercased `headers` map.
///
/// `set-cookie` keeps every value as an array. Every other duplicate is joined in wire order, but
/// `cookie` joins with `"; "` rather than `", "`: the Cookie header's grammar is a semicolon list,
/// and Node deliberately preserves that so `req.headers.cookie` can be split on `"; "` (m4-plan
/// §5). The map has a null prototype, like Node's.
function headersFromRaw(raw) {
  const headers = Object.create(null);
  if (!Array.isArray(raw)) return headers;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = String(raw[i]);
    const value = String(raw[i + 1]);
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      const current = headers[key];
      if (Array.isArray(current)) current.push(value);
      else headers[key] = [value];
    } else if (headers[key] === undefined) {
      headers[key] = value;
    } else {
      headers[key] = `${headers[key]}${key === "cookie" ? "; " : ", "}${value}`;
    }
  }
  return headers;
}

function headerTokenIncludes(headers, name, token) {
  const value = headers[name];
  if (typeof value !== "string") return false;
  const parts = value.split(",");
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].trim().toLowerCase() === token) return true;
  }
  return false;
}

function versionString(version) {
  return version === 0x10 ? "1.0" : "1.1";
}

// --- body rules ------------------------------------------------------------------------------

/// No body after a response to HEAD, or for 1xx/204/304 (m4-plan §5; RFC 9112 §6.3).
function responseHasBody(method, status) {
  if (method === "HEAD") return false;
  if (status >= 100 && status < 200) return false;
  if (status === 204 || status === 304) return false;
  return true;
}

function byteLength(chunk, encoding) {
  if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding || "utf8");
  return chunk.length;
}

function asBuffer(chunk, encoding) {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding || "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

// --- IncomingMessage -------------------------------------------------------------------------

/// The readable side of one request (server) or response (client).
///
/// Body bytes arrive de-framed from the codec, so `'data'` never sees chunk sizes. Backpressure
/// is real: pushing past the high-water mark sends `readStop`, and `_read` sends `read` to resume
/// the Rust task (m4-plan §4).
class IncomingMessage extends Readable {
  constructor(socket, role) {
    super();
    this.socket = socket || null;
    this.connection = this.socket;
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.headers = Object.create(null);
    this.rawHeaders = [];
    this.trailers = Object.create(null);
    this.rawTrailers = [];
    this.complete = false;
    this.aborted = false;
    this.upgrade = false;
    this.method = undefined;
    this.url = undefined;
    this.statusCode = undefined;
    this.statusMessage = undefined;
    this._role = role;
    this._handleId = -1;
    this._paused = false;
    this._messageEnded = false;
    this._server = null;
    this._session = null;
  }

  _read() {
    if (this._paused && !this._messageEnded && this._handleId > 0) {
      this._paused = false;
      internalNet().command(this._handleId, "read", []);
    }
  }

  pause() {
    if (!this._paused && !this._messageEnded && this._handleId > 0) {
      this._paused = true;
      internalNet().command(this._handleId, "readStop", []);
    }
    return super.pause();
  }

  resume() {
    if (this._paused && !this._messageEnded && this._handleId > 0) {
      this._paused = false;
      internalNet().command(this._handleId, "read", []);
    }
    return super.resume();
  }

  pushBody(bytes) {
    if (this._messageEnded || this.destroyed) return;
    this.push(Buffer.from(bytes));
    const state = this._readableState;
    if (!this._paused && state && state.length >= state.highWaterMark) {
      this._paused = true;
      internalNet().command(this._handleId, "readStop", []);
    }
  }

  pushTrailers(raw) {
    this.rawTrailers = Array.isArray(raw) ? raw.slice() : [];
    this.trailers = headersFromRaw(raw);
  }

  pushEnd(rawTrailers) {
    if (this._messageEnded) return;
    this._messageEnded = true;
    this.complete = true;
    if (rawTrailers !== undefined) this.pushTrailers(rawTrailers);
    this.push(null);
  }

  setTimeout(msecs, callback) {
    if (this.socket) this.socket.setTimeout(msecs, callback);
    return this;
  }

  destroy(error) {
    if (this.socket) this.socket.destroy(error);
    return super.destroy(error);
  }

  _setRequest(payload) {
    this.method = payload.method;
    this.url = payload.target;
    this._applyHead(payload);
    return this;
  }

  _setResponse(payload) {
    this.statusCode = payload.status;
    this.statusMessage = payload.reason;
    this._applyHead(payload);
    return this;
  }

  _applyHead(payload) {
    this.httpVersion = versionString(payload.version);
    this.httpVersionMajor = 1;
    this.httpVersionMinor = payload.version === 0x10 ? 0 : 1;
    this.rawHeaders = Array.isArray(payload.headers) ? payload.headers.slice() : [];
    this.headers = headersFromRaw(payload.headers);
    this.shouldKeepAlive = Boolean(payload.keepAlive);
  }
}

// --- OutgoingMessage -------------------------------------------------------------------------

/// Base for responses and requests: header storage, `writeHead`/`setHeader` validation, and the
/// one `Writable` path that turns chunks into `httpBody` commands.
class OutgoingMessage extends Writable {
  constructor() {
    // The writable half finishing must not destroy the connection: a server response finishing on
    // a keep-alive socket and a client request finishing before its response arrives both outlive
    // the stream's writable side.
    super({ autoDestroy: false });
    this._headers = new Map();
    this._header = null;
    this._headerSent = false;
    this._contentLength = null;
    this._chunkedEncoding = false;
    this._sentEnd = false;
    this.sendDate = true;
    this.shouldKeepAlive = true;
    this._trailers = null;
    this.socket = null;
    this.connection = null;
    this._handleId = -1;
    this._agent = null;
  }

  // -- header API -----------------------------------------------------------------------------

  setHeader(name, value) {
    // Node lets `name` be a string only; a number in the name position is a token error.
    if (typeof name !== "string") throw httpTokenError(name);
    if (this._headerSent) throw headersSentError();
    this._headers.set(name.toLowerCase(), {
      name,
      value: normalizeHeaderValue(name, value),
    });
    return this;
  }

  appendHeader(name, value) {
    validateHeaderValue(name, value);
    if (this._headerSent) throw headersSentError();
    const key = name.toLowerCase();
    const current = this._headers.get(key);
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const next = current === undefined
      ? values
      : (Array.isArray(current.value) ? current.value.slice() : [current.value]).concat(values);
    this._headers.set(key, { name: current === undefined ? name : current.name, value: next });
    return this;
  }

  getHeader(name) {
    const entry = this._headers.get(String(name).toLowerCase());
    return entry === undefined ? undefined : entry.value;
  }

  getHeaders() {
    const headers = Object.create(null);
    for (const [key, entry] of this._headers) {
      headers[key] = Array.isArray(entry.value) ? entry.value.slice() : entry.value;
    }
    return headers;
  }

  getHeaderNames() {
    return Array.from(this._headers.keys());
  }

  getRawHeaderNames() {
    const names = [];
    for (const entry of this._headers.values()) names.push(entry.name);
    return names;
  }

  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }

  removeHeader(name) {
    if (this._headerSent) throw headersSentError();
    this._headers.delete(String(name).toLowerCase());
  }

  get headersSent() {
    return this._headerSent;
  }

  get finished() {
    return Boolean(this._writableState && this._writableState.ending);
  }

  // -- body flow ------------------------------------------------------------------------------

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    // Node's `OutgoingMessage` reports a write after `end()` asynchronously on the response and
    // does not destroy it, so the `'finish'` already scheduled by the first `end()` still runs.
    // The generic `Writable` path destroys the stream (correct for a socket, where no reply can
    // follow a FIN), which would suppress `'finish'`; the message owns the rule here instead.
    const state = this._writableState;
    if (state !== undefined && state.ending) {
      const error = codedError(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end");
      if (typeof callback === "function") process.nextTick(callback, error);
      process.nextTick(() => {
        if (!this.destroyed) this.emit("error", error);
      });
      return false;
    }
    // A client request with a body and no declared length is chunked; the head has to say so
    // before the first chunk goes out. A server response has its own rule (chunked by default on
    // HTTP/1.1), so `_writeStarted` is only read by `ClientRequest`.
    this._writeStarted = true;
    if (!this._headerSent && !this.destroyed) this._implicitHeader();
    return super.write(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    // A second `end()` with no chunk is a no-op in Node; with a chunk it is a write after end,
    // which `write` reports (Writable.end forwards the chunk through it).
    if (!this._headerSent && !this.destroyed) this._prepareEnd(chunk, encoding);
    return super.end(chunk, encoding, callback);
  }

  flushHeaders() {
    if (!this._headerSent && !this.destroyed) this._implicitHeader();
    return this;
  }

  setTimeout(msecs, callback) {
    if (this.socket) this.socket.setTimeout(msecs, callback);
    return this;
  }

  addTrailers(headers) {
    if (headers === null || typeof headers !== "object") {
      throw invalidArgType("headers", "object", headers);
    }
    const trailers = new Map();
    for (const name of Object.keys(headers)) {
      trailers.set(name.toLowerCase(), {
        name,
        value: normalizeHeaderValue(name, headers[name]),
      });
    }
    this._trailers = trailers;
    return this;
  }

  _write(chunk, encoding, callback) {
    this._sendBody(Buffer.from(chunk));
    callback();
  }

  _final(callback) {
    if (!this._headerSent) this._implicitHeader();
    if (!this._sentEnd) {
      this._sentEnd = true;
      this._finishMessage(this.shouldKeepAlive);
    }
    callback();
  }

  // Hooks implemented by ServerResponse/ClientRequest.
  _implicitHeader() {
    throw new Error("onde: OutgoingMessage subclass must implement _implicitHeader");
  }

  _prepareEnd() {}

  _renderHead() {
    throw new Error("onde: OutgoingMessage subclass must implement _renderHead");
  }

  _sendHead() {
    throw new Error("onde: OutgoingMessage subclass must implement _sendHead");
  }

  _sendBody() {
    throw new Error("onde: OutgoingMessage subclass must implement _sendBody");
  }

  _finishMessage() {
    throw new Error("onde: OutgoingMessage subclass must implement _finishMessage");
  }

  _renderHeaderFields() {
    let head = "";
    for (const entry of this._headers.values()) {
      const values = Array.isArray(entry.value) ? entry.value : [entry.value];
      for (let i = 0; i < values.length; i += 1) {
        head += `${entry.name}: ${values[i]}\r\n`;
      }
    }
    return head;
  }

  _finishHead(head) {
    const bytes = Buffer.from(`${head}\r\n`, "latin1");
    this._header = bytes;
    this._headerSent = true;
    this._sendHead(bytes);
  }

  // Replaced by subclasses; the base only exists so `writeContinue` has one entry point.
  _writeContinue() {
    throw new Error("onde: OutgoingMessage subclass must implement _writeContinue");
  }
}

// --- ServerResponse --------------------------------------------------------------------------

class ServerResponse extends OutgoingMessage {
  constructor(req) {
    super();
    this.req = req;
    this.socket = req.socket;
    this.connection = this.socket;
    this._handleId = req._handleId;
    this._v = req.httpVersionMinor === 0 ? 0x10 : 0x11;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.shouldKeepAlive = Boolean(req.keepAlive && req.httpVersion === "1.1");
    this._server = req._server;
    this._session = req._session;
    this._last = false;
    this._hasBody = true;
    this._keepAliveHeaderTimeout = 0;
  }

  writeHead(statusCode, reason, obj) {
    if (this._headerSent) throw headersSentError();

    if (reason !== undefined && typeof reason !== "string") {
      obj = reason;
      reason = undefined;
    }
    // Node coerces with `| 0` before the range check, so `"200"` works and `NaN` does not.
    const original = statusCode;
    const code = statusCode | 0;
    if (code < 100 || code > 999) {
      throw codedError(
        RangeError,
        "ERR_HTTP_INVALID_STATUS_CODE",
        `Invalid status code: ${String(original)}`,
      );
    }
    let message = reason === undefined || reason === "" ? undefined : reason;
    if (message === undefined) message = STATUS_CODES[code] || "unknown";
    if (INVALID_HEADER_CHAR.test(message)) throw invalidCharError("statusMessage");

    this.statusCode = code;
    this.statusMessage = message;

    if (obj !== undefined && obj !== null) {
      if (Array.isArray(obj)) {
        // Node also accepts a flat `[name, value, ...]` array in the headers position.
        if (obj.length % 2 !== 0) throw invalidArgType("headers", "object or array", obj);
        for (let i = 0; i < obj.length; i += 2) this.setHeader(String(obj[i]), obj[i + 1]);
      } else {
        if (typeof obj !== "object") throw invalidArgType("headers", "object", obj);
        for (const name of Object.keys(obj)) this.setHeader(name, obj[name]);
      }
    }
    this._implicitHeader();
    return this;
  }

  _implicitHeader() {
    if (this._headerSent) return;
    this._finishHead(this._renderHead());
  }

  _prepareEnd(chunk, encoding) {
    if (this._headerSent) return;
    if (this._headers.has("content-length") || this._headers.has("transfer-encoding")) return;
    if (!responseHasBody(this.req && this.req.method, this.statusCode)) return;
    if (chunk !== undefined && chunk !== null) this._contentLength = byteLength(chunk, encoding);
    else this._contentLength = 0;
  }

  _renderHead() {
    const status = this.statusCode;
    const reason = this.statusMessage || STATUS_CODES[status] || "unknown";
    const statusLine = `HTTP/1.1 ${status} ${reason}`;
    let head = `${statusLine}\r\n`;
    head += this._renderHeaderFields();

    const has = (name) => this._headers.has(name);
    let keepAlive = Boolean(this.shouldKeepAlive && this._v === 0x11 && !this._last);
    if (has("connection")) {
      const entry = this._headers.get("connection");
      const value = Array.isArray(entry.value) ? entry.value.join(", ") : entry.value;
      keepAlive = !headerTokenIncludes({ connection: String(value) }, "connection", "close");
    }

    if (this.sendDate && !has("date")) {
      head += `Date: ${new Date().toUTCString()}\r\n`;
    }
    if (!has("connection")) {
      head += `Connection: ${keepAlive ? "keep-alive" : "close"}\r\n`;
    }
    if (
      keepAlive &&
      !has("keep-alive") &&
      this._server &&
      this._server.keepAliveTimeout > 0
    ) {
      const seconds = Math.max(1, Math.ceil(this._server.keepAliveTimeout / 1000));
      head += `Keep-Alive: timeout=${seconds}\r\n`;
    }

    this._hasBody = responseHasBody(this.req && this.req.method, status);
    this._chunkedEncoding = false;
    if (this._hasBody) {
      const hasTE = has("transfer-encoding");
      const hasCL = has("content-length");
      if (!hasTE && !hasCL) {
        if (this._contentLength !== null) {
          head += `Content-Length: ${this._contentLength}\r\n`;
        } else if (this._v === 0x11) {
          head += "Transfer-Encoding: chunked\r\n";
          this._chunkedEncoding = true;
        }
        // HTTP/1.0 with no length: the body ends at close (`Connection: close` above).
      }
    }
    this.shouldKeepAlive = keepAlive;
    return head;
  }

  _sendHead(bytes) {
    internalNet().command(this._handleId, "httpHead", [bytes]);
  }

  _sendBody(bytes) {
    if (bytes.length === 0) return;
    internalNet().command(this._handleId, "httpBody", [bytes]);
  }

  _finishMessage(keepAlive) {
    internalNet().command(this._handleId, "httpEnd", [Boolean(keepAlive)]);
    if (this._session && typeof this._session.onResponseFinished === "function") {
      this._session.onResponseFinished(this, Boolean(keepAlive));
    }
  }

  _writeContinue() {
    if (this._headerSent) throw headersSentError();
    internalNet().command(this._handleId, "httpContinue", []);
  }

  writeContinue() {
    this._writeContinue();
    return this;
  }

  _destroy(error, callback) {
    // A finished response may auto-destroy the writable object without touching the connection
    // (keep-alive); only an explicit destroy before `end()` closes the socket.
    if (!this._sentEnd && this.socket && typeof this.socket.destroy === "function") {
      this.socket.destroy(error || undefined);
    }
    callback(error || null);
  }
}

// --- ClientRequest ---------------------------------------------------------------------------

class ClientRequest extends OutgoingMessage {
  constructor(options) {
    super();
    // `ClientRequest` owns `'close'`: it fires once the request is done with its socket (response
    // complete, or the socket closed after an abort). The inherited Writable destroy path would
    // emit a second one, so let `_emitClose` be the single authority.
    this._writableState.emitClose = false;
    this.method = options.method;
    this.path = options.path;
    this.protocol = options.protocol === undefined ? "http:" : options.protocol;
    this.host = options.host;
    this.hostname = options.hostname;
    this._port = options.port;
    this._setHost = options.setHost !== false;
    this._hostHeader = options.hostHeader;
    this._pending = [];
    this._ready = false;
    this._writeStarted = false;
    this._response = null;
    this._upgradeResponse = null;
    this._interim = false;
    this._needsReattach = false;
    this._unsubscribe = null;
    this._timeout = null;
    this._timeoutCallback = null;
    this._expectContinue = false;
    this.reusedSocket = false;
    this.aborted = false;
    this._closed = false;
    this._closeEmitted = false;
    // A socket-level error already reported to the caller: the following `'close'` must not turn
    // into a second, synthetic `ECONNRESET` ("socket hang up"). Node emits exactly one error.
    this._socketErrored = false;
    this.shouldKeepAlive = options.keepAlive !== false;
    this._agent = options.agent;
    this._agentKey = null;
  }

  setHeader(name, value) {
    const result = super.setHeader(name, value);
    if (typeof name === "string" && name.toLowerCase() === "connection") {
      const values = Array.isArray(value) ? value.join(", ") : String(value);
      this.shouldKeepAlive = !headerTokenIncludes({ connection: values }, "connection", "close");
    } else if (typeof name === "string" && name.toLowerCase() === "expect") {
      const values = Array.isArray(value) ? value.join(", ") : String(value);
      if (values.toLowerCase().includes("100-continue")) this._expectContinue = true;
    }
    return result;
  }

  _prepareEnd(chunk, encoding) {
    if (this._headerSent) return;
    if (this._headers.has("content-length") || this._headers.has("transfer-encoding")) return;
    if (chunk !== undefined && chunk !== null && chunk !== "") {
      this._contentLength = byteLength(chunk, encoding);
    } else if (EXPECTS_BODY.has(this.method)) {
      this._contentLength = 0;
    }
  }

  _implicitHeader() {
    if (this._headerSent) return;
    this._finishHead(this._renderHead());
  }

  _renderHead() {
    let head = `${this.method} ${this.path} HTTP/1.1\r\n`;
    head += this._renderHeaderFields();

    const has = (name) => this._headers.has(name);
    if (this._setHost && !has("host")) {
      head += `Host: ${this._hostHeader}\r\n`;
    }
    if (!has("connection")) {
      head += `Connection: ${this.shouldKeepAlive ? "keep-alive" : "close"}\r\n`;
    }
    if (!has("transfer-encoding") && !has("content-length")) {
      if (this._contentLength !== null) {
        head += `Content-Length: ${this._contentLength}\r\n`;
      } else if (this._writeStarted) {
        head += "Transfer-Encoding: chunked\r\n";
        this._chunkedEncoding = true;
      }
    }
    return head;
  }

  _sendHead(bytes) {
    this._queueOrSend("head", bytes);
  }

  _sendBody(bytes) {
    if (bytes.length === 0) return;
    this._queueOrSend("body", bytes);
  }

  _finishMessage(keepAlive) {
    this.shouldKeepAlive = Boolean(keepAlive);
    this._queueOrSend("end", Boolean(keepAlive));
    if (this._needsReattach) this._reattach();
  }

  /// A fresh client-side codec cycle on the same handle. Used after an interim 1xx response,
  /// which completes a message in the codec's view and parks the final response behind the
  /// one-message-at-a-time rule. `httpEnd(false)` is replayed so a non-keep-alive request still
  /// closes once that final response completes (the reset clears the flag).
  _reattach() {
    this._needsReattach = false;
    internalNet().command(this._handleId, "httpAttach", ["client", maxHeaderSize, DEFAULT_MAX_HEADERS]);
    if (!this.shouldKeepAlive) internalNet().command(this._handleId, "httpEnd", [false]);
  }

  _writeContinue() {
    this._queueOrSend("continue", null);
  }

  _queueOrSend(kind, payload) {
    if (!this._ready) {
      this._pending.push({ kind, payload });
      return;
    }
    this._sendNow(kind, payload);
  }

  _sendNow(kind, payload) {
    const id = this._handleId;
    if (kind === "head") internalNet().command(id, "httpHead", [payload]);
    else if (kind === "body") internalNet().command(id, "httpBody", [payload]);
    else if (kind === "end") internalNet().command(id, "httpEnd", [payload]);
    else if (kind === "continue") internalNet().command(id, "httpContinue", []);
  }

  // -- socket acquisition ---------------------------------------------------------------------

  onSocket(socket, reused) {
    if (this.socket) {
      this.socket.removeListener("connect", this._boundConnect);
      this.socket.removeListener("error", this._boundError);
      this.socket.removeListener("close", this._boundClose);
    }
    this.socket = socket;
    this.connection = socket;
    this.reusedSocket = Boolean(reused);
    this.emit("socket", socket);

    this._boundConnect = () => this._attach();
    this._boundError = (error) => this._onSocketError(error);
    this._boundClose = () => this._onSocketClose();
    socket.on("error", this._boundError);
    socket.on("close", this._boundClose);

    if (socket.connecting === false || socket.readyState === "open" || reused) {
      this._attach();
    } else {
      socket.once("connect", this._boundConnect);
    }
    return this;
  }

  _attach() {
    if (this._ready || this.socket === null) return;
    this.socket.removeListener("connect", this._boundConnect);
    let id;
    try {
      id = internalNet().handleIdOf(this.socket);
    } catch (error) {
      // A socket that never produced a handle cannot carry HTTP; fail the request instead of
      // leaving it waiting forever.
      this.emit("error", error);
      return;
    }
    this._handleId = id;
    this._unsubscribe = internalNet().onHandleEvent(this.socket, (name, payload) =>
      this._onHandleEvent(name, payload),
    );
    internalNet().command(id, "httpAttach", ["client", maxHeaderSize, DEFAULT_MAX_HEADERS]);
    this._ready = true;
    if (this._timeout !== null && typeof this.socket.setTimeout === "function") {
      this.socket.setTimeout(this._timeout, this._timeoutCallback);
    }
    const pending = this._pending;
    this._pending = [];
    for (let i = 0; i < pending.length; i += 1) {
      this._sendNow(pending[i].kind, pending[i].payload);
    }
    // Node flushes the head as soon as the socket is assigned for an `Expect: 100-continue`
    // request: the peer cannot answer the expectation before it has seen the headers, and the
    // caller is waiting for `'continue'` before writing the body. A body-expecting method gets
    // chunked framing at this point because no length is known yet (Node does the same).
    if (this._expectContinue && !this._headerSent) {
      if (EXPECTS_BODY.has(this.method)) this._writeStarted = true;
      this._implicitHeader();
    }
  }

  // -- response -------------------------------------------------------------------------------

  _onHandleEvent(name, payload) {
    if (name === "response") {
      const res = new IncomingMessage(this.socket, "client");
      res._handleId = this._handleId;
      res._setResponse(payload);
      res.req = this;
      if (payload.status >= 100 && payload.status < 200) {
        // Interim responses do not become `res`: Node reports 100 Continue on the request and
        // every other 1xx on `'information'` (ADR-0007 §2.8).
        this._interim = true;
        if (payload.status === 100) this.emit("continue");
        this.emit("information", {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          httpVersion: res.httpVersion,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
        });
        return;
      }
      this._response = res;
      this._interim = false;
      if (payload.status === 101 || (this.method === "CONNECT" && payload.status >= 200 && payload.status < 300)) {
        this._upgradeResponse = res;
      } else {
        this.emit("response", res);
      }
      return;
    }
    if (name === "body") {
      if (this._upgradeResponse !== null) return;
      if (this._response !== null) this._response.pushBody(payload);
      return;
    }
    if (name === "messageEnd") {
      if (this._upgradeResponse !== null) return;
      if (this._interim) {
        // The 1xx message completed; the transport parks the next message until JS starts it.
        // A client's next message is the final response, so restart the cycle on the same handle
        // (`httpAttach` resets the codec, m4-plan §2.4). Defer while the request body is still
        // being framed, so the fresh codec does not lose the outbound body mode.
        this._interim = false;
        if (this._sentEnd) this._reattach();
        else this._needsReattach = true;
        return;
      }
      if (this._response !== null) {
        this._response.pushEnd(payload && payload.trailers);
        const res = this._response;
        if (!res.shouldKeepAlive || !this.shouldKeepAlive || !this._agent || this._agent.keepAlive === false) {
          if (this.socket && !this.socket.destroyed) this.socket.destroy();
        } else if (typeof this._agent.keepSocketAlive === "function") {
          this._agent.keepSocketAlive(this.socket);
        }
        this._release();
        this._emitClose();
      }
      return;
    }
    if (name === "upgrade") {
      if (this._upgradeResponse !== null) {
        internalNet().command(this._handleId, "detach", []);
        const head = Buffer.from(payload || []);
        const res = this._upgradeResponse;
        this._upgradeResponse = null;
        this.emit("upgrade", res, this.socket, head);
        this._release();
      }
      return;
    }
    if (name === "clientError") {
      this.emit("error", payload);
      return;
    }
    // `error`/`closed` (and raw `data`/`end`/`drain`) are the socket's: `net.Socket` emits them
    // and `ClientRequest` listens on the socket directly, so they are ignored here.
  }

  _release() {
    if (this._unsubscribe !== null) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  _onSocketError(error) {
    if (this._closed) return;
    if (this._response === null && !this.aborted) {
      this._socketErrored = true;
      this.emit("error", error);
    }
  }

  _onSocketClose() {
    if (this._closed) return;
    this._closed = true;
    this._release();
    if (
      !this.aborted &&
      !this._socketErrored &&
      (this._response === null || !this._response.complete)
    ) {
      const error = codedError(Error, "ECONNRESET", "socket hang up");
      this.emit("error", error);
    }
    this._emitClose();
  }

  // -- lifecycle ------------------------------------------------------------------------------

  setTimeout(msecs, callback) {
    this._timeout = msecs;
    this._timeoutCallback = callback;
    if (this.socket) this.socket.setTimeout(msecs, callback);
    return this;
  }

  setNoDelay(noDelay) {
    if (this.socket && typeof this.socket.setNoDelay === "function") this.socket.setNoDelay(noDelay);
    return this;
  }

  setSocketKeepAlive(enable, initialDelay) {
    if (this.socket && typeof this.socket.setKeepAlive === "function") {
      this.socket.setKeepAlive(enable, initialDelay);
    }
    return this;
  }

  abort() {
    this._abort();
  }

  destroy(error) {
    this._abort(error);
    super.destroy(error);
    return this;
  }

  _abort(error) {
    if (this.aborted) return;
    this.aborted = true;
    const hadResponse = this._response !== null;
    if (this.socket) this.socket.destroy(error || undefined);
    if (!hadResponse && error === undefined) {
      this.emit("error", codedError(Error, "ECONNRESET", "socket hang up"));
    }
    this._release();
    // Without a socket there will be no socket `'close'` to drive `_emitClose`; the request's
    // close still has to happen exactly once (Node emits it on the next turn of the loop).
    if (this.socket === null) process.nextTick(() => this._emitClose());
  }

  _destroy(error, callback) {
    this._abort(error);
    callback(error || null);
  }
}

// --- Agent -----------------------------------------------------------------------------------

/// A JS pool of idle sockets (m4-plan §5). `keepAlive` defaults to true on Node 19+, free sockets
/// are `unref`'d and evicted on `keepAliveTimeout`, and reuse is a fresh `httpAttach` cycle on the
/// same handle rather than a new connection.
class Agent extends EventEmitter {
  constructor(options) {
    super();
    const opts = options === undefined || options === null ? {} : options;
    this.keepAlive = opts.keepAlive !== false;
    this.maxSockets = opts.maxSockets === undefined ? Infinity : opts.maxSockets;
    this.maxFreeSockets = opts.maxFreeSockets === undefined ? 256 : opts.maxFreeSockets;
    this.keepAliveMsecs = opts.keepAliveMsecs === undefined ? 1000 : opts.keepAliveMsecs;
    this.keepAliveTimeout = opts.keepAliveTimeout === undefined ? 1000 : opts.keepAliveTimeout;
    this.scheduling = opts.scheduling === "fifo" ? "fifo" : "lifo";
    this.timeout = opts.timeout;
    this.options = opts;
    this.sockets = Object.create(null); // key -> Set<socket> (busy)
    this.freeSockets = Object.create(null); // key -> socket[]
    this.requests = Object.create(null); // key -> number of queued requests
    this._pending = Object.create(null); // key -> {options, req}[]
  }

  createConnection(options) {
    return net().connect(options);
  }

  getName(options) {
    const host = options.hostname || options.host || "localhost";
    return `${host}:${options.port}:${options.localAddress || ""}`;
  }

  addRequest(req, options) {
    const key = this.getName(options);
    req._agentKey = key;
    req._agent = this;
    const free = this.freeSockets[key];

    if (this.keepAlive && free !== undefined && free.length > 0) {
      const socket = this.scheduling === "fifo" ? free.shift() : free.pop();
      this._clearSocketTimer(socket);
      if (socket !== undefined && !socket.destroyed) {
        if (typeof socket.ref === "function") socket.ref();
        this._addBusy(key, socket);
        req.onSocket(socket, true);
        return;
      }
    }

    const busy = this.sockets[key];
    const active = busy === undefined ? 0 : busy.size;
    if (active < this.maxSockets) {
      this._createSocket(req, options, key);
      return;
    }
    const queue = this._pending[key];
    if (queue === undefined) this._pending[key] = [{ options, req }];
    else queue.push({ options, req });
  }

  _createSocket(req, options, key) {
    let socket;
    try {
      const create = typeof options.createConnection === "function"
        ? options.createConnection
        : (opts) => this.createConnection(opts);
      socket = create(options);
    } catch (error) {
      req.emit("error", error);
      return;
    }
    this._addBusy(key, socket);
    socket.on("close", () => this._onSocketClose(key, socket));
    req.onSocket(socket, false);
  }

  _addBusy(key, socket) {
    let set = this.sockets[key];
    if (set === undefined) {
      set = new Set();
      this.sockets[key] = set;
    }
    set.add(socket);
  }

  _onSocketClose(key, socket) {
    const busy = this.sockets[key];
    if (busy !== undefined) busy.delete(socket);
    const free = this.freeSockets[key];
    if (free !== undefined) {
      const index = free.indexOf(socket);
      if (index !== -1) free.splice(index, 1);
    }
    this._clearSocketTimer(socket);
    this._dequeue(key);
  }

  _dequeue(key) {
    const queue = this._pending[key];
    if (queue === undefined || queue.length === 0) return;
    const busy = this.sockets[key];
    const active = busy === undefined ? 0 : busy.size;
    if (active >= this.maxSockets) return;
    const next = queue.shift();
    this._createSocket(next.req, next.options, key);
  }

  keepSocketAlive(socket) {
    if (!this.keepAlive || socket.destroyed) return false;
    const key = socket._httpAgentKey;
    if (key === undefined) return false;
    const busy = this.sockets[key];
    if (busy === undefined || !busy.delete(socket)) return false;

    let free = this.freeSockets[key];
    if (free === undefined) {
      free = [];
      this.freeSockets[key] = free;
    }
    if (free.length >= this.maxFreeSockets) {
      socket.destroy();
      return false;
    }
    free.push(socket);
    this._dequeue(key);

    if (typeof socket.unref === "function") socket.unref();
    const agent = this;
    socket._httpAgentKey = key;
    socket._httpFreeTimer = setTimeout(() => {
      if (free.indexOf(socket) !== -1) socket.destroy();
    }, this.keepAliveTimeout);
    if (socket._httpFreeTimer && typeof socket._httpFreeTimer.unref === "function") {
      socket._httpFreeTimer.unref();
    }
    return true;
  }

  _clearSocketTimer(socket) {
    if (socket._httpFreeTimer !== undefined) {
      clearTimeout(socket._httpFreeTimer);
      socket._httpFreeTimer = undefined;
    }
  }

  reuseSocket(socket) {
    this._clearSocketTimer(socket);
    if (typeof socket.ref === "function") socket.ref();
  }

  destroy() {
    for (const key of Object.keys(this.sockets)) {
      for (const socket of this.sockets[key]) socket.destroy();
      delete this.sockets[key];
    }
    for (const key of Object.keys(this.freeSockets)) {
      for (const socket of this.freeSockets[key]) socket.destroy();
      delete this.freeSockets[key];
    }
    this._pending = Object.create(null);
    this.requests = Object.create(null);
  }
}

// The Agent needs the key on the socket for `_onSocketClose`/`keepSocketAlive`. `addRequest` sets
// it on the request; copy it onto the socket at assignment time.
const originalOnSocket = ClientRequest.prototype.onSocket;
ClientRequest.prototype.onSocket = function onSocket(socket, reused) {
  if (this._agentKey !== null) socket._httpAgentKey = this._agentKey;
  return originalOnSocket.call(this, socket, reused);
};

// --- server-side connection state ------------------------------------------------------------

/// The per-connection state shared by a server and its request/response objects.
class ServerSession {
  constructor(server, socket, id) {
    this.server = server;
    this.socket = socket;
    this.id = id;
    this.requests = 0;
    this.closed = false;
    this.upgraded = false;
    this.req = null;
    this.res = null;
    this.headersTimer = null;
    this.requestTimer = null;
    this.keepAliveTimer = null;
    this.off = null;
    this.connectionListener = null;
  }

  clearHeadersTimer() {
    if (this.headersTimer !== null) {
      clearTimeout(this.headersTimer);
      this.headersTimer = null;
    }
  }

  clearRequestTimer() {
    if (this.requestTimer !== null) {
      clearTimeout(this.requestTimer);
      this.requestTimer = null;
    }
  }

  clearKeepAliveTimer() {
    if (this.keepAliveTimer !== null) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  destroy() {
    this.clearHeadersTimer();
    this.clearRequestTimer();
    this.clearKeepAliveTimer();
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }

  onResponseFinished(res, keepAlive) {
    this.clearRequestTimer();
    this.req = null;
    this.res = null;
    if (!keepAlive || this.closed || this.upgraded) return;
    this.clearKeepAliveTimer();
    this.clearHeadersTimer();
    const server = this.server;
    if (this.socket && server.keepAliveTimeout > 0) {
      const timer = setTimeout(() => {
        if (!this.socket.destroyed) this.socket.destroy();
      }, server.keepAliveTimeout);
      if (timer && typeof timer.unref === "function") timer.unref();
      this.keepAliveTimer = timer;
    }
    // The next request's head is also subject to `headersTimeout`; the keep-alive timer normally
    // wins (5 s vs 60 s), but a larger `keepAliveTimeout` must not disable the header limit.
    if (server.headersTimeout > 0) {
      this.headersTimer = unrefTimer(
        setTimeout(() => {
          if (!this.closed) this.destroy();
        }, server.headersTimeout),
      );
    }
  }
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

function isUpgradeRequest(req) {
  if (req.method === "CONNECT") return true;
  if (req.headers.upgrade !== undefined) return true;
  return headerTokenIncludes(req.headers, "connection", "upgrade");
}

/// Attach the codec and the HTTP session to one accepted socket.
///
/// Called from the server's `'connection'` listener, before any `read` is issued, so the codec
/// owns the first byte. The session's observer is installed before `httpAttach` so no event can
/// arrive without a listener.
function attachServerSocket(server, socket) {
  const id = internalNet().handleIdOf(socket);
  const session = new ServerSession(server, socket, id);
  server._sessions = server._sessions || new Set();
  server._sessions.add(session);

  session.off = internalNet().onHandleEvent(socket, (name, payload) => {
    try {
      handleServerEvent(server, session, name, payload);
    } catch (error) {
      // A throw from a user callback must reach `uncaughtException` (the bootstrap sink routes it
      // the same way); do not let it corrupt the connection state.
      if (typeof globalThis.__ln_emit_uncaught === "function") globalThis.__ln_emit_uncaught(error);
      else throw error;
    }
  });

  socket.on("error", () => {});
  socket.on("close", () => {
    session.closed = true;
    session.clearHeadersTimer();
    session.clearRequestTimer();
    session.clearKeepAliveTimer();
    if (session.off !== null) {
      session.off();
      session.off = null;
    }
    server._sessions.delete(session);
  });

  internalNet().command(id, "httpAttach", [
    "server",
    server.maxHeaderSize || maxHeaderSize,
    server.maxHeadersCount === undefined ? DEFAULT_MAX_HEADERS : server.maxHeadersCount,
  ]);

  if (server.headersTimeout > 0) {
    session.headersTimer = unrefTimer(
      setTimeout(() => {
        if (!session.closed) session.destroy();
      }, server.headersTimeout),
    );
  }
  if (server.timeout > 0 && typeof socket.setTimeout === "function") {
    socket.setTimeout(server.timeout, () => session.destroy());
  }
  return session;
}

function handleServerEvent(server, session, name, payload) {
  if (name === "request") {
    onServerRequest(server, session, payload);
    return;
  }
  if (name === "body") {
    if (session.req !== null) session.req.pushBody(payload);
    return;
  }
  if (name === "messageEnd") {
    session.clearRequestTimer();
    if (session.req !== null) {
      session.req.pushEnd(payload && payload.trailers);
      session.req = null;
    }
    return;
  }
  if (name === "clientError") {
    // The Rust task already answered `400`/`431` and closed the connection (D42): the event is
    // informational and the socket must not be written to.
    session.clearHeadersTimer();
    session.clearRequestTimer();
    // The Rust task already answered 400/431 and closed the connection (D42): the event is
    // informational and the socket must not be written to. Node also emits it with no listener,
    // so emit unconditionally rather than gating on listenerCount.
    server.emit("clientError", payload, session.socket);
    return;
  }
  if (name === "upgrade") {
    // A server handover after a 101 encoded through `res`: the bytes belong to the upgraded
    // protocol and there is no `request` handler waiting for them. Detach and hand them to the
    // socket's own readable as `data`.
    if (!session.upgraded) {
      session.upgraded = true;
      internalNet().command(session.id, "detach", []);
    }
    return;
  }
  // data/end/error/drain/closed belong to `net.Socket` and are handled by its own sink.
}

function onServerRequest(server, session, payload) {
  session.clearHeadersTimer();
  session.clearKeepAliveTimer();
  session.requests += 1;

  const req = new IncomingMessage(session.socket, "server");
  req._handleId = session.id;
  req._server = server;
  req._session = session;
  req.keepAlive = Boolean(payload.keepAlive);
  req._setRequest(payload);
  session.req = req;

  const res = new ServerResponse(req);
  res._session = session;
  res._keepAliveHeaderTimeout = server.keepAliveTimeout;
  if (server.maxRequestsPerSocket > 0 && session.requests >= server.maxRequestsPerSocket) {
    res.shouldKeepAlive = false;
    res._last = true;
  }
  if (server._closing) res.shouldKeepAlive = false;
  session.res = res;

  if (server.requestTimeout > 0) {
    session.requestTimer = unrefTimer(
      setTimeout(() => {
        if (!session.closed) session.destroy();
      }, server.requestTimeout),
    );
  }

  // HTTP/1.1 requires `Host` (RFC 9112 §3.2). Node's HTTP server layer rejects a request without
  // one before any `'request'` event with a canned 400 and closes the connection; unlike a parse
  // failure this is not a `'clientError'` (the parser accepted the head). HTTP/1.0 is exempt.
  if (req.httpVersion === "1.1" && req.headers.host === undefined) {
    res.statusCode = 400;
    res.shouldKeepAlive = false;
    res.end();
    return;
  }

  if (isUpgradeRequest(req)) {
    if (server.listenerCount("upgrade") > 0) {
      // Node hands the socket to the user: leave parsed mode first so the upgraded protocol's
      // bytes arrive as `data` on the same socket (m4-plan §5).
      session.upgraded = true;
      req.upgrade = true;
      req.complete = true;
      internalNet().command(session.id, "detach", []);
      server.emit("upgrade", req, session.socket, Buffer.alloc(0));
      return;
    }
  }

  if (payload.expectContinue) {
    if (server.listenerCount("checkContinue") > 0) {
      // Node does not send the interim response when a listener is installed; the handler calls
      // `res.writeContinue()` or writes a final response.
      server.emit("checkContinue", req, res);
      return;
    }
    res.writeContinue();
  }

  server.emit("request", req, res);
}

// --- client request construction -------------------------------------------------------------

let globalAgent = null;

function setGlobalAgent(agent) {
  globalAgent = agent;
}

function parseUrlOptions(input, options, protocol) {
  let url;
  if (typeof input === "string") {
    url = new URL(input);
  } else if (input !== null && typeof input === "object" && typeof input.protocol === "string" &&
             typeof input.hostname === "string" && input.href !== undefined) {
    url = input;
  } else {
    return null;
  }
  if (url.protocol !== protocol) {
    throw codedError(
      TypeError,
      "ERR_INVALID_PROTOCOL",
      `Protocol "${url.protocol}" not supported. Expected "${protocol}"`,
    );
  }
  return Object.assign(
    {
      hostname: url.hostname,
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      auth:
        url.username !== ""
          ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
          : undefined,
    },
    options,
  );
}

function isUrlLike(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.protocol === "string" &&
    typeof value.hostname === "string" &&
    value.href !== undefined
  );
}

/// Merge `(input, options)` into one options object, Node's overloads.
///
/// `protocol` and `defaultPort` are the only things `https` changes: a `https:` URL is a
/// protocol error in `http.request` and the default port is 443. `opts._tls` (set by `https`) is
/// the TLS option hook this module forwards to the agent without knowing its contents.
function normalizeRequestOptions(input, options, protocol, defaultPort) {
  const scheme = protocol === undefined ? "http:" : protocol;
  let opts;
  if (typeof input === "string" || isUrlLike(input)) {
    opts = parseUrlOptions(input, options, scheme);
  } else if (input !== null && typeof input === "object") {
    opts = Object.assign({}, input);
    if (options !== null && typeof options === "object") Object.assign(opts, options);
  } else {
    throw invalidArgType("options", "object or string", input);
  }
  if (opts.port === undefined || opts.port === null) opts.port = defaultPort === undefined ? 80 : defaultPort;
  return opts;
}

/// `http.request(options[, callback])`; `http.get` is this plus `end()`.
function request(input, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  return sendRequest(normalizeRequestOptions(input, options, "http:", 80), callback);
}

/// The second half of `request`: everything that needs the finalized options object.
function sendRequest(opts, callback) {
  const method = opts.method === undefined ? "GET" : String(opts.method).toUpperCase();
  const path = opts.path === undefined || opts.path === "" ? "/" : String(opts.path);
  const hostname = opts.hostname === undefined ? opts.host : opts.hostname;
  const host = hostname === undefined || hostname === null ? "localhost" : String(hostname);
  let port = opts.port;
  if (typeof port === "string") port = Number(port);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw codedError(
      RangeError,
      "ERR_SOCKET_BAD_PORT",
      `options.port should be >= 0 and < 65536. Received ${describe(opts.port)}.`,
    );
  }

  const agentOption = opts.agent;
  let agent;
  if (agentOption === false) {
    agent = new Agent({ keepAlive: false, maxSockets: 1 });
  } else if (agentOption instanceof Agent) {
    agent = agentOption;
  } else if (agentOption === undefined || agentOption === null) {
    if (globalAgent === null) globalAgent = new Agent();
    agent = globalAgent;
  } else {
    throw invalidArgType("options.agent", "Agent or false", agentOption);
  }

  const headers = opts.headers === null || opts.headers === undefined ? {} : opts.headers;
  const hostHeader = defaultHostHeader(host, port);

  const requestOptions = {
    method,
    path,
    host,
    hostname: host,
    port,
    hostHeader,
    agent,
    keepAlive: agent.keepAlive,
    setHost: opts.setHost !== false,
    headers,
    localAddress: opts.localAddress,
    family: opts.family,
    protocol: opts._tls === undefined || opts._tls === null ? "http:" : "https:",
    tlsOptions: opts._tls,
  };

  const req = new ClientRequest(requestOptions);
  if (opts.auth !== undefined && !hasHeaderObject(headers, "authorization")) {
    req.setHeader("authorization", `Basic ${Buffer.from(String(opts.auth), "utf8").toString("base64")}`);
  }
  for (const name of Object.keys(headers)) req.setHeader(name, headers[name]);
  if (opts.timeout !== undefined) req.setTimeout(opts.timeout);

  if (typeof callback === "function") req.once("response", callback);

  agent.addRequest(req, {
    host,
    hostname: host,
    port,
    localAddress: opts.localAddress,
    family: opts.family,
    createConnection: opts.createConnection,
    timeout: opts.timeout,
    // `https` sets this to the normalized TLS payload; `Agent.createConnection` hands it to
    // `tls.connect`, so the options are never dropped on the way to the socket.
    tlsOptions: opts._tls,
  });
  return req;
}

function hasHeaderObject(headers, name) {
  const key = name.toLowerCase();
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === key) return true;
  }
  return false;
}

function defaultHostHeader(host, port) {
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  const rendered = needsBrackets ? `[${host}]` : host;
  if (port === 80) return rendered;
  return `${rendered}:${port}`;
}

// --- exports ---------------------------------------------------------------------------------

module.exports = {
  STATUS_CODES,
  METHODS,
  maxHeaderSize,
  DEFAULT_MAX_HEADERS,
  validateHeaderName,
  validateHeaderValue,
  headersFromRaw,
  responseHasBody,
  IncomingMessage,
  OutgoingMessage,
  ServerResponse,
  ClientRequest,
  Agent,
  request,
  normalizeRequestOptions,
  sendRequest,
  setGlobalAgent,
  attachServerSocket,
  isUpgradeRequest,
  // shared helpers for the public surface
  codedError,
  invalidArgType,
  invalidArgValue,
};
