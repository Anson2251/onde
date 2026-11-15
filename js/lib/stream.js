"use strict";

// `stream` — Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished.
//
// A compact implementation of the Node stream *public* API (docs/compat.md, Tier 1 `stream`
// row). `readable-stream` internal parity is out of scope: there is no `_readableState`
// compatibility shim beyond the few fields the public getters expose, no `stream.Duplex.from`,
// and no legacy `Stream.prototype.pipe`.
//
// Design notes:
//
//   * `EventEmitter` comes from `events`, which resolves to onde's module under onde and to
//     Node's builtin under Node. That is intentional: this file is exercised by both runtimes.
//   * Everything is deferred with `process.nextTick` (falling back to `queueMicrotask`), which
//     is what makes `data`/`end`/`finish` order match Node for the common cases.
//   * Byte-mode buffering works on `Uint8Array`/`Buffer` chunks and concatenates lazily; object
//     mode counts chunks instead of bytes.
//   * `push()`/`read()` emit `data` synchronously when the stream is already flowing and its
//     buffer is empty, and buffer otherwise. `end` is always emitted on a later tick.
//
// Deliberate differences from Node (tracked in the WP3 report):
//
//   * `Readable.prototype.pipe` destroys *both* sides when either emits `error` (Node's plain
//     `pipe` leaves cleanup to the caller; only `pipeline` destroys the chain).
//   * `pipeline(...streams, { signal }, cb)` accepts an options object in the callback form.
//     Node's callback form rejects it (``Duplex.from(options)``); Node only supports `{ signal }`
//     through `stream/promises.pipeline`.
//   * The default byte-mode high-water mark is 16 KiB (the M3 contract); Node 22+ uses 64 KiB.
//     Pass `highWaterMark` explicitly when the value is observable.
//   * `stream.Duplex.from`, `Stream.prototype.pipe`, `writable.destroyed`-era deprecations and
//     `readable.readableAborted` are intentionally absent.

let EventEmitter;
try {
  EventEmitter = require("events");
} catch (_) {
  EventEmitter = require("./events.js");
}

let BufferCtor;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("./buffer.js");
}

let StringDecoderCtor;
try {
  StringDecoderCtor = require("string_decoder").StringDecoder;
} catch (_) {
  StringDecoderCtor = require("./string_decoder.js").StringDecoder;
}

const Buffer = BufferCtor;
const StringDecoder = StringDecoderCtor;

// The M3 contract pins 16 KiB / 16 objects. Node 22+ uses 64 KiB; keep this one constant so the
// choice is a one-line change (see the module comment).
const DEFAULT_HIGH_WATER_MARK = 16 * 1024;
const DEFAULT_OBJECT_HIGH_WATER_MARK = 16;

const EMPTY = Buffer.alloc(0);

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function codedError(Ctor, code, message) {
  const err = new Ctor(message);
  err.code = code;
  return err;
}

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "string") return `type string ('${value.length > 28 ? value.slice(0, 25) + "..." : value}')`;
  if (type === "number" || type === "boolean" || type === "bigint") return `type ${type} (${String(value)})`;
  if (type === "function") return `function ${value.name || "anonymous"}`;
  if (ArrayBuffer.isView(value)) {
    return `an instance of ${(value.constructor && value.constructor.name) || "TypedArray"}`;
  }
  const name = value && value.constructor && value.constructor.name;
  return `an instance of ${name || "Object"}`;
}

function invalidArgType(name, expected, value) {
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be of type ${expected}. Received ${describeValue(value)}`,
  );
}

function invalidArgValue(name, value, reason) {
  let rendered;
  try {
    rendered = typeof value === "string" ? `'${value}'` : String(value);
  } catch (_) {
    rendered = "<value>";
  }
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' ${reason || "is invalid"}. Received ${rendered}`,
  );
}

function outOfRange(name, range, value) {
  return codedError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
  );
}

