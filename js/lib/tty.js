"use strict";

// `tty` — terminal detection and the streams behind `process.stdin`/`stdout`/`stderr`.
//
// Lite has no libuv handle layer, so there is no `uv_tty_t`: a "TTY stream" is a normal
// `Readable`/`Writable` over a host fd, with the terminal facts (`isTTY`, `columns`, `rows`)
// read synchronously from the host. The only operations are:
//
//   host.isTTY(fd)            -> boolean
//   host.columns(fd)          -> number  (0 when unknown)
//   host.writeFd(fd, bytes)   -> number  (synchronous, whole-buffer write)
//   __ln_op("read", [fd, len, -1])       async read, resolved with a Uint8Array (empty at EOF)
//
// Deliberate gaps (documented in docs/compat.md and the WP6 report):
//
//   * `columns`/`rows` come from `COLUMNS`/`LINES` when exported and otherwise fall back to the
//     conventional 80x24; there is no ioctl, so a resized terminal is not reflected.
//   * `getColorDepth`/`hasColors` are the TERM/COLORTERM heuristic, not a terminfo lookup.
//   * `setRawMode` only flips a flag; byte-at-a-time input is already what `__ln_op("read")`
//     returns, so the flag is informational.
//   * `tty.ReadStream` does not throw ERR_TTY_INIT_FAILED on a non-TTY fd; it behaves like a
//     regular fd reader with `isTTY === false`. Node's constructor needs a libuv TTY handle
//     that we do not have, and the stream is still useful (process stdin on a pipe).

const { Readable, Writable } = require("stream");

const kMinFd = 0;
const kMaxFd = 255; // the host boundary types the fd as u8
const kDefaultReadSize = 64 * 1024;

function hostObject() {
  const host = globalThis.__ln_host;
  return host !== undefined && host !== null && typeof host === "object" ? host : null;
}

function invalidFd(fd) {
  let received;
  try {
    received = typeof fd === "string" ? `'${fd}'` : String(fd);
  } catch (_) {
    received = "<unprintable>";
  }
  const error = new RangeError(
    `The argument 'fd' must be a non-negative integer. Received ${received}`,
  );
  error.code = "ERR_INVALID_FD";
  return error;
}

function fdValue(fd) {
  if (
    typeof fd !== "number" ||
    !Number.isInteger(fd) ||
    fd < kMinFd ||
    fd > kMaxFd
  ) {
    throw invalidFd(fd);
  }
  return fd;
}

// The host route only knows about the three standard descriptors; `isatty(99)` must be false
// even though `host.isTTY` folds every other fd into the stderr check.
function hostTTY(fd) {
  if (fd !== 0 && fd !== 1 && fd !== 2) return false;
  const host = hostObject();
  if (host === null || typeof host.isTTY !== "function") return false;
  try {
    return host.isTTY(fd) === true;
  } catch (_) {
    return false;
  }
}

function hostColumns(fd) {
  if (fd !== 0 && fd !== 1 && fd !== 2) return undefined;
  const host = hostObject();
  if (host === null || typeof host.columns !== "function") return undefined;
  let columns = 0;
  try {
    columns = host.columns(fd);
  } catch (_) {
    columns = 0;
  }
  if (typeof columns === "number" && columns > 0) return columns;
  // `COLUMNS` is rarely exported to child processes, and there is no ioctl path; report the
  // conventional 80 for a TTY rather than `undefined` so callers that size output keep working.
  return hostTTY(fd) ? 80 : undefined;
}

function hostRows(isTTY) {
  // `LINES` is the portable stand-in for a window-size ioctl.
  const proc = globalThis.process;
  const env = proc && proc.env;
  if (env !== undefined && env !== null) {
    const rows = Number(env.LINES);
    if (Number.isInteger(rows) && rows > 0) return rows;
  }
  return isTTY ? 24 : undefined;
}

function isatty(fd) {
  // Node returns false for anything that is not an open standard descriptor; it never throws.
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0 || fd > kMaxFd) return false;
  return hostTTY(fd);
}

