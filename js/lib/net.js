"use strict";

// `net` — TCP and Unix sockets over the M4 handle bridge (ADR-0006).
//
// The Rust transport owns the socket; this file owns Node's surface over it:
//
//   * `Socket` is a `stream.Duplex`, so `pause`/`resume`/`pipe`/`pipeline`/backpressure are the
//     M3 stream layer, not a reimplementation. `_read` issues exactly one `read` command at a
//     time; `pause()` sends `readStop`; every `data` event is a `push()`.
//   * `write()` backpressure is Node's: the return value is `false` once the bytes handed to the
//     host but not yet drained reach the writable high-water mark. The task's `drain` event is a
//     *queue-empty* signal; this surface emits the public `'drain'` only after a write returned
//     `false` (m4-plan §4).
//   * `'close'` is driven by the handle's `closed` event, which is always last and carries
//     `hadError`. A user `destroy(err)` is emitted locally: the error never crosses the bridge.
//   * `setTimeout` is a JS timer (ADR-0006 §5); the task has no idle timer.
//
// Gaps recorded for M4 (D40): there is no JS-visible fd, so `new net.Socket({ fd })`,
// `socket._handle` and `socket.fd` do not exist. `cluster`/`SO_REUSEPORT` are out of scope.

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

const internal = requireInternal("internal/net", "./internal/net.js");
const {
  nextId,
  command,
  setHandleId,
  handleIdOf,
  isHttpParsed,
  addressToNode,
  errorFromPayload,
  invalidArgType,
  normalizeConnectArgs,
  normalizeConnectOptions,
  connectHostArgs,
  normalizeListenArgs,
  normalizeListenOptions,
  listenHostArgs,
  normalizeBoolean,
  normalizeU32,
} = internal;

let BufferCtor = null;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("./buffer.js");
}
const Buffer = BufferCtor;

let streamModule = null;
try {
  streamModule = require("stream");
} catch (_) {
  streamModule = require("./stream.js");
}
const { Duplex } = streamModule;

let EventEmitterCtor = null;
try {
  EventEmitterCtor = require("events");
} catch (_) {
  EventEmitterCtor = require("./events.js");
}
const EventEmitter = EventEmitterCtor;

const MAX_CHUNK = 64 * 1024;
const DEFAULT_HIGH_WATER_MARK = 16 * 1024;
const TIMEOUT_MAX = 2147483647;

// `process.nextTick` exists once bootstrap has run; a checkout of this file before it is loaded
// should still work, so fall back to the microtask queue.
const scheduleTick =
  typeof process !== "undefined" && process !== null && typeof process.nextTick === "function"
    ? (fn, arg) => process.nextTick(fn, arg)
    : (fn, arg) => queueMicrotask(() => fn(arg));

// --- errors ----------------------------------------------------------------------------------

function codedError(Ctor, code, message) {
  const error = new Ctor(message);
  error.code = code;
  return error;
}

function socketClosedError(syscall) {
  return codedError(
    Error,
    "ERR_SOCKET_CLOSED",
    `Socket is closed${syscall === undefined ? "" : ` (${syscall})`}`,
  );
}

function serverNotRunningError() {
  return codedError(Error, "ERR_SERVER_NOT_RUNNING", "Server is not running.");
}

function socketAlreadyConnectedError() {
  return codedError(Error, "ERR_SOCKET_IS_CONNECTED", "Socket is already connected");
}

// --- byte helpers ----------------------------------------------------------------------------

function byteLengthOf(chunk, encoding) {
  if (typeof chunk === "string") {
    try {
      return Buffer.byteLength(chunk, encoding || "utf8");
    } catch (_) {
      return chunk.length;
    }
  }
  return chunk !== null && chunk !== undefined && typeof chunk.length === "number"
    ? chunk.length
    : 0;
}

// --- Socket ----------------------------------------------------------------------------------