function writeAfterEndError() {
  return codedError(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end");
}

function destroyedError(name) {
  return codedError(
    Error,
    "ERR_STREAM_DESTROYED",
    `Cannot call ${name || "write"} after a stream was destroyed`,
  );
}

function pushAfterEofError() {
  return codedError(Error, "ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
}

function nullValuesError() {
  return codedError(Error, "ERR_STREAM_NULL_VALUES", "May not write null values to stream");
}

function prematureCloseError() {
  return codedError(Error, "ERR_STREAM_PREMATURE_CLOSE", "Premature close");
}

function abortError(signal) {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  if (signal && "reason" in signal) err.cause = signal.reason;
  return err;
}

function methodNotImplemented(name) {
  return codedError(Error, "ERR_METHOD_NOT_IMPLEMENTED", `The ${name} method is not implemented`);
}

// ---------------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------------

function scheduleTick(fn, a, b, c) {
  const proc = typeof globalThis === "object" ? globalThis.process : undefined;
  if (proc && typeof proc.nextTick === "function") {
    proc.nextTick(fn, a, b, c);
    return;
  }
  if (typeof queueMicrotask === "function") {
    queueMicrotask(function call() {
      fn(a, b, c);
    });
    return;
  }
  Promise.resolve().then(function call() {
    fn(a, b, c);
  });
}

function noop() {}

function toHighWaterMark(options, objectMode) {
  const value =
    options.highWaterMark !== undefined ? options.highWaterMark : options.readableHighWaterMark;
  if (value === undefined || value === null) {
    return objectMode ? DEFAULT_OBJECT_HIGH_WATER_MARK : DEFAULT_HIGH_WATER_MARK;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw invalidArgValue("highWaterMark", value, "must be a non-negative number");
  }
  return Math.floor(value);
}

function toWritableHighWaterMark(options, objectMode) {
  const value =
    options.highWaterMark !== undefined ? options.highWaterMark : options.writableHighWaterMark;
  if (value === undefined || value === null) {
    return objectMode ? DEFAULT_OBJECT_HIGH_WATER_MARK : DEFAULT_HIGH_WATER_MARK;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw invalidArgValue("highWaterMark", value, "must be a non-negative number");
  }
  return Math.floor(value);
}

function checkOptions(options, name) {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object") throw invalidArgType(name || "options", "object", options);
  return options;
}

// ---------------------------------------------------------------------------------------------
// Stream base
// ---------------------------------------------------------------------------------------------

class Stream extends EventEmitter {}

Object.defineProperties(Stream.prototype, {
  destroyed: {
    configurable: true,
    enumerable: false,
    get() {
      const readable = this._readableState;
      const writable = this._writableState;
      return Boolean((readable && readable.destroyed) || (writable && writable.destroyed));
    },
  },
  closed: {
    configurable: true,
    enumerable: false,
    get() {
      const readable = this._readableState;
      const writable = this._writableState;
      return Boolean((readable && readable.closed) || (writable && writable.closed));
    },
  },
  objectMode: {
    configurable: true,
    enumerable: false,
    get() {
      const readable = this._readableState;
      const writable = this._writableState;
      return Boolean(
        (readable && readable.objectMode) || (writable && writable.objectMode),
      );
    },
  },
});

Stream.prototype.destroy = function destroy(err) {
  return destroyStream(this, err);
};

// ---------------------------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------------------------

function finishDestroy(stream, err) {
  const readable = stream._readableState;
  const writable = stream._writableState;
  if (readable) readable.closed = true;
  if (writable) writable.closed = true;
  if (err) {
    if (readable) readable.errored = err;
    if (writable) writable.errored = err;
    scheduleTick(emitErrorThenClose, stream, err);
  } else {
    scheduleTick(emitCloseEvent, stream);
  }
}

function emitErrorThenClose(stream, err) {
  if (!stream.destroyed) return;
  stream.emit("error", err);
  emitCloseEvent(stream);
}

function emitCloseEvent(stream) {
  const readable = stream._readableState;
  const writable = stream._writableState;
  if (readable && readable.closeEmitted) return;
  if (writable && writable.closeEmitted) return;
  const wantClose = readable
    ? readable.emitClose !== false
    : writable
      ? writable.emitClose !== false
      : true;
  if (readable) readable.closeEmitted = true;
  if (writable) writable.closeEmitted = true;
  if (wantClose) stream.emit("close");
}

function destroyStream(stream, err) {
  const readable = stream._readableState;
  const writable = stream._writableState;
  if (!readable && !writable) return stream;
  if (stream.destroyed) return stream;

  if (readable) {
    readable.destroyed = true;
    readable.reading = false;
    if (err) readable.errored = err;
  }
  if (writable) {
    writable.destroyed = true;
    if (err) writable.errored = err;
  }

  let called = false;
  function done(finalErr) {
    if (called) return;
    called = true;
    let error = null;
    if (finalErr === undefined) error = err || null;
    else error = finalErr || null;
    finishDestroy(stream, error);
  }

  try {
    if (typeof stream._destroy === "function") {
      stream._destroy(err || null, function onDestroyed(error) {
        done(error);
      });
    } else {
      done(err);
    }
  } catch (error) {
    done(error);
  }
  return stream;
}

function maybeAutoDestroy(stream) {
  if (stream.destroyed) return;
  const readable = stream._readableState;
  const writable = stream._writableState;
  const autoDestroy = readable
    ? readable.autoDestroy !== false
    : writable
      ? writable.autoDestroy !== false
      : true;
  if (!autoDestroy) return;
  const readableDone = !readable || readable.endEmitted;
  const writableDone = !writable || writable.finished;
  if (readableDone && writableDone) destroyStream(stream);
}

// ---------------------------------------------------------------------------------------------
// Readable
// ---------------------------------------------------------------------------------------------

class Readable extends Stream {
  constructor(opts) {
    super();
    const options = checkOptions(opts, "options");
    const objectMode = Boolean(options.objectMode);
    const state = {
      objectMode,
      highWaterMark: toHighWaterMark(options, objectMode),
      defaultEncoding: typeof options.defaultEncoding === "string" ? options.defaultEncoding : "utf8",
      buffer: [],
      length: 0,
      pipes: [],
      flowing: null,
      ended: false,
      endEmitted: false,
      endScheduled: false,
      reading: false,
      sync: true,
      needReadable: false,
      readMoreScheduled: false,
      emittedReadable: false,
      readableListening: false,
      emitClose: options.emitClose !== false,
      autoDestroy: options.autoDestroy !== false,
      destroyed: false,
      errored: null,
      closed: false,
      closeEmitted: false,
      decoder: null,
      encoding: null,
    };
    this._readableState = state;
    if (typeof options.read === "function") this._read = options.read;
    if (typeof options.destroy === "function") this._destroy = options.destroy;
    if (options.encoding !== undefined && options.encoding !== null) this.setEncoding(options.encoding);
  }

  // -- getters ---------------------------------------------------------------------------------

  get readable() {
    const state = this._readableState;
    if (!state) return false;
    return !state.destroyed && !state.endEmitted && !state.errored;
  }

  get readableEnded() {
    return Boolean(this._readableState && this._readableState.endEmitted);
  }

  get readableFlowing() {
    return this._readableState ? this._readableState.flowing : null;
  }

  get readableHighWaterMark() {
    return this._readableState ? this._readableState.highWaterMark : 0;
  }

  get readableObjectMode() {
    return Boolean(this._readableState && this._readableState.objectMode);
  }

  get readableLength() {
    return this._readableState ? this._readableState.length : 0;
  }

  get readableEncoding() {
    return this._readableState ? this._readableState.encoding : null;
  }

  // -- pulling ---------------------------------------------------------------------------------

  _read() {
    throw methodNotImplemented("_read()");
  }

  read(n) {
    return readFrom(this, n);
  }

  push(chunk, encoding) {
    return pushChunk(this, chunk, encoding, false);
  }

  unshift(chunk) {
    const state = this._readableState;
    if (state.destroyed) return false;
    if (state.ended) {
      destroyStream(this, pushAfterEofError());
      return false;
    }
    if (chunk === null || chunk === undefined) {
      throw nullValuesError();
    }
    let value = chunk;
    if (!state.objectMode) {
      if (typeof value === "string") value = Buffer.from(value, state.defaultEncoding);
      else if (!(value instanceof Uint8Array)) {
        throw invalidArgType("chunk", "string, Buffer or Uint8Array", value);
      }
      if (state.decoder) value = state.decoder.write(value);
    }
    if (value.length === 0) return false;
    state.buffer.unshift(value);
    state.length += state.objectMode ? 1 : value.length;
    if (state.readableListening && !state.flowing) scheduleReadable(this);
    return state.length < state.highWaterMark;
  }

  setEncoding(encoding) {
    const state = this._readableState;
    if (!state) throw invalidArgType("stream", "Readable", this);
    if (state.objectMode) {
      throw invalidArgValue(
        "encoding",
        encoding,
        "must not be set on an objectMode stream",
      );
    }
    const decoder = new StringDecoder(encoding);
    state.decoder = decoder;
    state.encoding = decoder.encoding;
    if (state.buffer.length > 0) {
      const combined = state.buffer.length === 1 ? state.buffer[0] : Buffer.concat(state.buffer);
      const text = decoder.write(combined);
      state.buffer = [];
      state.length = 0;
      if (text.length > 0) {
        state.buffer.push(text);
        state.length = text.length;
      }
    }
    return this;
  }

  isPaused() {
    return this._readableState ? this._readableState.flowing === false : false;
  }

  pause() {
    const state = this._readableState;
    if (state && state.flowing !== false) {
      state.flowing = false;
      this.emit("pause");
    }
    return this;
  }

  resume() {
    const state = this._readableState;
    if (!state) return this;
    if (!state.flowing) {
      state.flowing = !state.readableListening;
      if (state.flowing) scheduleTick(resumeFlow, this);
    }
    return this;
  }

  // -- pipe ------------------------------------------------------------------------------------

  pipe(dest, options) {
    return pipeFrom(this, dest, options);
  }

  unpipe(dest) {
    const state = this._readableState;
    if (!state) return this;
    const entries = state.pipes;
    if (entries.length === 0) return this;
    if (dest === undefined) {
      const copy = entries.slice();
      for (let i = 0; i < copy.length; i += 1) unpipeEntry(this, copy[i]);
      this.pause();
      return this;
    }
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].dest === dest) {
        unpipeEntry(this, entries[i]);
        break;
      }
    }
    if (state.pipes.length === 0 && this.listenerCount("data") === 0) this.pause();
    return this;
  }

  // -- iteration -------------------------------------------------------------------------------

  [Symbol.asyncIterator]() {
    return createAsyncIterator(this);
  }

  async toArray() {
    const out = [];
    for await (const chunk of this) out.push(chunk);
    return out;
  }
}