function toBytes(chunk, encoding) {
  if (typeof chunk !== "string") return chunk;
  const BufferCtor = globalThis.Buffer;
  if (typeof BufferCtor === "function") return BufferCtor.from(chunk, encoding || "utf8");
  const Encoder = globalThis.TextEncoder;
  if (typeof Encoder === "function") return new Encoder().encode(chunk);
  const error = new TypeError("The chunk must be a string, Buffer or Uint8Array");
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

function writeChunk(stream, chunk, encoding, callback) {
  const host = hostObject();
  if (host === null || typeof host.writeFd !== "function") {
    callback(new Error("onde: host.writeFd is unavailable"));
    return;
  }
  let written;
  try {
    written = host.writeFd(stream.fd, toBytes(chunk, encoding));
  } catch (error) {
    callback(error);
    return;
  }
  if (typeof written === "number") stream.bytesWritten += written;
  callback();
}

// Reads one chunk for an fd-backed Readable. The stream's `_read` contract means at most one
// request is in flight: `Readable.push()` clears the "reading" flag before the next `_read`.
function readChunk(stream, size) {
  const op = globalThis.__ln_op;
  if (typeof op !== "function") {
    stream.destroy(new Error("onde: async I/O (__ln_op) is unavailable"));
    return;
  }
  const length =
    typeof size === "number" && size > 0
      ? Math.min(Math.floor(size), 1024 * 1024)
      : kDefaultReadSize;
  let pending;
  try {
    pending = op("read", [stream.fd, length, -1]);
  } catch (error) {
    stream.destroy(error);
    return;
  }
  pending.then(
    (chunk) => {
      if (stream.destroyed) return;
      if (chunk === undefined || chunk === null || chunk.length === 0) {
        stream.push(null);
        return;
      }
      stream.push(chunk);
      // See the matching note in js/lib/process.js: the current stream.js fast path emits
      // `data` without requesting the next chunk from a flowing stream.
      if (!stream.destroyed && stream.readableFlowing === true) stream.read(0);
    },
    (error) => {
      if (!stream.destroyed) stream.destroy(error);
    },
  );
}

function colorDepthFromEnv(env) {
  let environment = env;
  if (environment === undefined || environment === null) {
    const proc = globalThis.process;
    environment = proc && proc.env ? proc.env : {};
  }
  if (environment.NO_COLOR !== undefined && environment.NO_COLOR !== "") return 1;
  const term = String(environment.TERM === undefined ? "" : environment.TERM);
  const colorterm = String(environment.COLORTERM === undefined ? "" : environment.COLORTERM);
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (term === "" || term === "dumb") return 1;
  if (term.includes("256color") || term.includes("truecolor")) return 8;
  if (/color|ansi|xterm|screen|vt100|linux|cygwin/.test(term)) return 4;
  return 1;
}

// Number of colors implied by a `getColorDepth()` value (1, 4, 8 or 24 bits per channel).
function colorsForDepth(depth) {
  if (depth >= 24) return 16777216;
  if (depth >= 8) return 256;
  if (depth >= 4) return 16;
  return 2;
}

class WriteStream extends Writable {
  constructor(fd) {
    const target = fdValue(fd);
    super();
    this.fd = target;
    this.isTTY = hostTTY(target);
    this.bytesWritten = 0;
    this._isStdio = false;
  }

  get columns() {
    return this.isTTY ? hostColumns(this.fd) : undefined;
  }

  get rows() {
    return this.isTTY ? hostRows() : undefined;
  }

  _write(chunk, encoding, callback) {
    writeChunk(this, chunk, encoding, callback);
  }

  getColorDepth(env) {
    // Node derives this from the environment (TERM/COLORTERM), not from the descriptor being a
    // terminal, so an explicit `env` argument is honoured even on a pipe.
    return colorDepthFromEnv(env);
  }

  hasColors(depthOrCount, env) {
    let requested = 2;
    let environment = env;
    if (depthOrCount !== null && typeof depthOrCount === "object") {
      environment = depthOrCount;
    } else if (depthOrCount !== undefined) {
      requested = Number(depthOrCount);
    }
    if (!Number.isFinite(requested) || requested < 2) requested = 2;
    return colorsForDepth(this.getColorDepth(environment)) >= requested;
  }

  getWindowSize() {
    if (!this.isTTY) return [];
    return [this.columns, this.rows];
  }

  // Cursor helpers are part of the Node WriteStream surface that console/readline users call.
  // They are plain ANSI writes; the TTY itself interprets them.
  cursorTo(x, y, callback) {
    if (typeof y === "function") {
      callback = y;
      y = undefined;
    }
    const column = Math.trunc(Number(x)) + 1;
    if (y === undefined) this.write(`\u001b[${column}G`);
    else this.write(`\u001b[${Math.trunc(Number(y)) + 1};${column}H`);
    if (typeof callback === "function") callback();
    return true;
  }

  moveCursor(dx, dy, callback) {
    const x = Math.trunc(Number(dx));
    const y = Math.trunc(Number(dy));
    let sequence = "";
    if (x !== 0) sequence += `\u001b[${x > 0 ? x : -x}${x > 0 ? "C" : "D"}`;
    if (y !== 0) sequence += `\u001b[${y > 0 ? y : -y}${y > 0 ? "B" : "A"}`;
    if (sequence !== "") this.write(sequence);
    if (typeof callback === "function") callback();
    return true;
  }

  clearLine(dir, callback) {
    const direction = Number(dir);
    const code = direction === 0 ? "2" : direction > 0 ? "0" : "1";
    this.write(`\u001b[${code}K`);
    if (typeof callback === "function") callback();
    return true;
  }

  clearScreenDown(callback) {
    this.write("\u001b[0J");
    if (typeof callback === "function") callback();
    return true;
  }

  _refreshSize() {
    // No handle to refresh; the getters read the host on every access.
  }
}

class ReadStream extends Readable {
  constructor(fd) {
    const target = fdValue(fd);
    super({ highWaterMark: kDefaultReadSize });
    this.fd = target;
    this.isTTY = hostTTY(target);
    this._rawMode = false;
    this._isStdio = false;
  }

  get columns() {
    return this.isTTY ? hostColumns(this.fd) : undefined;
  }

  get rows() {
    return this.isTTY ? hostRows() : undefined;
  }

  get isRaw() {
    return this._rawMode;
  }

  setRawMode(mode) {
    if (!this.isTTY) {
      const error = new Error("setRawMode is only supported on TTY streams");
      error.code = "ERR_TTY_SET_RAW_MODE";
      throw error;
    }
    this._rawMode = Boolean(mode);
    return this;
  }

  _read(size) {
    readChunk(this, size);
  }
}

module.exports = {
  isatty,
  WriteStream,
  ReadStream,
};