class Socket extends Duplex {
  constructor(options) {
    const settings = options === undefined || options === null ? {} : options;
    if (typeof settings !== "object") throw invalidArgType("options", "object", settings);

    // `emitClose: false` because the handle's `closed` event is the only authority on when the
    // socket is gone (H2: always last, exactly once) and it carries `hadError`.
    super({
      allowHalfOpen: settings.allowHalfOpen === true,
      highWaterMark: settings.highWaterMark,
      readableHighWaterMark: settings.readableHighWaterMark,
      writableHighWaterMark: settings.writableHighWaterMark,
      emitClose: false,
      autoDestroy: settings.autoDestroy !== false,
      decodeStrings: true,
    });

    this._handleId = 0;
    this._handleActive = false;
    this._handleClosed = false;
    this._closeEmitted = false;
    this._connecting = false;
    this._connected = false;
    this._reading = false;
    this._readPaused = false;
    this._readEnded = false;
    this._writeEnded = false;
    this._pendingWriteBytes = 0;
    this._needDrain = false;
    this._hadError = false;
    this._local = null;
    this._remote = null;
    this._alpn = null;
    this._bytesRead = 0;
    this._bytesWritten = 0;
    this._timeoutMs = 0;
    this._idleTimer = null;
    this._refed = true;
    this._noDelay = null;
    this._keepAlive = null;
    this._server = null;
    // TLS (m4-plan §2.5): the normalized payload the bridge carries, plus what `connected`
    // reported. A plain socket has `_tlsOptions === null` and `encrypted === false`.
    this._tlsOptions =
      settings.tlsOptions === undefined || settings.tlsOptions === null
        ? null
        : settings.tlsOptions;
    this._encrypted = settings.encrypted === true || this._tlsOptions !== null;
    this._authorized = false;
    this._authorizationError = null;
    this._protocol = settings.protocol === undefined ? null : settings.protocol;

    // Internal constructor path: an accepted connection or a TLS-established socket. Not public
    // API; `new net.Socket()` never has a handle until `connect()`.
    if (typeof settings.handle === "number" && settings.handle > 0) {
      this._adopt(settings.handle, {
        remote: settings.remote,
        local: settings.local,
        // An accepted socket is already connected: there is no `connect` event for it, but a
        // consumer may attach at once.
        connected: true,
      });
      // An accepted TLS socket arrives with ALPN/TLS details already known (`Connection` is
      // emitted after the handshake), so a `secureConnection` listener sees a complete socket.
      if (settings.alpn !== undefined && settings.alpn !== null) this._alpn = settings.alpn;
      // A server socket is never "authorized" without a verified client certificate, which M4
      // does not support; Node reports `false` with a null error there too.
      this._authorized = false;
      this._authorizationError = null;
      if (settings.server !== undefined) this._server = settings.server;
      // Accepted connections hold their own loop ref in Node. The bridge does not take one for
      // a task-minted handle, so take it here (idempotent, H3).
      this._send("ref", []);
    }

    if (this._timeoutMs > 0) this._touchIdle();
  }

  _adopt(id, info) {
    this._handleId = id;
    this._handleActive = true;
    setHandleId(this, id);
    internal.register(id, (name, payload) => this._onHandleEvent(name, payload));
    if (info !== undefined && info !== null) {
      if (info.connected === true) this._connected = true;
      if (info.local !== undefined && info.local !== null) this._local = addressToNode(info.local);
      if (info.remote !== undefined && info.remote !== null) {
        this._remote = addressToNode(info.remote);
      }
    }
  }