Readable.from = fromIterable;

// --- readable internals ----------------------------------------------------------------------

function maybeRead(stream) {
  const state = stream._readableState;
  if (!state || state.destroyed || state.reading || state.ended) return;
  state.reading = true;
  state.sync = true;
  try {
    stream._read(state.highWaterMark);
  } catch (err) {
    state.sync = false;
    state.reading = false;
    destroyStream(stream, err);
    return;
  }
  state.sync = false;
}

// Node's `maybeReadMore`: after a chunk is handed to a flowing consumer, pull once more on the
// next tick. Without this a `push()` from an asynchronous `_read` delivers `data` but never
// re-enters `_read`, so the stream stalls after one chunk and never reaches `end` (this was
// observable with `process.stdin.on("data")` for inputs larger than the high-water mark).
function scheduleReadMore(stream) {
  const state = stream._readableState;
  if (!state || state.destroyed || state.ended || state.reading || state.readMoreScheduled) return;
  state.readMoreScheduled = true;
  scheduleTick(readMoreNow, stream);
}

function readMoreNow(stream) {
  const state = stream._readableState;
  if (!state) return;
  state.readMoreScheduled = false;
  if (state.destroyed || state.ended || state.reading) return;
  // Only pull when a consumer is still attached: flowing, or a `readable` listener wants data.
  if (state.flowing !== true && !state.readableListening) return;
  if (state.length >= state.highWaterMark) return;
  stream.read(0);
}

function chunkSize(state, chunk) {
  return state.objectMode ? 1 : chunk.length;
}

function pushChunk(stream, chunk, encoding, fromUnshift) {
  const state = stream._readableState;
  if (!state || state.destroyed) return false;
  state.reading = false;

  if (chunk === null) {
    if (state.ended) return false;
    state.ended = true;
    if (state.flowing === true && state.length === 0) {
      // Node emits `readable` for EOF when nobody has read yet (`state.sync`); the flow that
      // follows ends the stream a tick later. Without the extra hop `end` would race `finish`.
      if (state.sync) scheduleReadable(stream);
      else scheduleEnd(stream);
    } else if (state.readableListening && !state.flowing) scheduleReadable(stream);
    return false;
  }

  if (state.ended) {
    destroyStream(stream, pushAfterEofError());
    return false;
  }

  let value = chunk;
  if (state.objectMode) {
    if (value === undefined) value = undefined;
  } else if (typeof value === "string") {
    value = Buffer.from(value, encoding || state.defaultEncoding);
    if (state.decoder) value = state.decoder.write(value);
    if (value.length === 0) return true;
  } else if (value instanceof Uint8Array) {
    if (state.decoder) {
      value = state.decoder.write(value);
      if (value.length === 0) return true;
    }
  } else {
    throw invalidArgType("chunk", "string, Buffer or Uint8Array", value);
  }

  if (fromUnshift) {
    state.buffer.unshift(value);
    state.length += chunkSize(state, value);
    return state.length < state.highWaterMark;
  }

  // Flowing with nothing buffered: emit straight through (Node's `addChunk` fast path).
  if (state.flowing === true && state.length === 0 && !state.sync) {
    stream.emit("data", value);
    if (state.ended) scheduleEnd(stream);
    // The consumer received the chunk through `data`, outside any `read()` loop, so nothing
    // would ask `_read` for the next one: re-arm the pull (Node's addChunk does the same
    // through maybeReadMore).
    else scheduleReadMore(stream);
    return !state.ended && (state.length < state.highWaterMark || state.length === 0);
  }

  state.buffer.push(value);
  state.length += chunkSize(state, value);
  if (state.readableListening && !state.flowing) scheduleReadable(stream);
  if (state.flowing === true && !state.sync) flowFrom(stream);
  return !state.ended && (state.length < state.highWaterMark || state.length === 0);
}

function consumeBytes(state, n) {
  const first = state.buffer[0];
  if (first.length === n) {
    state.buffer.shift();
    return first;
  }
  if (first.length > n) {
    state.buffer[0] = first.subarray(n);
    return first.subarray(0, n);
  }
  const parts = [];
  let remaining = n;
  while (remaining > 0 && state.buffer.length > 0) {
    const chunk = state.buffer[0];
    if (chunk.length <= remaining) {
      parts.push(chunk);
      state.buffer.shift();
      remaining -= chunk.length;
    } else {
      parts.push(chunk.subarray(0, remaining));
      state.buffer[0] = chunk.subarray(remaining);
      remaining = 0;
    }
  }
  if (parts.length === 1) return parts[0];
  return Buffer.concat(parts, n);
}

function readableWanted(n, state) {
  // `read()` without a size hands out one buffered chunk at a time, like Node.
  if (n === undefined || n === null || (typeof n === "number" && Number.isNaN(n))) {
    return state.length > 0 ? state.buffer[0].length : 0;
  }
  let wanted = Number(n);
  if (Number.isNaN(wanted) || wanted < 0) throw outOfRange("n", ">= 0", n);
  if (wanted > state.length) wanted = state.length;
  return wanted;
}

