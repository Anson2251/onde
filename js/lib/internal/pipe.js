"use strict";

// `internal/pipe` — a child process stdio pipe as a stream (M5, ADR-0008 §2.6).
//
// One child handle owns all three pipes; the JS side tags reads and writes with the stream number.
// `Readable`/`Writable` do the buffering and backpressure, so `child.stdout.pause()` simply stops
// issuing `read` commands and the Rust task stops pulling the OS pipe.
//
// Pull-based reads: `_read` issues one `read` and waits for the matching `data` event, so at most
// one read is in flight per stream. `drain` from the task releases the pending write callback when
// the write queue empties.

const { Readable, Writable } = require("./stream.js");
const { Buffer } = require("./buffer.js");

const host = globalThis.__ln_host;
const MAX_CHUNK = 64 * 1024;

class PipeReadable extends Readable {
  constructor(id, stream, options) {
    super(options);
    this._id = id;
    this._stream = stream;
    this._readInFlight = false;
  }

  _read() {
    if (this._readInFlight || this.destroyed) return;
    this._readInFlight = true;
    host.proc(this._id, "read", [this._stream, MAX_CHUNK]);
  }

  /// Called by `child_process` when the task delivers bytes for this stream.
  pushChunk(bytes) {
    this._readInFlight = false;
    if (this.destroyed) return;
    // Node hands streams a Buffer, not a bare Uint8Array.
    this.push(Buffer.from(bytes));
  }

  /// Called on the task's `end` for this stream.
  endStream() {
    this._readInFlight = false;
    if (this.destroyed) return;
    this.push(null);
  }

  _destroy(error, callback) {
    try {
      host.proc(this._id, "readStop", [this._stream]);
    } catch {
      // The child is gone; there is nothing left to stop.
    }
    callback(error);
  }
}

class PipeWritable extends Writable {
  constructor(id, stream) {
    super();
    this._id = id;
    this._stream = stream;
    this._pendingBytes = 0;
    this._waitingCallback = null;
  }

  _write(chunk, encoding, callback) {
    try {
      host.proc(this._id, "write", [this._stream, chunk]);
    } catch (error) {
      callback(error);
      return;
    }
    this._pendingBytes += chunk.length;
    // Node returns `false` at the high-water mark and emits `drain` once the task's queue empties.
    if (this._pendingBytes >= this.writableHighWaterMark) {
      this._waitingCallback = callback;
    } else {
      callback();
    }
  }

  _final(callback) {
    try {
      host.proc(this._id, "end", [this._stream]);
    } catch {
      // A child that already exited has no stdin left to close.
    }
    callback();
  }

  /// Called on the task's `drain` for stdin: the queue is empty, release the pending write.
  onDrain() {
    this._pendingBytes = 0;
    const callback = this._waitingCallback;
    this._waitingCallback = null;
    if (callback !== null) callback();
  }

  _destroy(error, callback) {
    callback(error);
  }
}

/// One stream per `"pipe"` entry in the normalized stdio array; `null` for ignore/inherit/fd.
function createStreams(id, stdio) {
  const stdin = stdio[0] === "pipe" ? new PipeWritable(id, "stdin") : null;
  const stdout = stdio[1] === "pipe" ? new PipeReadable(id, "stdout") : null;
  const stderr = stdio[2] === "pipe" ? new PipeReadable(id, "stderr") : null;
  return { stdin, stdout, stderr };
}

module.exports = { PipeReadable, PipeWritable, createStreams, MAX_CHUNK };