  // One sink for the whole handle. It keeps `data`/`end`/`drain`/`error`/`closed` in this class
  // and forwards every event to observers (the HTTP surface composes here instead of replacing
  // the bootstrap's single sink per id).
  _onHandleEvent(name, payload) {
    switch (name) {
      case "connected": {
        if (this.destroyed || this._handleClosed) break;
        this._connecting = false;
        this._connected = true;
        if (payload.local !== undefined) this._local = addressToNode(payload.local);
        if (payload.remote !== undefined) this._remote = addressToNode(payload.remote);
        this._alpn = payload.alpn === undefined ? null : payload.alpn;
        this._protocol = payload.protocol === undefined ? null : payload.protocol;
        if (this._encrypted) {
          const tls = this._tlsOptions === null ? {} : this._tlsOptions;
          // A server socket only becomes "authorized" with a verified *client* certificate, which
          // M4 does not support; Node reports `authorized: false` there as well.
          const serverSide = tls.certPem !== undefined;
          this._authorized = serverSide ? false : tls.rejectUnauthorized !== false;
          this._authorizationError = this._authorized
            ? null
            : serverSide
              ? null
              : "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
        }
        this._applyPendingOptions();
        this._touchIdle();
        this.emit("connect");
        this.emit("ready");
        // A client socket reads in the background in Node (a paused stream still buffers, and a
        // peer FIN is noticed). Arm one read after `'connect'`/`'ready'` have run, so a consumer
        // attached in those listeners has already asked; without a consumer the chunk is buffered
        // in the readable (`_read` bounds further pulls with the high-water mark).
        const readable = this._readableState;
        if (
          !this._readPaused &&
          !this._reading &&
          !this._readEnded &&
          readable !== undefined &&
          readable.length === 0 &&
          readable.flowing !== true &&
          readable.readableListening !== true
        ) {
          this._startRead();
        }
        break;
      }
      case "data": {
        this._bytesRead += payload.length;
        this._reading = false;
        this._touchIdle();
        // Node hands the surface a Buffer; the bridge payload is a Uint8Array. A view (not a
        // copy) keeps the per-read allocation at one.
        this.push(
          Buffer.isBuffer(payload)
            ? payload
            : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
        );
        break;
      }
      case "end": {
        this._reading = false;
        this._readEnded = true;
        this.push(null);
        // `push(null)` only schedules `'end'` when a consumer is flowing or listening; Node also
        // emits it for a paused socket whose buffer is empty (the auto half-close then runs and
        // the handle can close). `read(0)` is the stream's own "re-check EOF" path and does not
        // pull more bytes once `ended` is set.
        this.read(0);
        break;
      }
      case "drain": {
        this._pendingWriteBytes = 0;
        this._touchIdle();
        if (this._needDrain && !this._writeEnded && !this.writableEnded) {
          this._needDrain = false;
          this.emit("drain");
        }
        break;
      }
      case "error": {
        // The payload already is the JS `Error` the op path would produce. Emit it with the
        // socket's own name; the following `closed` emits `'close'`.
        //
        // A local `destroy()` wins: Node never emits the connect/read error for a socket the
        // user already destroyed, and a `destroy(err)` already emitted its error locally.
        const destroyedLocally = this.destroyed;
        this._hadError = true;
        if (!destroyedLocally) {
          this.destroy();
          this.emit("error", errorFromPayload(payload));
        }
        break;
      }
      case "closed": {
        this._handleClosed = true;
        this._reading = false;
        this._readEnded = true;
        if (payload !== null && payload !== undefined && payload.hadError === true) {
          this._hadError = true;
        }
        this._clearIdleTimer();
        if (this._handleId > 0) internal.release(this._handleId);
        // If the peer's FIN pushed `null` into a readable nobody has drained yet, Node still
        // emits `'end'` before `'close'`; destroying the stream here would make the scheduled
        // `end` tick bail out on `state.destroyed`. Wait for it when it is already pending.
        const readable = this._readableState;
        if (
          readable !== undefined &&
          readable.ended &&
          !readable.endEmitted &&
          !readable.destroyed &&
          // Only a consuming side will emit `'end'`; with no consumer (and no `'readable'`
          // listener) Node closes without an `'end'`, and waiting for one here would swallow
          // `'close'` and leak the destroyed state.
          (readable.flowing === true || readable.readableListening === true)
        ) {
          this.once("end", () => this._finishHostClose());
        } else {
          this._finishHostClose();
        }
        break;
      }
      default: {
        // Parsed-mode events (`request`, `response`, `body`, `messageEnd`, `upgrade`,
        // `clientError`) and anything future: expose them as socket events for the HTTP layer.
        this.emit(name, payload);
        break;
      }
    }
    internal.emitHandleEvent(this, name, payload);
  }

  _finishHostClose() {
    if (!this.destroyed) this.destroy();
    this._scheduleClose();
  }

  _scheduleClose() {
    scheduleTick(() => this._emitClose());
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._handleActive = false;
    this._connecting = false;
    this.emit("close", this._hadError);
  }