function readFrom(stream, n) {
  const state = stream._readableState;
  if (!state) return null;
  // Node keeps already-buffered chunks readable after `destroy()` (notably after the
  // ERR_STREAM_PUSH_AFTER_EOF path); only reads that would have to pull more data stop.
  if (state.destroyed && state.length === 0) return null;
  state.sync = false;

  if (state.objectMode) {
    if (state.buffer.length === 0) {
      if (state.ended) {
        scheduleEnd(stream);
        return null;
      }
      maybeRead(stream);
      if (state.buffer.length === 0) return null;
    }
    // Node asks `_read` for more before handing out a buffered chunk whenever the buffer is
    // below the high-water mark (this is what makes `_read` run before the first piped chunk).
    if (
      !state.destroyed &&
      !state.reading &&
      !state.ended &&
      state.length - 1 < state.highWaterMark
    ) {
      maybeRead(stream);
    }
    if (state.buffer.length === 0) return null;
    const value = state.buffer.shift();
    state.length -= 1;
    if (state.length === 0 && state.ended) scheduleEnd(stream);
    else if (state.readableListening && !state.flowing) {
      // Node re-emits `readable` only once the buffer is back at the high-water mark: its
      // maybeReadMore loop calls read(0), and read(0) emits only at/above the mark (or at EOF
      // with data). The read that got us here already cleared `needReadable`.
      if (state.length >= state.highWaterMark) scheduleReadable(stream);
      else maybeRead(stream);
    }
    stream.emit("data", value);
    return value;
  }

  if (n === 0) {
    if (state.length === 0 && !state.ended) maybeRead(stream);
    if (state.ended) scheduleEnd(stream);
    return null;
  }

  if (state.length === 0) {
    if (state.ended) {
      scheduleEnd(stream);
      return null;
    }
    if (state.reading) return null;
    maybeRead(stream);
  }

  // Asking for more than is buffered triggers a read and yields nothing until it arrives,
  // unless the stream has ended (then the remainder is returned).
  if (
    n !== undefined &&
    n !== null &&
    !(typeof n === "number" && Number.isNaN(n)) &&
    Number(n) > state.length &&
    !state.ended
  ) {
    maybeRead(stream);
    return null;
  }

  let wanted = readableWanted(n, state);
  if (
    !state.destroyed &&
    !state.reading &&
    !state.ended &&
    state.length - wanted < state.highWaterMark
  ) {
    maybeRead(stream);
    // `_read` may have pushed synchronously; re-evaluate how much is available (Node does).
    if (!state.reading) wanted = readableWanted(n, state);
  }
  if (wanted === 0) {
    if (state.ended) scheduleEnd(stream);
    return null;
  }

  const chunk = consumeBytes(state, wanted);
  state.length -= wanted;
  if (state.length === 0 && state.ended) scheduleEnd(stream);
  else if (state.readableListening && !state.flowing) {
    if (state.length >= state.highWaterMark) scheduleReadable(stream);
    else maybeRead(stream);
  }
  stream.emit("data", chunk);
  return chunk;
}

function flowFrom(stream) {
  // `read()` emits `data` itself, exactly like Node's `Readable.prototype.read`.
  const state = stream._readableState;
  if (!state || state.destroyed || state.flowing !== true) return;
  let chunk = stream.read();
  while (chunk !== null) {
    if (state.flowing !== true || state.destroyed) return;
    chunk = stream.read();
  }
}

function resumeFlow(stream) {
  const state = stream._readableState;
  if (!state || state.destroyed || state.flowing !== true) return;
  stream.emit("resume");
  if (state.flowing !== true) return;
  flowFrom(stream);
  if (state.ended && state.length === 0) scheduleEnd(stream);
}

function scheduleReadable(stream) {
  const state = stream._readableState;
  if (!state || state.emittedReadable) return;
  state.emittedReadable = true;
  scheduleTick(emitReadableNow, stream);
}

function emitReadableNow(stream) {
  const state = stream._readableState;
  if (!state) return;
  state.emittedReadable = false;
  if (state.destroyed || state.errored) return;
  stream.emit("readable");
  if (state.ended && state.length === 0) scheduleEnd(stream);
}

function scheduleEnd(stream) {
  const state = stream._readableState;
  if (!state || state.endScheduled || state.endEmitted) return;
  state.endScheduled = true;
  scheduleTick(emitEndNow, stream);
}

function emitEndNow(stream) {
  const state = stream._readableState;
  if (!state) return;
  state.endScheduled = false;
  if (state.endEmitted || !state.ended || state.length > 0 || state.destroyed) return;
  state.endEmitted = true;
  stream.emit("end");
  maybeAutoDestroy(stream);
}

// 'data' listeners switch the stream to flowing mode; 'readable' listeners switch it back to
// pull mode (Node's `Readable.prototype.on` does the same through `resume()`/`read(0)`).
//
// This is written against the public `on`/`prependListener` API rather than an internal
// `_addListener` hook so it works with both onde's `events` and Node's builtin.
function afterAddListener(stream, type) {
  const state = stream._readableState;
  if (!state) return;
  if (type === "data") {
    if (state.flowing !== false) stream.resume();
  } else if (type === "readable") {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = true;
      state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      if (state.length > 0) scheduleReadable(stream);
      else scheduleTick(startReadablePull, stream);
    }
  }
}

function startReadablePull(stream) {
  const state = stream._readableState;
  if (!state || state.destroyed || state.endEmitted) return;
  if (state.length > 0) {
    scheduleReadable(stream);
    return;
  }
  if (!state.reading) stream.read(0);
}

function wrapOn(base) {
  return function on(type, listener) {
    const result = base.call(this, type, listener);
    afterAddListener(this, type);
    return result === undefined ? this : result;
  };
}

function wrapPrepend(base) {
  return function prependListener(type, listener) {
    const result = base.call(this, type, listener);
    afterAddListener(this, type);
    return result === undefined ? this : result;
  };
}

Readable.prototype.on = wrapOn(EventEmitter.prototype.on);
Readable.prototype.addListener = Readable.prototype.on;
Readable.prototype.prependListener = wrapPrepend(EventEmitter.prototype.prependListener);

// --- Readable.from ---------------------------------------------------------------------------

function fromIterable(iterable, opts) {
  const options = checkOptions(opts, "options");
  if (iterable === null || iterable === undefined) {
    throw invalidArgType("iterable", "Iterable, AsyncIterable or Stream", iterable);
  }
  // Strings and byte arrays are single chunks, not iterables of characters/bytes.
  if (typeof iterable === "string" || iterable instanceof Uint8Array) {
    iterable = [iterable];
  }
  let iterator;
  if (typeof iterable[Symbol.asyncIterator] === "function") {
    iterator = iterable[Symbol.asyncIterator]();
  } else if (typeof iterable[Symbol.iterator] === "function") {
    iterator = iterable[Symbol.iterator]();
  } else {
    throw invalidArgType("iterable", "Iterable, AsyncIterable or Stream", iterable);
  }

  let reading = false;
  let finished = false;
  let isAsync = typeof iterable[Symbol.asyncIterator] === "function";
  const streamOptions = Object.assign({}, options, {
    objectMode: options.objectMode !== undefined ? Boolean(options.objectMode) : true,
    // Node pins `Readable.from` to a one-chunk high-water mark so that a flowing consumer is
    // handed each value as soon as it is pulled.
    highWaterMark: options.highWaterMark !== undefined ? options.highWaterMark : 1,
    read() {
      pump();
    },
    destroy(err, cb) {
      finished = true;
      if (iterator && typeof iterator.return === "function") {
        let result;
        try {
          result = iterator.return();
        } catch (returnError) {
          cb(err || returnError);
          return;
        }
        if (result && typeof result.then === "function") {
          result.then(
            function onReturned() {
              cb(err);
            },
            function onReturnError(returnError) {
              cb(err || returnError);
            },
          );
          return;
        }
      }
      cb(err);
    },
  });

  const stream = new Readable(streamOptions);

  function fail(err) {
    reading = false;
    finished = true;
    stream.destroy(err);
  }

  // Push one iteration result. Returns false when the pump should stop (EOF, null value or
  // backpressure) and true when the next value should be pulled immediately.
  function accept(result) {
    if (finished) return false;
    if (result.done) {
      finished = true;
      reading = false;
      stream.push(null);
      return false;
    }
    const value = result.value;
    if (value === null) {
      fail(nullValuesError());
      return false;
    }
    if (!stream.push(value)) {
      reading = false;
      return false;
    }
    return true;
  }

  function pump() {
    if (reading || finished) return;
    reading = true;
    if (isAsync) {
      stepAsync();
      return;
    }
    // Synchronous iterables are drained in a loop, like Node, instead of recursing per value.
    for (;;) {
      let result;
      try {
        result = iterator.next();
      } catch (err) {
        fail(err);
        return;
      }
      if (result && typeof result.then === "function") {
        // A sync iterable that yields promises: switch to the async path for the rest.
        isAsync = true;
        result.then(function onFirstAsync(value) {
          if (finished) return;
          if (value === null) {
            fail(nullValuesError());
            return;
          }
          reading = false;
          if (stream.push(value)) pump();
        }, fail);
        return;
      }
      if (!accept(result)) return;
    }
  }

  function stepAsync() {
    let result;
    try {
      result = iterator.next();
    } catch (err) {
      fail(err);
      return;
    }
    if (!result || typeof result.then !== "function") {
      if (accept(result)) stepAsync();
      return;
    }
    result.then(function onAsyncResult(settled) {
      if (finished) return;
      if (accept(settled)) stepAsync();
    }, fail);
  }

  return stream;
}