  _send(name, args) {
    if (this._handleId <= 0 || this._handleClosed) return;
    try {
      command(this._handleId, name, args);
    } catch (_) {
      // A command to a handle the task already dropped is ignored by the bridge (H5). A
      // synchronous validation error from `host.net` is a programming error in this file, not
      // something a user write should turn into a throw; the next `error`/`closed` event tells
      // the real story.
    }
  }

  _startRead() {
    if (this._handleClosed || this.destroyed || this._readEnded) return false;
    if (!this._handleActive || this._handleId <= 0) return false;
    // Parsed mode owns the byte stream (the HTTP codec's `read` is a body resume, not a raw
    // pull); a raw read here would move bytes the parser must see.
    if (isHttpParsed(this)) return false;
    if (this._reading) return false;
    // No `_connected` guard: a `read` issued while the connect task is still resolving is queued
    // in the task's command channel and becomes the first read once it is connected. Guarding
    // here would leave the stream's `state.reading` stuck at `true` when a `'data'` listener was
    // attached before `'connect'`.
    this._reading = true;
    this._send("read", [MAX_CHUNK]);
    return true;
  }

  // -- readable -------------------------------------------------------------------------------

  _read() {
    if (this._readPaused || !this._startRead()) {
      // The stream sets `state.reading` before calling `_read`. Returning without a pending push
      // must clear it, or no later `read()`/`resume()` would ever ask again.
      if (this._readableState !== undefined) this._readableState.reading = false;
    }
  }

  read(n) {
    // An explicit `read()` is a consumer ask even while flowing is paused; `read(0)` is not.
    if (n === undefined || n === null || Number(n) > 0) this._readPaused = false;
    return super.read(n);
  }

  pause() {
    this._readPaused = true;
    const result = super.pause();
    if (!this._readEnded && !this._handleClosed) {
      this._reading = false;
      this._send("readStop", []);
    }
    return result;
  }

  resume() {
    this._readPaused = false;
    const result = super.resume();
    const state = this._readableState;
    if (
      state !== undefined &&
      state.flowing === true &&
      state.length === 0 &&
      !this._readEnded &&
      !this._reading &&
      !this._handleClosed &&
      !this.destroyed
    ) {
      // `pause()` may have cancelled a read that the stream had already asked for; without
      // re-arming, a resume after that point would stall with no outstanding read.
      this._startRead();
    }
    return result;
  }

  // -- writable -------------------------------------------------------------------------------

  write(chunk, encoding, cb) {
    const size = byteLengthOf(chunk, typeof encoding === "string" ? encoding : undefined);
    const result = super.write(chunk, encoding, cb);
    const writable = this._writableState;
    // `writeOrBuffer` marks its own `needDrain` as soon as a single chunk is larger than the
    // high-water mark, even though `_write` has already handed it to the task. The public
    // `'drain'` is the task's queue-empty signal gated on a `false` return (m4-plan §4), so this
    // class owns it: clear the stream's flag and track the bytes still with the task instead.
    if (writable !== undefined) writable.needDrain = false;
    this._pendingWriteBytes += size;
    const highWaterMark = writable === undefined ? DEFAULT_HIGH_WATER_MARK : writable.highWaterMark;
    if (this._pendingWriteBytes >= highWaterMark) {
      this._needDrain = true;
      return false;
    }
    return result;
  }

  get writableLength() {
    return this._pendingWriteBytes;
  }

  get writableNeedDrain() {
    return this._needDrain;
  }

  _write(chunk, encoding, cb) {
    if (this._handleClosed || this.destroyed || !this._handleActive || this._handleId <= 0) {
      // Node's `new net.Socket()` has no handle until `connect()`; a write before then is
      // ERR_SOCKET_CLOSED, not an infinite buffer.
      cb(socketClosedError("write"));
      return;
    }
    this._bytesWritten += chunk.length;
    this._touchIdle();
    try {
      command(this._handleId, "write", [chunk]);
    } catch (error) {
      cb(error);
      return;
    }
    cb();
  }

  _final(cb) {
    if (!this._handleClosed && this._handleActive && this._handleId > 0 && !this._writeEnded) {
      this._writeEnded = true;
      this._send("end", []);
      // Node keeps reading after `end()` so the peer's FIN can still be noticed (half-close).
      // The bridge only reads on demand, so arm one read here: without it a socket whose write
      // side finished but whose readable nobody consumes would never see EOF and its handle would
      // outlive the process. Any bytes read are kept in the readable; `_read` still bounds the
      // rest by the high-water mark.
      if (!this._readEnded && !this._reading && !this._handleClosed) {
        this._reading = true;
        this._send("read", [MAX_CHUNK]);
      }
    }
    cb();
  }

  _destroy(err, cb) {
    this._clearIdleTimer();
    this._readEnded = true;
    if (err !== null && err !== undefined) this._hadError = true;
    const waitForHost =
      this._handleActive && !this._handleClosed && this._handleId > 0;
    if (waitForHost) this._send("destroy", []);
    cb(err === undefined ? null : err);
    if (!waitForHost) this._scheduleClose();
  }

  _applyPendingOptions() {
    if (this._noDelay !== null) this._send("setNoDelay", [this._noDelay]);
    if (this._keepAlive !== null) {
      this._send("setKeepAlive", [this._keepAlive.enable, this._keepAlive.delay]);
    }
  }

  // -- Node API -------------------------------------------------------------------------------

  connect(...args) {
    if (this._handleActive && !this._handleClosed) throw socketAlreadyConnectedError();
    const parsed = normalizeConnectArgs(args);
    const settings = normalizeConnectOptions(parsed.options);
    if (typeof parsed.callback === "function") this.once("connect", parsed.callback);

    this._connecting = true;
    this._connected = false;
    this._hadError = false;
    const id = nextId();
    this._adopt(id, null);
    try {
      command(id, "connect", connectHostArgs(settings, this._tlsOptions));
    } catch (error) {
      // Argument errors are synchronous (m4-plan §2.2); leave the socket usable for a retry.
      internal.release(id);
      this._handleActive = false;
      this._handleId = 0;
      setHandleId(this, 0);
      this._connecting = false;
      throw error;
    }
    if (!this._refed) command(id, "unref", []);
    this._touchIdle();
    return this;
  }

  ref() {
    if (!this._refed) {
      this._refed = true;
      if (this._handleActive && !this._handleClosed) this._send("ref", []);
    }
    return this;
  }

  unref() {
    if (this._refed) {
      this._refed = false;
      if (this._handleActive && !this._handleClosed) this._send("unref", []);
    }
    return this;
  }

  setTimeout(msecs, callback) {    if (callback !== undefined) {
      if (typeof callback !== "function") throw invalidArgType("callback", "function", callback);
      this.once("timeout", callback);
    }
    const delay = Number(msecs);
    if (!Number.isFinite(delay) || delay <= 0) {
      this._timeoutMs = 0;
      this._clearIdleTimer();
      return this;
    }
    this._timeoutMs = Math.min(Math.trunc(delay), TIMEOUT_MAX);
    this._touchIdle();
    return this;
  }

  get timeout() {
    return this._timeoutMs;
  }

  set timeout(msecs) {
    this.setTimeout(msecs);
  }

  _touchIdle() {
    if (this._timeoutMs <= 0 || this._handleClosed || this.destroyed) {
      this._clearIdleTimer();
      return;
    }
    this._clearIdleTimer();
    const timer = setTimeout(() => {
      this._idleTimer = null;
      if (this._handleClosed || this.destroyed) return;
      this.emit("timeout");
    }, this._timeoutMs);
    // Node's stream timeouts are unref'd: the socket itself keeps the loop alive, not the timer.
    if (timer !== null && timer !== undefined && typeof timer.unref === "function") timer.unref();
    this._idleTimer = timer;
  }