// --- pipe ------------------------------------------------------------------------------------

function pipeFrom(stream, dest, options) {
  const state = stream._readableState;
  const opts = options === undefined || options === null ? {} : options;
  const doEnd = opts.end !== false;
  if (!dest || typeof dest.write !== "function") {
    throw invalidArgType("dest", "Writable stream", dest);
  }

  const entry = {
    dest,
    ondata: null,
    ondrain: null,
    onend: null,
    onfinish: null,
    onerror: null,
  };

  function ondata(chunk) {
    const ret = dest.write(chunk);
    if (ret === false) {
      state.flowing = false;
      dest.once("drain", entry.ondrain);
    }
  }

  function ondrain() {
    if (stream.destroyed) return;
    if (state.pipes.indexOf(entry) < 0) return;
    stream.resume();
  }

  function onend() {
    if (!doEnd) return;
    if (typeof dest.end === "function" && !dest.writableEnded) dest.end();
  }

  function onfinish() {
    unpipeEntry(stream, entry);
  }

  function onerror(err) {
    unpipeEntry(stream, entry);
    destroyStream(dest, err);
    destroyStream(stream, err);
  }

  entry.ondata = ondata;
  entry.ondrain = ondrain;
  entry.onend = onend;
  entry.onfinish = onfinish;
  entry.onerror = onerror;

  state.pipes.push(entry);
  dest.emit("pipe", stream);
  stream.on("data", ondata);
  stream.once("end", onend);
  stream.on("error", onerror);
  if (typeof dest.on === "function") {
    dest.once("finish", onfinish);
    dest.on("error", onerror);
  }
  return dest;
}

function unpipeEntry(stream, entry) {
  const state = stream._readableState;
  if (!state) return;
  const index = state.pipes.indexOf(entry);
  if (index < 0) return;
  state.pipes.splice(index, 1);
  stream.removeListener("data", entry.ondata);
  stream.removeListener("end", entry.onend);
  stream.removeListener("error", entry.onerror);
  const dest = entry.dest;
  if (dest && typeof dest.removeListener === "function") {
    dest.removeListener("finish", entry.onfinish);
    dest.removeListener("error", entry.onerror);
    dest.removeListener("drain", entry.ondrain);
    dest.emit("unpipe", stream);
  }
}

// --- async iteration -------------------------------------------------------------------------