  _clearIdleTimer() {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  setNoDelay(noDelay) {
    const value = normalizeBoolean(noDelay, "noDelay", true);
    this._noDelay = value;
    if (this._connected && !this._handleClosed) this._send("setNoDelay", [value]);
    return this;
  }

  setKeepAlive(enable, initialDelay) {
    const on = enable === undefined || enable === null ? false : Boolean(enable);
    const delay = normalizeU32(initialDelay, "initialDelay", 0);
    this._keepAlive = { enable: on, delay };
    if (this._connected && !this._handleClosed) this._send("setKeepAlive", [on, delay]);
    return this;
  }

  destroySoon() {
    this.end();
    return this;
  }

  resetAndDestroy() {
    // Node arms `SO_LINGER(0)` (so the close sends RST, not FIN) and then destroys the socket.
    // The bridge has a dedicated command for exactly that: the peer observes `ECONNRESET`.
    if (this._handleActive && !this._handleClosed && this._handleId > 0) {
      this._send("reset", []);
    }
    this.destroy();
    return this;
  }

  address() {
    // Node returns `{}` when the socket has no IP address (an unconnected socket or a Unix
    // socket); `server.address()` is the one that reports a pipe path, as a string.
    if (this._local === null || this._local.family === "unix") return {};
    return this._local;
  }

  get connecting() {
    return this._connecting;
  }

  get pending() {
    return this._connecting;
  }

  get readyState() {
    if (this._handleClosed || this.destroyed) return "closed";
    if (this._connecting || !this._connected) return "opening";
    if (this._readEnded && !this._writeEnded) return "readOnly";
    if (this._writeEnded && !this._readEnded) return "writeOnly";
    return "open";
  }

  get remoteAddress() {
    return this._remote === null || this._remote.family === "unix"
      ? undefined
      : this._remote.address;
  }

  get remotePort() {
    return this._remote === null || this._remote.family === "unix" ? undefined : this._remote.port;
  }

  get remoteFamily() {
    return this._remote === null || this._remote.family === "unix"
      ? undefined
      : this._remote.family;
  }

  get localAddress() {
    return this._local === null || this._local.family === "unix"
      ? undefined
      : this._local.address;
  }

  get localPort() {
    return this._local === null || this._local.family === "unix" ? undefined : this._local.port;
  }

  get bytesRead() {
    return this._bytesRead;
  }

  get bytesWritten() {
    return this._bytesWritten;
  }

  /// True for a TLS socket. Node's `net.Socket` has no such property; it is additive here so a
  /// `net.Socket` reference can answer the same question as a `tls.TLSSocket`.
  get encrypted() {
    return this._encrypted;
  }

  /// Whether the peer certificate was verified. Always true for a handshake that used
  /// `rejectUnauthorized` (rustls aborts the connection otherwise), false when it was disabled.
  get authorized() {
    return this._encrypted ? this._authorized : false;
  }

  /// `null` when authorized, else the code Node would report for an unverified peer.
  get authorizationError() {
    return this._encrypted ? this._authorizationError : null;
  }

  /// `"http/1.1"` when negotiated, `false` for a TLS socket without ALPN (Node's shape), `null`
  /// for a plain socket.
  get alpnProtocol() {
    if (!this._encrypted) return null;
    return this._alpn === null || this._alpn === undefined ? false : this._alpn;
  }

  /// `"TLSv1.3"`/`"TLSv1.2"` for a TLS socket, `null` for a plain one.
  getProtocol() {
    return this._encrypted ? this._protocol : null;
  }

  /// No X.509 parser is linked in M4 (D41): the shape is an object, the fields are absent.
  getPeerCertificate() {
    return {};
  }

  get server() {
    return this._server;
  }

  set server(value) {
    this._server = value;
  }
}

// --- Server ----------------------------------------------------------------------------------

class Server extends EventEmitter {
  constructor(options, connectionListener) {
    super();
    const settings = options === undefined || options === null ? {} : options;
    if (typeof settings !== "object") throw invalidArgType("options", "object", settings);
    this.allowHalfOpen = settings.allowHalfOpen === true;
    this.pauseOnConnect = settings.pauseOnConnect === true;
    this.maxConnections =
      typeof settings.maxConnections === "number" ? settings.maxConnections : undefined;
    this._handleId = 0;
    this._handleActive = false;
    this._handleClosed = false;
    this._closeEmitted = false;
    this._listening = false;
    this._address = null;
    this._closeRequested = false;
    this._connections = new Set();
    this._refed = true;
    this._hadError = false;
    // Set by a TLS subclass (`tls.Server`, `https.Server`) before `listen()`; plain `net.Server`
    // leaves it null. Additive: the bridge treats null as "no TLS".
    this._tlsOptions = settings.tlsOptions === undefined ? null : settings.tlsOptions;
    if (typeof connectionListener === "function") this.on("connection", connectionListener);
  }