function createAsyncIterator(stream) {
  const queue = [];
  let waiting = null;
  let ended = false;
  let failure = null;
  let closed = false;
  let started = false;

  function settle() {
    if (!waiting) return;
    if (queue.length > 0) {
      const waiter = waiting;
      waiting = null;
      const value = queue.shift();
      if (queue.length === 0 && !ended) stream.resume();
      waiter.resolve({ value, done: false });
      return;
    }
    if (failure) {
      const waiter = waiting;
      waiting = null;
      const error = failure;
      failure = null;
      waiter.reject(error);
      return;
    }
    if (ended || closed) {
      const waiter = waiting;
      waiting = null;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  function ondata(chunk) {
    queue.push(chunk);
    stream.pause();
    settle();
  }

  function onend() {
    ended = true;
    settle();
  }

  function onerror(err) {
    if (!failure) failure = err;
    settle();
  }

  function onclose() {
    closed = true;
    if (!ended && !failure) failure = prematureCloseError();
    settle();
  }

  function start() {
    if (started) return;
    started = true;
    stream.on("data", ondata);
    stream.on("end", onend);
    stream.on("error", onerror);
    if (stream._readableState && stream._readableState.emitClose !== false) {
      stream.on("close", onclose);
    }
  }

  function cleanup() {
    if (!started) return;
    stream.removeListener("data", ondata);
    stream.removeListener("end", onend);
    stream.removeListener("error", onerror);
    stream.removeListener("close", onclose);
  }

  const iterator = {
    next() {
      if (!started) {
        start();
        if (queue.length === 0) stream.resume();
      }
      if (queue.length > 0) {
        const value = queue.shift();
        if (queue.length === 0 && !ended) stream.resume();
        return Promise.resolve({ value, done: false });
      }
      if (failure) {
        const error = failure;
        failure = null;
        cleanup();
        return Promise.reject(error);
      }
      if (ended || closed) {
        cleanup();
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise(function wait(resolve, reject) {
        waiting = { resolve, reject };
      });
    },

    return() {
      cleanup();
      if (!ended) destroyStream(stream);
      ended = true;
      if (waiting) {
        const waiter = waiting;
        waiting = null;
        waiter.resolve({ value: undefined, done: true });
      }
      return Promise.resolve({ value: undefined, done: true });
    },

    throw(err) {
      cleanup();
      destroyStream(stream, err);
      ended = true;
      return Promise.reject(err);
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return iterator;
}

// ---------------------------------------------------------------------------------------------
// Writable
// ---------------------------------------------------------------------------------------------

function initWritable(stream, options) {
  const objectMode = Boolean(options.objectMode);
  const state = {
    objectMode,
    highWaterMark: toWritableHighWaterMark(options, objectMode),
    defaultEncoding: typeof options.defaultEncoding === "string" ? options.defaultEncoding : "utf8",
    decodeStrings: options.decodeStrings !== false,
    buffer: [],
    length: 0,
    writing: false,
    sync: false,
    corked: 0,
    needDrain: false,
    ending: false,
    finished: false,
    endCallback: null,
    finalCalled: false,
    emitClose: options.emitClose !== false,
    autoDestroy: options.autoDestroy !== false,
    destroyed: false,
    errored: null,
    closed: false,
    closeEmitted: false,
  };
  stream._writableState = state;
  if (typeof options.write === "function") stream._write = options.write;
  if (typeof options.writev === "function") stream._writev = options.writev;
  if (typeof options.final === "function") stream._final = options.final;
  if (typeof options.destroy === "function") stream._destroy = options.destroy;
}

class Writable extends Stream {
  constructor(opts) {
    super();
    initWritable(this, checkOptions(opts, "options"));
  }

  // -- getters ---------------------------------------------------------------------------------

  get writable() {
    const state = this._writableState;
    if (!state) return false;
    return !state.destroyed && !state.ending && !state.errored;
  }

  get writableEnded() {
    return Boolean(this._writableState && this._writableState.ending);
  }

  get writableFinished() {
    return Boolean(this._writableState && this._writableState.finished);
  }

  get writableNeedDrain() {
    return Boolean(this._writableState && this._writableState.needDrain);
  }

  get writableHighWaterMark() {
    return this._writableState ? this._writableState.highWaterMark : 0;
  }

  get writableObjectMode() {
    return Boolean(this._writableState && this._writableState.objectMode);
  }

  get writableLength() {
    return this._writableState ? this._writableState.length : 0;
  }

  get writableCorked() {
    return this._writableState ? this._writableState.corked : 0;
  }

  // -- writing ---------------------------------------------------------------------------------

  _write() {
    throw methodNotImplemented("_write()");
  }

  write(chunk, encoding, cb) {
    return writeChunk(this, chunk, encoding, cb);
  }

  end(chunk, encoding, cb) {
    const state = this._writableState;
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (!state) return this;

    if (state.destroyed) {
      if (typeof cb === "function") {
        const err = state.errored || destroyedError("end");
        scheduleTick(cb, err);
      }
      return this;
    }

    if (typeof cb === "function") {
      if (state.finished) scheduleTick(cb, null);
      else if (state.errored) scheduleTick(cb, state.errored);
      else state.endCallback = cb;
    }

    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);

    state.ending = true;
    if (state.corked) {
      state.corked = 1;
      this.uncork();
    }
    finishMaybe(this, state);
    return this;
  }

  cork() {
    const state = this._writableState;
    if (state) state.corked += 1;
    return this;
  }

  uncork() {
    const state = this._writableState;
    if (!state || state.corked === 0) return this;
    state.corked = state.corked > 1 ? 1 : 0;
    if (state.corked === 0) clearBuffer(this, state);
    return this;
  }

  setDefaultEncoding(encoding) {
    const state = this._writableState;
    if (state) state.defaultEncoding = encoding;
    return this;
  }
}

function bufferEntrySize(state, chunk) {
  return state.objectMode ? 1 : chunk.length;
}

function writeChunk(stream, chunk, encoding, cb) {
  const state = stream._writableState;
  if (typeof encoding === "function") {
    cb = encoding;
    encoding = undefined;
  }
  if (typeof cb !== "function") cb = noop;
  if (!state) {
    cb(invalidArgType("stream", "Writable", stream));
    return false;
  }

  if (state.ending) {
    const err = writeAfterEndError();
    scheduleTick(cb, err);
    destroyStream(stream, err);
    return false;
  }

  if (state.destroyed) {
    scheduleTick(cb, state.errored || destroyedError("write"));
    return false;
  }

  let value = chunk;
  let valueEncoding = encoding;
  if (value === null) throw nullValuesError();
  if (state.objectMode) {
    // Objects (including strings) are written untouched in object mode.
  } else if (typeof value === "string") {
    if (!valueEncoding) valueEncoding = state.defaultEncoding;
    if (state.decodeStrings) {
      value = Buffer.from(value, valueEncoding);
      valueEncoding = "buffer";
    }
  } else if (value instanceof Uint8Array) {
    valueEncoding = "buffer";
  } else {
    throw invalidArgType("chunk", "string, Buffer or Uint8Array", value);
  }

  return writeOrBuffer(stream, state, value, valueEncoding || "buffer", cb);
}

function writeOrBuffer(stream, state, chunk, encoding, cb) {
  const size = bufferEntrySize(state, chunk);
  state.length += size;
  const ret = state.length < state.highWaterMark;
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked > 0 || state.buffer.length > 0) {
    state.buffer.push({ chunk, encoding, callback: cb, size });
  } else {
    state.writing = true;
    doWrite(stream, state, chunk, encoding, cb, size);
  }
  return ret;
}

function doWrite(stream, state, chunk, encoding, cb, size) {
  let called = false;
  state.sync = true;
  function onwrite(err) {
    if (called) {
      destroyStream(stream, codedError(Error, "ERR_MULTIPLE_CALLBACK", "Callback called multiple times"));
      return;
    }
    called = true;
    onWriteFinished(stream, state, err, cb, size);
  }
  try {
    stream._write(chunk, encoding, onwrite);
  } catch (err) {
    onwrite(err);
  }
  state.sync = false;
}

function onWriteFinished(stream, state, err, cb, size) {
  const sync = state.sync;
  state.writing = false;
  state.length -= size;
  if (state.length < 0) state.length = 0;

  function done() {
    if (err) {
      cb(err);
      destroyStream(stream, err);
      return;
    }
    cb();
    if (state.destroyed) return;
    if (!state.writing && state.corked === 0) clearBuffer(stream, state);
    if (!state.writing && state.buffer.length === 0) {
      if (!state.ending && state.length === 0 && state.needDrain) {
        state.needDrain = false;
        stream.emit("drain");
      }
      finishMaybe(stream, state);
    }
  }

  if (sync) scheduleTick(done);
  else done();
}

function clearBuffer(stream, state) {
  if (!state || state.corked > 0 || state.writing || state.buffer.length === 0) return;
  if (state.destroyed) return;

  if (state.buffer.length > 1 && typeof stream._writev === "function") {
    const entries = state.buffer;
    state.buffer = [];
    let size = 0;
    const chunks = new Array(entries.length);
    for (let i = 0; i < entries.length; i += 1) {
      chunks[i] = { chunk: entries[i].chunk, encoding: entries[i].encoding };
      size += entries[i].size;
    }
    const callbacks = entries.map(function pick(entry) {
      return entry.callback;
    });
    state.writing = true;
    let called = false;
    state.sync = true;
    function onwritev(err) {
      if (called) return;
      called = true;
      const finished = [];
      for (let i = 0; i < callbacks.length; i += 1) finished.push(callbacks[i]);
      onWriteFinished(stream, state, err, function batch() {
        for (let i = 0; i < finished.length; i += 1) finished[i](err);
      }, size);
    }
    try {
      stream._writev(chunks, onwritev);
    } catch (err) {
      onwritev(err);
    }
    state.sync = false;
    return;
  }

  const entry = state.buffer.shift();
  state.writing = true;
  doWrite(stream, state, entry.chunk, entry.encoding, entry.callback, entry.size);
}

function finishMaybe(stream, state) {
  if (!state || state.destroyed || state.finished) return;
  if (!state.ending || state.writing || state.buffer.length > 0 || state.errored) return;

  if (typeof stream._final === "function" && !state.finalCalled) {
    state.finalCalled = true;
    state.sync = true;
    let called = false;
    function onfinal(err) {
      if (called) return;
      called = true;
      if (err) {
        destroyStream(stream, err);
        return;
      }
      finishStream(stream, state);
    }
    try {
      stream._final(onfinal);
    } catch (err) {
      onfinal(err);
    }
    state.sync = false;
    return;
  }

  finishStream(stream, state);
}

function finishStream(stream, state) {
  if (state.finished || state.destroyed) return;
  scheduleTick(function emitFinish() {
    if (state.finished || state.destroyed) return;
    state.finished = true;
    const endCallback = state.endCallback;
    state.endCallback = null;
    if (endCallback) endCallback(null);
    stream.emit("finish");
    maybeAutoDestroy(stream);
  });
}

// ---------------------------------------------------------------------------------------------
// Duplex
// ---------------------------------------------------------------------------------------------

class Duplex extends Readable {
  constructor(opts) {
    const options = checkOptions(opts, "options");
    super(options);
    initWritable(this, options);
    this.allowHalfOpen = options.allowHalfOpen !== false;
    if (options.allowHalfOpen === false) {
      // Node ends the writable side when the readable side ends, not the other way round. The
      // automatic `end()` is deferred to the next tick (Node's `onend`/`onEndNT` pair): an `'end'`
      // listener registered by the user runs while the emit is still in progress, and a reply it
      // writes from there must reach the peer before the writable side is closed.
      const stream = this;
      this.once("end", function onEndHalfOpen() {
        scheduleTick(onEndHalfOpenNextTick, stream);
      });
    }
  }
}

function onEndHalfOpenNextTick(stream) {
  // Node re-checks `allowHalfOpen` at the event, so flipping it after construction opts out.
  if (stream.allowHalfOpen) return;
  if (!stream._writableState.ending) stream.end();
}

// The writable half of a duplex lives on the same prototype chain; copy the accessors and
// methods over so `duplex.write()`/`duplex.writableEnded` exist without Writable in the chain.
(function mixinWritable(target) {
  const source = Writable.prototype;
  const keys = Reflect.ownKeys(source);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(target, key, descriptor);
  }
})(Duplex.prototype);

// ---------------------------------------------------------------------------------------------
// Transform / PassThrough
// ---------------------------------------------------------------------------------------------

class Transform extends Duplex {
  constructor(opts) {
    const options = checkOptions(opts, "options");
    super(options);
    if (typeof options.transform === "function") this._transform = options.transform;
    if (typeof options.flush === "function") this._flush = options.flush;
    this._transformState = {
      chunk: null,
      encoding: null,
      callback: null,
      transforming: false,
      needTransform: false,
    };
    // Node's Transform constructor clears the readable "sync" guard: a transform callback that
    // pushes while the stream is flowing must emit `data` immediately instead of buffering.
    this._readableState.sync = false;
  }

  _read() {
    const state = this._transformState;
    if (state.chunk !== null && !state.transforming) {
      state.transforming = true;
      const stream = this;
      this._transform(state.chunk, state.encoding, function afterTransform(err, data) {
        stream._afterTransform(err, data);
      });
      return;
    }
    state.needTransform = true;
  }

  _afterTransform(err, data) {
    const state = this._transformState;
    state.transforming = false;
    state.chunk = null;
    state.encoding = null;
    const cb = state.callback;
    state.callback = null;
    if (err) {
      if (cb) cb(err);
      return;
    }
    if (data !== undefined && data !== null) this.push(data);
    if (cb) cb();
    const readable = this._readableState;
    if (state.needTransform || readable.needReadable || readable.length < readable.highWaterMark) {
      state.needTransform = false;
      this._read(readable.highWaterMark);
    }
  }

  _write(chunk, encoding, cb) {
    const state = this._transformState;
    state.chunk = chunk;
    state.encoding = encoding;
    state.callback = cb;
    const readable = this._readableState;
    if (!state.transforming) {
      // Same gate as Node's Transform.prototype._write: a transform that is not currently
      // running still needs `_read` to start it even when nothing is asking for output.
      if (state.needTransform || readable.needReadable || readable.length < readable.highWaterMark) {
        this._read(readable.highWaterMark);
      }
    }
  }

  _transform() {
    throw methodNotImplemented("_transform()");
  }

  _final(cb) {
    const stream = this;
    let called = false;
    function onflush(err, data) {
      if (called) return;
      called = true;
      if (err) {
        cb(err);
        return;
      }
      if (data !== undefined && data !== null) stream.push(data);
      stream.push(null);
      cb();
    }
    if (typeof this._flush === "function") {
      try {
        this._flush(onflush);
      } catch (err) {
        onflush(err);
      }
      return;
    }
    onflush();
  }
}

class PassThrough extends Transform {
  _transform(chunk, encoding, cb) {
    cb(null, chunk);
  }
}

// ---------------------------------------------------------------------------------------------
// finished
// ---------------------------------------------------------------------------------------------

function isReadableNodeStream(stream) {
  return Boolean(stream && stream._readableState);
}

function isWritableNodeStream(stream) {
  return Boolean(stream && stream._writableState);
}

function streamEmitClose(stream) {
  // Node's `willEmitClose`: the stream will emit `close` when it is done, so `finished` can (and
  // must) use `close` instead of `end`/`finish` to decide when the callback runs.
  const readable = stream._readableState;
  const writable = stream._writableState;
  const state = writable || readable;
  return Boolean(
    (!state || state.autoDestroy) &&
      (!writable || writable.emitClose !== false) &&
      (!readable || readable.emitClose !== false),
  );
}

function finished(stream, opts, callback) {
  if (typeof opts === "function") {
    callback = opts;
    opts = undefined;
  }
  if (typeof callback !== "function") {
    throw invalidArgType("callback", "function", callback);
  }
  const options = opts === undefined || opts === null ? {} : opts;
  if (stream === null || typeof stream !== "object" || typeof stream.on !== "function") {
    throw invalidArgType("stream", "ReadableStream or WritableStream", stream);
  }
  if (options.signal !== undefined && options.signal !== null) {
    const signal = options.signal;
    if (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
      throw invalidArgType("options.signal", "AbortSignal", signal);
    }
  }

  const readableSide =
    options.readable !== undefined ? Boolean(options.readable) : isReadableNodeStream(stream);
  const writableSide =
    options.writable !== undefined ? Boolean(options.writable) : isWritableNodeStream(stream);
  const willEmitClose = streamEmitClose(stream);
  const readableState = stream._readableState;
  const writableState = stream._writableState;

  let readableDone = !readableSide || Boolean(readableState && readableState.endEmitted);
  let writableDone = !writableSide || Boolean(writableState && writableState.finished);
  let storedError = null;
  let done = false;
  let removeAbort = null;

  function cleanup() {
    stream.removeListener("end", onend);
    stream.removeListener("finish", onfinish);
    stream.removeListener("error", onerror);
    stream.removeListener("close", onclose);
    if (removeAbort !== null) {
      removeAbort();
      removeAbort = null;
    }
  }

  function currentError() {
    return (
      storedError ||
      (readableState && readableState.errored) ||
      (writableState && writableState.errored) ||
      null
    );
  }

  function closeError() {
    const error = currentError();
    if (error) return error;
    if (readableSide && !readableDone) return prematureCloseError();
    if (writableSide && !writableDone) return prematureCloseError();
    return null;
  }

  function complete(err) {
    if (done) return;
    done = true;
    cleanup();
    if (err !== undefined && err !== null) callback.call(stream, err);
    else callback.call(stream);
  }

  function check() {
    if (done) return;
    // With `close` coming, Node completes from onclose only; otherwise end+finish are the
    // completion condition (this is what orders a Readable's callback after its close).
    if (!willEmitClose && readableDone && writableDone) complete(storedError || undefined);
  }

  function onend() {
    readableDone = true;
    check();
  }

  function onfinish() {
    writableDone = true;
    check();
  }

  function onerror(err) {
    if (!storedError) storedError = err;
    // Node does not attach this listener at all for `{ error: false }`; `close` still reports the
    // stream's errored state, which is why the test above sees the Error either way.
    if (options.error === false) return;
    complete(err);
  }

  function onclose() {
    if (done) return;
    complete(closeError() || undefined);
  }

  stream.on("end", onend);
  stream.on("finish", onfinish);
  stream.on("error", onerror);
  if (willEmitClose) stream.on("close", onclose);

  if (options.signal !== undefined && options.signal !== null) {
    const signal = options.signal;
    if (signal.aborted) {
      scheduleTick(complete, abortError(signal));
    } else {
      const onabort = function onabort() {
        complete(abortError(signal));
      };
      signal.addEventListener("abort", onabort, { once: true });
      removeAbort = function removeAbortListener() {
        signal.removeEventListener("abort", onabort);
      };
    }
  }

  if (!willEmitClose && readableDone && writableDone) {
    scheduleTick(complete, storedError || undefined);
  } else if (stream.destroyed) {
    scheduleTick(function reportDestroyed() {
      complete(closeError() || undefined);
    });
  }

  return cleanup;
}

// ---------------------------------------------------------------------------------------------
// pipeline / addAbortSignal
// ---------------------------------------------------------------------------------------------

function isOptionsObject(value) {
  if (value === null || typeof value !== "object") return false;
  if (isReadableNodeStream(value) || isWritableNodeStream(value)) return false;
  if (typeof value.pipe === "function" || typeof value.write === "function") return false;
  return "signal" in value || "end" in value;
}

function addAbortSignal(signal, stream) {
  if (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    throw invalidArgType("signal", "AbortSignal", signal);
  }
  if (stream === null || typeof stream !== "object" || typeof stream.destroy !== "function") {
    throw invalidArgType("stream", "stream.Readable", stream);
  }
  if (signal.aborted) {
    destroyStream(stream, abortError(signal));
    return stream;
  }
  if (typeof signal.addEventListener === "function") {
    signal.addEventListener(
      "abort",
      function onabort() {
        destroyStream(stream, abortError(signal));
      },
      { once: true },
    );
  }
  return stream;
}

function pipeline() {
  let args = [];
  for (let i = 0; i < arguments.length; i += 1) args.push(arguments[i]);

  let callback = noop;
  if (args.length > 0 && typeof args[args.length - 1] === "function") {
    callback = args.pop();
  }

  let options = {};
  if (args.length > 0 && isOptionsObject(args[args.length - 1])) {
    options = args.pop();
  }

  if (args.length === 1 && Array.isArray(args[0])) args = args[0];

  if (args.length < 2) {
    throw codedError(TypeError, "ERR_MISSING_ARGS", 'The "streams" argument must be specified');
  }

  const streams = args;
  for (let i = 0; i < streams.length; i += 1) {
    const stream = streams[i];
    if (!isReadableNodeStream(stream) && !isWritableNodeStream(stream)) {
      throw invalidArgType(`streams[${i}]`, "stream.Readable or stream.Writable", stream);
    }
  }

  const signal = options.signal;
  let removeAbort = null;
  let done = false;

  function finish(err) {
    if (done) return;
    done = true;
    if (removeAbort !== null) {
      removeAbort();
      removeAbort = null;
    }
    if (err) {
      for (let i = 0; i < streams.length; i += 1) {
        const stream = streams[i];
        if (!stream) continue;
        // Keep an error listener attached while destroying so a failed destroy cannot turn into
        // an uncaught 'error' event after `finished` cleaned its listeners up.
        if (typeof stream.on === "function") stream.on("error", noop);
        if (typeof stream.destroy === "function" && !stream.destroyed) stream.destroy(err);
      }
      scheduleTick(callback, err);
    } else {
      scheduleTick(callback);
    }
  }

  for (let i = 0; i < streams.length; i += 1) {
    const stream = streams[i];
    const isLast = i === streams.length - 1;
    finished(stream, function onStreamFinished(err) {
      if (err) finish(err);
      else if (isLast) finish();
    });
  }

  // Link the chain: Readable.pipe handles backpressure, 'end' propagation and cleanup.
  for (let i = 0; i + 1 < streams.length; i += 1) {
    const source = streams[i];
    const dest = streams[i + 1];
    if (typeof source.pipe !== "function") {
      throw invalidArgType(`streams[${i}]`, "stream.Readable", source);
    }
    source.pipe(dest);
  }

  if (signal !== undefined && signal !== null) {
    if (typeof signal.aborted !== "boolean") {
      throw invalidArgType("options.signal", "AbortSignal", signal);
    }
    if (signal.aborted) {
      finish(abortError(signal));
    } else {
      const onabort = function onabort() {
        finish(abortError(signal));
      };
      signal.addEventListener("abort", onabort, { once: true });
      removeAbort = function removeAbortListener() {
        signal.removeEventListener("abort", onabort);
      };
    }
  }

  return streams[streams.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------------------------

function isReadable(stream) {
  if (stream === null || stream === undefined || typeof stream !== "object") return false;
  if (stream.readable === undefined) return null;
  return Boolean(stream.readable);
}

function isWritable(stream) {
  if (stream === null || stream === undefined || typeof stream !== "object") return false;
  if (stream.writable === undefined) return null;
  return Boolean(stream.writable);
}

function isDestroyed(stream) {
  if (stream === null || stream === undefined) return true;
  return Boolean(stream.destroyed);
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;

module.exports = {
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
  addAbortSignal,
  isReadable,
  isWritable,
  isDestroyed,
};