  listen(...args) {
    if (this._handleActive && !this._handleClosed) {
      throw codedError(
        Error,
        "ERR_SERVER_ALREADY_LISTEN",
        "Listen method has been called more than once without closing.",
      );
    }
    const parsed = normalizeListenArgs(args);
    const settings = normalizeListenOptions(parsed.options);
    if (typeof parsed.callback === "function") this.once("listening", parsed.callback);

    const id = nextId();
    this._handleId = id;
    this._handleActive = true;
    this._handleClosed = false;
    this._hadError = false;
    this._closeRequested = false;
    this._closeEmitted = false;
    setHandleId(this, id);
    internal.register(id, (name, payload) => this._onHandleEvent(name, payload));
    try {
      command(id, "listen", listenHostArgs(settings, this._tlsOptions));
    } catch (error) {
      internal.release(id);
      this._handleActive = false;
      this._handleId = 0;
      setHandleId(this, 0);
      throw error;
    }
    if (!this._refed) command(id, "unref", []);
    return this;
  }

  _onHandleEvent(name, payload) {
    switch (name) {
      case "listening": {
        this._address = addressToNode(payload);
        this._listening = true;
        this.emit("listening");
        break;
      }
      case "connection": {
        const socket = new Socket({
          handle: payload.handle,
          remote: payload,
          local: this._address,
          allowHalfOpen: this.allowHalfOpen,
          server: this,
          encrypted: this._tlsOptions !== null && this._tlsOptions !== undefined,
          tlsOptions: this._tlsOptions,
          alpn: payload.alpn === undefined ? null : payload.alpn,
          protocol: payload.protocol === undefined ? null : payload.protocol,
        });
        this._connections.add(socket);
        socket.once("close", () => this._connections.delete(socket));
        if (
          typeof this.maxConnections === "number" &&
          this.maxConnections > 0 &&
          this._connections.size > this.maxConnections
        ) {
          // Node drops the excess connection instead of emitting it (`'drop'` is advisory).
          socket.destroy();
          this.emit("drop", {
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            localAddress: socket.localAddress,
            localPort: socket.localPort,
          });
          break;
        }
        this.emit("connection", socket);
        break;
      }
      case "error": {
        this._hadError = true;
        this.emit("error", errorFromPayload(payload));
        break;
      }
      case "closed": {
        this._handleClosed = true;
        this._handleActive = false;
        // Node emits `'close'` for a server that was listening (or whose `close()` was called),
        // not for a listen that failed before binding (an `EADDRINUSE` is only an `'error'`).
        const wasListening = this._listening;
        this._listening = false;
        this._address = null;
        if (this._handleId > 0) internal.release(this._handleId);
        if (wasListening || this._closeRequested) scheduleTick(() => this._emitClose());
        break;
      }
      default:
        break;
    }
    internal.emitHandleEvent(this, name, payload);
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close", this._hadError);
  }

  close(callback) {
    if (callback !== undefined) {
      if (typeof callback !== "function") throw invalidArgType("callback", "function", callback);
      if (!this._handleActive || this._handleClosed) {
        scheduleTick(callback, serverNotRunningError());
        return this;
      }
      // Registering through `once('close')` keeps Node's listener order: a callback passed to
      // `close()` runs where that call would have registered a listener, before listeners added
      // after it.
      this.once("close", () => callback(null));
    }
    if (!this._handleActive || this._handleClosed) return this;
    this._closeRequested = true;
    this._send("destroy", []);
    return this;
  }

  _send(name, args) {
    if (this._handleId <= 0 || this._handleClosed) return;
    try {
      command(this._handleId, name, args);
    } catch (_) {
      // Unknown handle: the bridge ignores it (H5).
    }
  }

  address() {
    if (!this._listening || this._address === null) return null;
    // Node reports a Unix listener as its path string, not an address object.
    return this._address.family === "unix" ? this._address.address : this._address;
  }

  ref() {
    if (!this._refed) {
      this._refed = true;
      if (this._handleActive && !this._handleClosed) this._send("ref", []);
    }
    return this;
  }

  unref() {
    if (this._refed) {
      this._refed = false;
      if (this._handleActive && !this._handleClosed) this._send("unref", []);
    }
    return this;
  }

  get listening() {
    return this._listening;
  }

  // Deprecated in Node but still read by older code.
  get connections() {
    return this._connections.size;
  }

  getConnections(callback) {
    if (typeof callback !== "function") throw invalidArgType("callback", "function", callback);
    const count = this._connections.size;
    scheduleTick(callback, null, count);
    return this;
  }

  closeAllConnections() {
    for (const socket of Array.from(this._connections)) socket.destroy();
  }

  closeIdleConnections() {
    for (const socket of Array.from(this._connections)) {
      if (socket.readableLength === 0 && socket.writableLength === 0) socket.destroy();
    }
  }
}

// --- module functions ------------------------------------------------------------------------

function createServer(options, connectionListener) {
  if (typeof options === "function") {
    connectionListener = options;
    options = undefined;
  }
  return new Server(options, connectionListener);
}

function createConnection(...args) {
  // `net.connect({ allowHalfOpen: true })` configures the socket, not the connect command
  // (Node builds `new Socket(options)` in `createConnection`).
  const first = args[0];
  const settings =
    first !== null && typeof first === "object"
      ? { allowHalfOpen: first.allowHalfOpen === true }
      : undefined;
  const socket = new Socket(settings);
  if (args.length > 0 && typeof args[args.length - 1] === "function") {
    socket.once("connect", args.pop());
  }
  socket.connect(...args);
  return socket;
}

// --- IP predicates ---------------------------------------------------------------------------

// Node's v4 segment: no leading zeros, range 0-255.
const IPV4_SEGMENT = "(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])";
const IPV4_PATTERN = new RegExp(
  `^${IPV4_SEGMENT}\\.${IPV4_SEGMENT}\\.${IPV4_SEGMENT}\\.${IPV4_SEGMENT}$`,
);

function isIPv4(value) {
  return typeof value === "string" && IPV4_PATTERN.test(value);
}

function isHextet(part) {
  return part.length >= 1 && part.length <= 4 && /^[0-9a-fA-F]+$/.test(part);
}

function isIPv6(value) {
  if (typeof value !== "string" || value.length < 2) return false;
  // A zone identifier is allowed after a non-empty `%` (Node accepts `fe80::1%lo0`).
  let text = value;
  const zone = text.indexOf("%");
  if (zone !== -1) {
    if (zone === text.length - 1 || text.indexOf("%", zone + 1) !== -1) return false;
    text = text.slice(0, zone);
  }
  if (text.length < 2 || text.indexOf(":") === -1) return false;

  const marker = text.indexOf("::");
  if (marker !== -1 && text.indexOf("::", marker + 2) !== -1) return false;

  const head = marker === -1 ? text : text.slice(0, marker);
  const tail = marker === -1 ? "" : text.slice(marker + 2);
  const hasCompression = marker !== -1;

  // Only the final position of the whole address may be an embedded dotted-quad: with `::` that
  // is the end of the tail, without it the end of the single part list.
  function parseSide(side, allowIPv4) {
    if (side === "") return [];
    const parts = side.split(":");
    const groups = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const last = index === parts.length - 1;
      if (allowIPv4 && last && part.indexOf(".") !== -1) {
        if (!isIPv4(part)) return null;
        groups.push(2);
        continue;
      }
      if (!isHextet(part)) return null;
      groups.push(1);
    }
    return groups;
  }

  const headGroups = parseSide(head, !hasCompression);
  const tailGroups = parseSide(tail, hasCompression);
  if (headGroups === null || tailGroups === null) return false;
  const count = headGroups.reduce((sum, n) => sum + n, 0) +
    tailGroups.reduce((sum, n) => sum + n, 0);
  return hasCompression ? count < 8 : count === 8;
}

function isIP(value) {
  if (typeof value !== "string") return 0;
  if (isIPv4(value)) return 4;
  if (isIPv6(value)) return 6;
  return 0;
}

module.exports = {
  Socket,
  Server,
  connect: createConnection,
  createConnection,
  createServer,
  isIP,
  isIPv4,
  isIPv6,
  // Published for the HTTP surface: the numeric handle behind a `net.Socket` (additive; Node has
  // no such export).
  handleIdOf,
};
