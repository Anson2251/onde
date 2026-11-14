"use strict";

// `internal/fs` — the one JS-side path onto the host filesystem ops.
//
// The Rust side (`crates/ln-runtime/src/ops.rs`) owns every syscall. This module owns everything
// that is JS-shaped:
//
//   * argument validation and normalization (`toPath`, `normalizeFlags`, mode/encoding parsing),
//   * one sync entry point (`sync`) and one async entry point (`callAsync`/`promise`),
//   * the classes the public surfaces re-export: `Stats`, `Dirent`, `Dir`, `FileHandle`,
//   * the fs streams, because `fs.FileHandle.createReadStream` and `fs.createReadStream` must be
//     the same stream implementation.
//
// Error delivery follows `docs/m3-plan.md` §5: the sync form throws, the callback form throws on
// invalid arguments but hands syscall failures to the callback (which `__ln_op_done` invokes from
// the completion dispatch), and the promise form rejects. Host errors are normalized here (the
// host reports a positive `errno`; Node's is negative on POSIX) so every surface sees the Node
// shape.
//
// Deliberate gaps, recorded in the WP5 report: `options.bigint` stats, `Buffer` paths are decoded
// as UTF-8 (D37), and fd numbers are not accepted where Node accepts them (readFile(fd), ...).

const host = globalThis.__ln_host;

// --- module dependencies ---------------------------------------------------------------------

// Embedded builds resolve these as builtins; a checkout run (`lite test/js/lib/fs.test.js`)
// loads the sibling files. Both paths are exercised by the WP5 tests.
let BufferCtor = null;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("../buffer.js");
}
const Buffer = BufferCtor;

let fileURLToPath = null;
try {
  fileURLToPath = require("url").fileURLToPath;
} catch (_) {
  fileURLToPath = require("../url.js").fileURLToPath;
}

let EventEmitterCtor = null;
try {
  EventEmitterCtor = require("events");
} catch (_) {
  EventEmitterCtor = require("../events.js");
}
const EventEmitter = EventEmitterCtor;

// The fs streams are `stream.Readable`/`stream.Writable` subclasses. `stream` never requires
// `fs`, so loading it here cannot create a cycle.
let streamModule = null;
try {
  streamModule = require("stream");
} catch (_) {
  streamModule = require("../stream.js");
}
const { Readable, Writable, addAbortSignal } = streamModule;

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

// Resolve an internal module name without the embedded/on-disk ambiguity: `./internal/fs` from
// `<lite:fs>` would resolve back to `fs` itself through the loader's base-name fallback.
function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

// --- host bridge -----------------------------------------------------------------------------

function hostSync(name, args) {
  return host.fsSync(name, args);
}

function hostAsync(name, args, options) {
  const op = globalThis.__ln_op;
  if (typeof op !== "function") {
    const error = new Error("lite-node: the async op bridge (__ln_op) is not installed");
    error.code = "ERR_IO_BRIDGE";
    throw error;
  }
  return op(name, args, options);
}

// --- error helpers ---------------------------------------------------------------------------

function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value} (${String(value)})`;
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `function ${value.name || "anonymous"}`;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return typeof value;
  }
}

function codedError(Ctor, code, message) {
  const error = new Ctor(message);
  error.code = code;
  return error;
}

function invalidArgType(name, expected, actual) {
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be of type ${expected}. Received ${describe(actual)}`,
  );
}

function invalidArgValue(name, value, reason) {
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' ${reason}. Received ${describe(value)}`,
  );
}

function outOfRange(name, range, value) {
  return codedError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
  );
}

// A syscall failure the JS layer detects itself (a closed FileHandle, a double `fs.close`). The
// host produces these for real syscalls; this keeps the shape identical.
function systemError(code, syscall, path) {
  const error = new Error(
    path === undefined
      ? `${code}: ${errnoMessage(code)}, ${syscall}`
      : `${code}: ${errnoMessage(code)}, ${syscall} '${String(path)}'`,
  );
  error.code = code;
  error.errno = -errnoNumber(code);
  error.syscall = syscall;
  if (path !== undefined) error.path = String(path);
  return error;
}

const ERRNO_NUMBERS = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EAGAIN: 11,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EMFILE: 24,
  ENOSPC: 28,
  EROFS: 30,
  ENOTEMPTY: 66,
  ELOOP: 62,
  ENAMETOOLONG: 63,
  ENOSYS: 78,
};

const ERRNO_MESSAGES = {
  EPERM: "operation not permitted",
  ENOENT: "no such file or directory",
  EIO: "i/o error",
  EBADF: "bad file descriptor",
  EAGAIN: "resource temporarily unavailable",
  EACCES: "permission denied",
  EBUSY: "resource busy or locked",
  EEXIST: "file already exists",
  EXDEV: "cross-device link not permitted",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EINVAL: "invalid argument",
  EMFILE: "too many open files",
  ENOSPC: "no space left on device",
  EROFS: "read-only file system",
  ENOTEMPTY: "directory not empty",
  ELOOP: "too many symbolic links encountered",
  ENAMETOOLONG: "name too long",
  ENOSYS: "function not implemented",
};

function errnoNumber(code) {
  const value = ERRNO_NUMBERS[code];
  return value === undefined ? 0 : value;
}

function errnoMessage(code) {
  const value = ERRNO_MESSAGES[code];
  return value === undefined ? "unknown error" : value;
}

// Host errnos are the raw positive values. Node reports the negative form on POSIX, and that is
// part of the error shape callers test (`err.errno === -2`).
function normalizeError(error) {
  if (error !== null && typeof error === "object") {
    if (typeof error.errno === "number" && error.errno > 0) error.errno = -error.errno;
  }
  return error;
}

// Two-path syscalls carry `dest` in Node. The host message already names both paths; fill in the
// property so `error.dest` works.
function withDest(error, dest) {
  if (error !== null && typeof error === "object" && error.path !== undefined) {
    if (error.dest === undefined) error.dest = String(dest);
  }
  return error;
}

function abortSignalOf(options) {
  if (options === undefined || options === null) return undefined;
  const signal = options.signal;
  if (signal === undefined || signal === null) return undefined;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function") {
    throw invalidArgType("options.signal", "AbortSignal", signal);
  }
  return signal;
}

// --- constants -------------------------------------------------------------------------------

// The values Node's `fs.constants` exposes on this platform. libuv derives them from the C
// headers; JS cannot, so the two unix tables are spelled out. `O_CLOEXEC` is not part of Node's
// object and `UV_FS_O_FILEMAP` is deliberately absent (D37).
const DARWIN_O = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 512,
  O_EXCL: 2048,
  O_NOCTTY: 131072,
  O_TRUNC: 1024,
  O_APPEND: 8,
  O_DIRECTORY: 1048576,
  O_NOFOLLOW: 256,
  O_SYNC: 128,
  O_DSYNC: 4194304,
  O_SYMLINK: 2097152,
  O_NONBLOCK: 4,
};

const LINUX_O = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_NOCTTY: 256,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_DIRECTORY: 65536,
  O_NOFOLLOW: 131072,
  O_SYNC: 1052672,
  O_DSYNC: 4096,
  O_NONBLOCK: 2048,
};

function platformName() {
  if (typeof process !== "undefined" && process !== null && typeof process.platform === "string") {
    return process.platform;
  }
  return "linux";
}

const OPEN_FLAGS = platformName() === "darwin" ? DARWIN_O : LINUX_O;

const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFBLK = 0o060000;
const S_IFDIR = 0o040000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;

const constants = {
  UV_FS_SYMLINK_DIR: 1,
  UV_FS_SYMLINK_JUNCTION: 2,

  O_RDONLY: OPEN_FLAGS.O_RDONLY,
  O_WRONLY: OPEN_FLAGS.O_WRONLY,
  O_RDWR: OPEN_FLAGS.O_RDWR,
  O_CREAT: OPEN_FLAGS.O_CREAT,
  O_EXCL: OPEN_FLAGS.O_EXCL,
  O_NOCTTY: OPEN_FLAGS.O_NOCTTY,
  O_TRUNC: OPEN_FLAGS.O_TRUNC,
  O_APPEND: OPEN_FLAGS.O_APPEND,
  O_DIRECTORY: OPEN_FLAGS.O_DIRECTORY,
  O_NOFOLLOW: OPEN_FLAGS.O_NOFOLLOW,
  O_SYNC: OPEN_FLAGS.O_SYNC,
  O_DSYNC: OPEN_FLAGS.O_DSYNC,
  O_NONBLOCK: OPEN_FLAGS.O_NONBLOCK,

  // `UV_FS_O_FILEMAP` is Windows-only and deliberately absent (D37).
  UV_FS_O_TEMPORARY: 0,
  UV_FS_O_SHORT_LIVED: 0,
  UV_FS_O_SEQUENTIAL: 0,
  UV_FS_O_RANDOM: 0,

  UV_DIRENT_UNKNOWN: 0,
  UV_DIRENT_FILE: 1,
  UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4,
  UV_DIRENT_SOCKET: 5,
  UV_DIRENT_CHAR: 6,
  UV_DIRENT_BLOCK: 7,

  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFCHR,
  S_IFBLK,
  S_IFIFO,
  S_IFLNK,
  S_IFSOCK,

  S_IRWXU: 0o700,
  S_IRUSR: 0o400,
  S_IWUSR: 0o200,
  S_IXUSR: 0o100,
  S_IRWXG: 0o070,
  S_IRGRP: 0o040,
  S_IWGRP: 0o020,
  S_IXGRP: 0o010,
  S_IRWXO: 0o007,
  S_IROTH: 0o004,
  S_IWOTH: 0o002,
  S_IXOTH: 0o001,

  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,

  UV_FS_COPYFILE_EXCL: 1,
  COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4,
  COPYFILE_FICLONE_FORCE: 4,
};

if (OPEN_FLAGS.O_SYMLINK !== undefined) constants.O_SYMLINK = OPEN_FLAGS.O_SYMLINK;

// --- paths, flags, modes, encodings ----------------------------------------------------------

function isURL(value) {
  if (value === null || typeof value !== "object") return false;
  if (typeof URL === "function" && value instanceof URL) return true;
  return typeof value.href === "string" && typeof value.protocol === "string";
}

function toPath(value, name) {
  const label = name === undefined ? "path" : name;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  if (isURL(value)) return fileURLToPath(value);
  throw invalidArgType(label, "string or an instance of Buffer or URL", value);
}

const FLAG_STRINGS = new Map([
  ["r", [OPEN_FLAGS.O_RDONLY]],
  ["rs", [OPEN_FLAGS.O_RDONLY, OPEN_FLAGS.O_SYNC]],
  ["sr", [OPEN_FLAGS.O_RDONLY, OPEN_FLAGS.O_SYNC]],
  ["r+", [OPEN_FLAGS.O_RDWR]],
  ["rs+", [OPEN_FLAGS.O_RDWR, OPEN_FLAGS.O_SYNC]],
  ["sr+", [OPEN_FLAGS.O_RDWR, OPEN_FLAGS.O_SYNC]],
  ["w", [OPEN_FLAGS.O_TRUNC, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY]],
  ["wx", [OPEN_FLAGS.O_TRUNC, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY, OPEN_FLAGS.O_EXCL]],
  ["xw", [OPEN_FLAGS.O_TRUNC, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY, OPEN_FLAGS.O_EXCL]],
  ["w+", [OPEN_FLAGS.O_TRUNC, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_RDWR]],
  ["wx+", [
    OPEN_FLAGS.O_TRUNC,
    OPEN_FLAGS.O_CREAT,
    OPEN_FLAGS.O_RDWR,
    OPEN_FLAGS.O_EXCL,
  ]],
  ["xw+", [
    OPEN_FLAGS.O_TRUNC,
    OPEN_FLAGS.O_CREAT,
    OPEN_FLAGS.O_RDWR,
    OPEN_FLAGS.O_EXCL,
  ]],
  ["a", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY]],
  ["ax", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY, OPEN_FLAGS.O_EXCL]],
  ["xa", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY, OPEN_FLAGS.O_EXCL]],
  ["a+", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_RDWR]],
  ["ax+", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_RDWR, OPEN_FLAGS.O_EXCL]],
  ["xa+", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_RDWR, OPEN_FLAGS.O_EXCL]],
  ["as", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY, OPEN_FLAGS.O_SYNC]],
  ["sa", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_WRONLY, OPEN_FLAGS.O_SYNC]],
  ["as+", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_RDWR, OPEN_FLAGS.O_SYNC]],
  ["sa+", [OPEN_FLAGS.O_APPEND, OPEN_FLAGS.O_CREAT, OPEN_FLAGS.O_RDWR, OPEN_FLAGS.O_SYNC]],
]);

function normalizeFlags(flags, name) {
  const label = name === undefined ? "flags" : name;
  if (flags === undefined || flags === null) return OPEN_FLAGS.O_RDONLY;
  if (typeof flags === "number") {
    if (!Number.isInteger(flags) || flags < -2147483648 || flags > 2147483647) {
      throw outOfRange(label, "a 32-bit signed integer", flags);
    }
    return flags;
  }
  if (typeof flags === "string") {
    const parts = FLAG_STRINGS.get(flags);
    if (parts === undefined) throw invalidArgValue(label, flags, "is invalid");
    let value = 0;
    for (let index = 0; index < parts.length; index++) value |= parts[index];
    return value;
  }
  throw invalidArgType(label, "string or number", flags);
}

// `parseFileMode` accepts a number or an octal string and keeps the full uint32 range: Node lets
// the syscall reject setuid bits, it does not reject them in JS.
function parseFileMode(value, name, defaultMode) {
  const label = name === undefined ? "mode" : name;
  if (value === undefined || value === null) return defaultMode;
  let mode = value;
  if (typeof mode === "string") {
    mode = parseInt(mode, 8);
    if (Number.isNaN(mode)) {
      throw invalidArgValue(
        label,
        value,
        "must be a 32-bit unsigned integer or an octal string",
      );
    }
  }
  if (typeof mode !== "number" || !Number.isInteger(mode)) {
    throw invalidArgType(label, "integer", value);
  }
  if (mode < 0 || mode > 4294967295) {
    throw outOfRange(label, ">= 0 && <= 4294967295", value);
  }
  return mode >>> 0;
}

function validateInteger(value, name, min, max) {
  if (typeof value !== "number") throw invalidArgType(name, "number", value);
  if (!Number.isInteger(value)) throw invalidArgType(name, "integer", value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  return value;
}

function normalizeEncoding(encoding) {
  if (encoding === undefined || encoding === null) return "utf8";
  if (typeof encoding !== "string") throw invalidArgType("encoding", "string", encoding);
  if (!Buffer.isEncoding(encoding)) {
    throw invalidArgValue("encoding", encoding, "is invalid encoding");
  }
  return encoding;
}

function encodingOrNull(encoding) {
  if (encoding === undefined || encoding === null) return null;
  return normalizeEncoding(encoding);
}

function decodeBytes(bytes, encoding) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (encoding === null || encoding === undefined) return buffer;
  return buffer.toString(encoding);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function asUint8Array(value, name) {
  const bytes = toBytes(value);
  if (bytes === null) throw invalidArgType(name, "Buffer, TypedArray, or DataView", value);
  return bytes;
}

function validatePosition(position, name) {
  const label = name === undefined ? "position" : name;
  if (position === undefined || position === null) return -1;
  if (typeof position !== "number" || !Number.isInteger(position)) {
    throw invalidArgType(label, "integer", position);
  }
  if (position < -1) throw outOfRange(label, ">= -1", position);
  return position;
}

// `offset`/`length` into a caller buffer: both must be integers and the window must fit.
function validateOffsetLength(buffer, offset, length) {
  const size = buffer.byteLength;
  const windowOffset = offset === undefined ? 0 : validateInteger(offset, "offset", 0, size);
  const windowLength =
    length === undefined
      ? size - windowOffset
      : validateInteger(length, "length", 0, size - windowOffset);
  return { offset: windowOffset, length: windowLength };
}

function copyInto(bytes, target, offset) {
  const count = Math.min(bytes.length, target.length - offset);
  if (count > 0) target.set(bytes.subarray(0, count), offset);
  return count;
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// --- option objects --------------------------------------------------------------------------

function getOptions(options, defaultOptions) {
  if (options === undefined || options === null) return Object.assign({}, defaultOptions);
  if (typeof options === "string") return Object.assign({}, defaultOptions, { encoding: options });
  if (typeof options !== "object") {
    throw invalidArgType("options", "object", options);
  }
  return options;
}

// --- Stats / Dirent / Dir --------------------------------------------------------------------

class Stats {
  constructor(
    dev,
    mode,
    nlink,
    uid,
    gid,
    rdev,
    blksize,
    ino,
    size,
    blocks,
    atimeMs,
    mtimeMs,
    ctimeMs,
    birthtimeMs,
  ) {
    this.dev = dev;
    this.mode = mode;
    this.nlink = nlink;
    this.uid = uid;
    this.gid = gid;
    this.rdev = rdev;
    this.blksize = blksize;
    this.ino = ino;
    this.size = size;
    this.blocks = blocks;
    this.atimeMs = atimeMs;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.birthtimeMs = birthtimeMs;
  }

  get atime() {
    return new Date(this.atimeMs);
  }

  get mtime() {
    return new Date(this.mtimeMs);
  }

  get ctime() {
    return new Date(this.ctimeMs);
  }

  get birthtime() {
    return new Date(this.birthtimeMs);
  }

  _checkModeProperty(property) {
    return (this.mode & S_IFMT) === property;
  }

  isDirectory() {
    return this._checkModeProperty(S_IFDIR);
  }

  isFile() {
    return this._checkModeProperty(S_IFREG);
  }

  isBlockDevice() {
    return this._checkModeProperty(S_IFBLK);
  }

  isCharacterDevice() {
    return this._checkModeProperty(S_IFCHR);
  }

  isSymbolicLink() {
    return this._checkModeProperty(S_IFLNK);
  }

  isFIFO() {
    return this._checkModeProperty(S_IFIFO);
  }

  isSocket() {
    return this._checkModeProperty(S_IFSOCK);
  }
}

function makeStatsFs(value, bigint) {
  return new StatsFs(value, bigint === true);
}

function makeStats(value) {
  return new Stats(
    value.dev,
    value.mode,
    value.nlink,
    value.uid,
    value.gid,
    value.rdev,
    value.blksize,
    value.ino,
    value.size,
    value.blocks,
    value.atimeMs,
    value.mtimeMs,
    value.ctimeMs,
    value.birthtimeMs,
  );
}

class StatsFs {
  constructor(value, bigint) {
    const convert = bigint ? (number) => BigInt(number) : (number) => number;
    this.type = convert(value.type);
    this.bsize = convert(value.bsize);
    this.frsize = convert(value.frsize);
    this.blocks = convert(value.blocks);
    this.bfree = convert(value.bfree);
    this.bavail = convert(value.bavail);
    this.files = convert(value.files);
    this.ffree = convert(value.ffree);
  }
}

const kDirentType = Symbol("lite.fs.direntType");

class Dirent {
  constructor(name, type, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    Object.defineProperty(this, kDirentType, {
      value: type,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  isDirectory() {
    return this[kDirentType] === constants.UV_DIRENT_DIR;
  }

  isFile() {
    return this[kDirentType] === constants.UV_DIRENT_FILE;
  }

  isBlockDevice() {
    return this[kDirentType] === constants.UV_DIRENT_BLOCK;
  }

  isCharacterDevice() {
    return this[kDirentType] === constants.UV_DIRENT_CHAR;
  }

  isSymbolicLink() {
    return this[kDirentType] === constants.UV_DIRENT_LINK;
  }

  isFIFO() {
    return this[kDirentType] === constants.UV_DIRENT_FIFO;
  }

  isSocket() {
    return this[kDirentType] === constants.UV_DIRENT_SOCKET;
  }
}

function makeDirent(entry, parentPath) {
  return new Dirent(entry.name, entry.kind, parentPath);
}

const kDirPath = Symbol("lite.fs.dirPath");
const kDirEntries = Symbol("lite.fs.dirEntries");
const kDirIndex = Symbol("lite.fs.dirIndex");
const kDirClosed = Symbol("lite.fs.dirClosed");

function dirIterator(dir) {
  return {
    next() {
      return dir.read();
    },
    return() {
      return dir.close().then(() => ({ value: undefined, done: true }));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

class Dir {
  constructor(path, entries) {
    Object.defineProperty(this, kDirPath, { value: path, enumerable: false });
    Object.defineProperty(this, kDirEntries, { value: entries, enumerable: false });
    Object.defineProperty(this, kDirIndex, { value: 0, writable: true, enumerable: false });
    Object.defineProperty(this, kDirClosed, { value: false, writable: true, enumerable: false });
  }

  get path() {
    return this[kDirPath];
  }

  read() {
    return new Promise((resolve, reject) => {
      try {
        resolve(this.readSync());
      } catch (error) {
        reject(error);
      }
    });
  }

  readSync() {
    if (this[kDirClosed]) {
      throw codedError(Error, "ERR_DIR_CLOSED", "Directory handle was closed");
    }
    const entries = this[kDirEntries];
    const index = this[kDirIndex];
    if (index >= entries.length) return null;
    this[kDirIndex] = index + 1;
    return entries[index];
  }

  close() {
    this.closeSync();
    return Promise.resolve();
  }

  closeSync() {
    this[kDirClosed] = true;
  }

  entries() {
    return dirIterator(this);
  }

  [Symbol.asyncIterator]() {
    return dirIterator(this);
  }
}

// --- fd bookkeeping --------------------------------------------------------------------------

// Node exposes real OS descriptors. A plain double `close` would close whatever descriptor the
// OS handed out next, so the JS layer remembers which descriptors it opened and which it retired.
const openFds = new Set();
const retiredFds = new Set();

function trackOpen(fd) {
  retiredFds.delete(fd);
  openFds.add(fd);
}

function trackClose(fd) {
  openFds.delete(fd);
  retiredFds.add(fd);
}

function forgetFd(fd) {
  openFds.delete(fd);
  retiredFds.delete(fd);
}

// Returns an EBADF error for a descriptor this layer already closed, or null.
function closedFdError(fd, syscall) {
  if (retiredFds.has(fd) && !openFds.has(fd)) return systemError("EBADF", syscall);
  return null;
}

// --- byte-level helpers ----------------------------------------------------------------------

const READ_CHUNK = 64 * 1024;
const MAX_READ_LENGTH = 2147483647;

function readAllFromFd(fd, position, signal) {
  const chunks = [];
  let total = 0;
  function step() {
    return promise("read", [fd, READ_CHUNK, position], signal).then((bytes) => {
      if (bytes.length === 0) return concatBytes(chunks, total);
      chunks.push(bytes);
      total += bytes.length;
      if (position !== -1) position += bytes.length;
      return step();
    });
  }
  return step();
}

// Writes every byte of `data` at `position` (-1 follows the descriptor's own offset).
function writeAllToFd(fd, data, position, signal) {
  let offset = 0;
  function step() {
    if (offset >= data.length) return Promise.resolve(offset);
    const slice = data.subarray(offset);
    return promise("write", [fd, slice, position], signal).then((written) => {
      if (written <= 0) {
        throw systemError("EIO", "write");
      }
      offset += written;
      if (position !== -1) position += written;
      return step();
    });
  }
  return step();
}

function consumeAsyncIterable(data, encoding) {
  const iterator = data[Symbol.asyncIterator];
  if (typeof iterator !== "function") return null;
  const chunks = [];
  let total = 0;
  const iter = iterator.call(data);
  function step() {
    return iter.next().then((result) => {
      if (result.done) return concatBytes(chunks, total);
      const chunk = result.value;
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding === null ? "utf8" : encoding)
          : toBytes(chunk);
      if (bytes === null) {
        throw invalidArgType(
          "data",
          "string or an instance of Buffer, TypedArray, or DataView",
          chunk,
        );
      }
      chunks.push(bytes);
      total += bytes.length;
      return step();
    });
  }
  return step();
}

function dataToBytes(data, encoding, allowIterable) {
  if (typeof data === "string") return Buffer.from(data, encoding === null ? "utf8" : encoding);
  const bytes = toBytes(data);
  if (bytes !== null) return bytes;
  if (allowIterable && data !== null && typeof data === "object") {
    const collected = consumeAsyncIterable(data, encoding);
    if (collected !== null) return collected;
  }
  throw invalidArgType(
    "data",
    "string or an instance of Buffer, TypedArray, or DataView",
    data,
  );
}

// --- the single call path --------------------------------------------------------------------

function sync(name, args) {
  try {
    return hostSync(name, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

function callAsync(name, args, options) {
  const settings = options === undefined || options === null ? {} : options;
  const outgoing = {};
  const callback = settings.callback;
  if (callback !== undefined) {
    outgoing.callback = (error, value) => {
      callback(error === null || error === undefined ? error : normalizeError(error), value);
    };
  }
  if (settings.signal !== undefined) outgoing.signal = settings.signal;
  return hostAsync(name, args, outgoing);
}

// Promise form. A rejected promise is returned (never a synchronous throw) so the public
// `fs/promises` functions reject like Node's async functions do.
function promise(name, args, signal) {
  let result;
  try {
    result = hostAsync(name, args, signal === undefined ? undefined : { signal });
  } catch (error) {
    return Promise.reject(normalizeError(error));
  }
  return result.then(undefined, (error) => {
    throw normalizeError(error);
  });
}

// --- FileHandle ------------------------------------------------------------------------------

const kFd = Symbol("lite.fs.fd");
const kFhClosed = Symbol("lite.fs.closed");
const kFhPath = Symbol("lite.fs.path");

class FileHandle extends EventEmitter {
  constructor(fd, path) {
    super();
    Object.defineProperty(this, kFd, { value: fd, writable: true, enumerable: false });
    Object.defineProperty(this, kFhClosed, { value: false, writable: true, enumerable: false });
    Object.defineProperty(this, kFhPath, { value: path, writable: true, enumerable: false });
  }

  get fd() {
    return this[kFhClosed] ? -1 : this[kFd];
  }

  _checkOpen(syscall) {
    if (this[kFhClosed]) throw systemError("EBADF", syscall);
    return this[kFd];
  }

  // Called by a stream this handle created when `autoClose` closes the shared descriptor.
  _markClosed() {
    this[kFhClosed] = true;
  }

  async close() {
    if (this[kFhClosed]) return;
    this[kFhClosed] = true;
    const fd = this[kFd];
    trackClose(fd);
    await promise("close", [fd]);
  }

  getAsyncId() {
    // D37: `async_hooks` does not exist until M6.
    throw codedError(
      Error,
      "ERR_METHOD_NOT_IMPLEMENTED",
      "FileHandle.getAsyncId() is not supported until lite-node M6",
    );
  }

  async appendFile(data, options) {
    const fd = this._checkOpen("write");
    const opts = getOptions(options, {});
    const encoding = encodingOrNull(opts.encoding);
    const bytes = await dataToBytes(data, encoding, true);
    await writeAllToFd(fd, bytes, -1);
  }

  async chmod(mode) {
    const fd = this._checkOpen("fchmod");
    if (mode === undefined || mode === null) throw invalidArgType("mode", "integer", mode);
    await promise("fchmod", [fd, parseFileMode(mode, "mode", 0o666)]);
  }

  async chown(uid, gid) {
    const fd = this._checkOpen("fchown");
    await promise("fchown", [
      fd,
      validateInteger(uid, "uid", 0, 4294967295),
      validateInteger(gid, "gid", 0, 4294967295),
    ]);
  }

  async datasync() {
    const fd = this._checkOpen("fdatasync");
    await promise("fdatasync", [fd]);
  }

  async sync() {
    const fd = this._checkOpen("fsync");
    await promise("fsync", [fd]);
  }

  async read(bufferOrOptions, offset, length, position) {
    const fd = this._checkOpen("read");
    const parsed = parseFhReadArgs(bufferOrOptions, offset, length, position);
    const bytes = await promise("read", [fd, parsed.length, parsed.position]);
    const count = copyInto(bytes, parsed.buffer, parsed.offset);
    return { bytesRead: count, buffer: parsed.buffer };
  }

  async readv(buffers, position) {
    const fd = this._checkOpen("read");
    const list = validateBuffers(buffers);
    const pos = validatePosition(position);
    let total = 0;
    for (let index = 0; index < list.length; index++) total += list[index].length;
    if (total === 0) return { bytesRead: 0, buffers: list };
    const bytes = await promise("read", [fd, total, pos]);
    let read = 0;
    for (let index = 0; index < list.length && read < bytes.length; index++) {
      read += copyInto(bytes.subarray(read), list[index], 0);
    }
    return { bytesRead: read, buffers: list };
  }

  async readFile(options) {
    const fd = this._checkOpen("readFile");
    const opts = getOptions(options, {});
    const encoding = encodingOrNull(opts.encoding);
    const bytes = await readAllFromFd(fd, -1);
    return decodeBytes(bytes, encoding);
  }

  async stat(options) {
    const fd = this._checkOpen("fstat");
    if (options !== undefined && options !== null && options.bigint === true) {
      throw invalidArgValue("options.bigint", true, "is not supported by lite-node M3");
    }
    return makeStats(await promise("fstat", [fd]));
  }

  async truncate(len) {
    const fd = this._checkOpen("ftruncate");
    await promise("ftruncate", [fd, validateInteger(len, "len", 0, Number.MAX_SAFE_INTEGER)]);
  }

  async utimes(atime, mtime) {
    const fd = this._checkOpen("futimes");
    await promise("futimes", [fd, toUnixTimestamp(atime), toUnixTimestamp(mtime)]);
  }

  async write(data, offsetOrOptionsOrPosition, lengthOrEncoding, position) {
    const fd = this._checkOpen("write");
    if (typeof data === "string") {
      const enc = typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
      const pos = validatePosition(
        offsetOrOptionsOrPosition === undefined || typeof offsetOrOptionsOrPosition === "object"
          ? undefined
          : offsetOrOptionsOrPosition,
      );
      const bytes = Buffer.from(data, normalizeEncoding(enc));
      const written = await promise("write", [fd, bytes, pos]);
      return { bytesWritten: written, buffer: data };
    }
    const parsed = parseWriteArgs(
      data,
      offsetOrOptionsOrPosition,
      typeof lengthOrEncoding === "string" ? undefined : lengthOrEncoding,
      position,
    );
    const bytes = asUint8Array(parsed.data, "buffer").subarray(
      parsed.offset,
      parsed.offset + parsed.length,
    );
    const written = await promise("write", [fd, bytes, parsed.position]);
    return { bytesWritten: written, buffer: parsed.data };
  }

  async writev(buffers, position) {
    const fd = this._checkOpen("write");
    const list = validateBuffers(buffers);
    let total = 0;
    for (let index = 0; index < list.length; index++) total += list[index].length;
    if (total === 0) return { bytesWritten: 0, buffers: list };
    const combined = concatBytes(list, total);
    const written = await promise("write", [fd, combined, validatePosition(position)]);
    return { bytesWritten: written, buffers: list };
  }

  async writeFile(data, options) {
    const fd = this._checkOpen("write");
    const opts = getOptions(options, {});
    const encoding = encodingOrNull(opts.encoding);
    const bytes = await dataToBytes(data, encoding, true);
    await writeAllToFd(fd, bytes, -1);
    if (opts.flush === true) await promise("fsync", [fd]);
  }

  createReadStream(options) {
    const fd = this._checkOpen("read");
    const opts = options === undefined || options === null ? {} : options;
    return new ReadStream(
      undefined,
      Object.assign({}, opts, { fd, handle: this, autoClose: opts.autoClose !== false }),
    );
  }

  createWriteStream(options) {
    const fd = this._checkOpen("write");
    const opts = options === undefined || options === null ? {} : options;
    return new WriteStream(
      undefined,
      Object.assign({}, opts, { fd, handle: this, autoClose: opts.autoClose !== false }),
    );
  }
}

function parseFhReadArgs(bufferOrOptions, offset, length, position) {
  let buffer;
  let opts;
  if (bufferOrOptions === undefined || bufferOrOptions === null) {
    buffer = Buffer.alloc(READ_CHUNK);
    opts = { offset: 0, length: READ_CHUNK, position: undefined };
  } else if (bufferOrOptions instanceof Uint8Array || ArrayBuffer.isView(bufferOrOptions)) {
    // `read(buffer[, offset[, length[, position]]])` / `read(buffer, options)`. Typed arrays and
    // DataViews are accepted like Node; the shared bytes are written in place.
    buffer = bufferOrOptions instanceof Uint8Array
      ? bufferOrOptions
      : asUint8Array(bufferOrOptions, "buffer");
    if (offset !== null && typeof offset === "object") {
      opts = offset;
    } else {
      opts = { offset, length, position };
    }
  } else if (typeof bufferOrOptions === "object") {
    opts = bufferOrOptions;
    buffer = opts.buffer === undefined ? Buffer.alloc(READ_CHUNK) : asUint8Array(opts.buffer, "options.buffer");
  } else {
    throw invalidArgType("buffer", "Buffer, TypedArray, or DataView", bufferOrOptions);
  }
  const window = validateOffsetLength(buffer, opts.offset, opts.length);
  return { buffer, offset: window.offset, length: window.length, position: validatePosition(opts.position) };
}

function parseWriteArgs(data, offsetOrOptions, length, position) {
  const buffer = asUint8Array(data, "buffer");
  let opts;
  if (offsetOrOptions !== null && typeof offsetOrOptions === "object") {
    opts = offsetOrOptions;
  } else {
    opts = { offset: offsetOrOptions, length, position };
  }
  const window = validateOffsetLength(buffer, opts.offset, opts.length);
  return {
    data: buffer,
    offset: window.offset,
    length: window.length,
    position: validatePosition(opts.position),
  };
}

function validateBuffers(buffers) {
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "Array", buffers);
  const result = [];
  for (let index = 0; index < buffers.length; index++) {
    const item = buffers[index];
    if (!(item instanceof Uint8Array)) {
      throw invalidArgType(`buffers[${index}]`, "Buffer or Uint8Array", item);
    }
    result.push(item);
  }
  return result;
}

function toUnixTimestamp(time) {
  if (typeof time === "string") {
    if (time.toLowerCase() === "now") return Date.now();
    const parsed = Date.parse(time);
    if (Number.isNaN(parsed)) {
      throw invalidArgValue("time", time, "must be a finite number or a valid date string");
    }
    return parsed;
  }
  if (time instanceof Date) return time.getTime();
  if (typeof time === "number" && Number.isFinite(time)) {
    if (time < 0) return Date.now();
    return Math.round(time * 1000);
  }
  throw invalidArgType("time", "number, string, or Date", time);
}


// --- fs streams ------------------------------------------------------------------------------

// `fs.createReadStream` and `FileHandle.createReadStream` share one implementation. Opening is
// async (the first `_read`/`_write` submits the op), so an unreadable path surfaces as an
// `'error'` event rather than a constructor throw, like Node.
const DEFAULT_STREAM_HWM = 64 * 1024;

class ReadStream extends Readable {
  constructor(path, options) {
    const opts = options === undefined || options === null ? {} : options;
    super({
      highWaterMark: opts.highWaterMark,
      encoding: opts.encoding,
      emitClose: opts.emitClose !== false,
    });
    this.path = path === undefined ? undefined : String(path);
    this.fd = opts.fd === undefined || opts.fd === null ? null : opts.fd;
    this.flags = opts.flags === undefined ? "r" : opts.flags;
    this.mode = opts.mode === undefined ? 0o666 : parseFileMode(opts.mode, "mode", 0o666);
    this.start = opts.start === undefined || opts.start === null ? undefined : opts.start;
    this.end = opts.end === undefined || opts.end === null ? undefined : opts.end;
    this.pos = this.start === undefined ? 0 : this.start;
    this.autoClose = opts.autoClose === undefined ? true : Boolean(opts.autoClose);
    this._handle = opts.handle === undefined ? null : opts.handle;
    this.bytesRead = 0;
    this._opened = this.fd !== null;
    this._opening = false;
    this._closed = false;
    if (this.start !== undefined) validateInteger(this.start, "start", 0, Number.MAX_SAFE_INTEGER);
    if (this.end !== undefined) {
      validateInteger(this.end, "end", 0, Number.MAX_SAFE_INTEGER);
      if (this.end < this.pos) throw outOfRange("end", `>= ${this.pos}`, this.end);
    }
    if (this.fd === null && this.path === undefined) {
      throw invalidArgType("path", "string or an instance of Buffer or URL", path);
    }
    if (opts.signal !== undefined && opts.signal !== null) addAbortSignal(opts.signal, this);
  }

  _open() {
    const self = this;
    if (this._opened) return Promise.resolve(this.fd);
    if (this._opening) {
      return new Promise((resolve, reject) => {
        self.once("open", () => resolve(self.fd));
        self.once("error", reject);
      });
    }
    this._opening = true;
    return promise("open", [this.path, normalizeFlags(this.flags), this.mode]).then(
      (fd) => {
        self._opened = true;
        self._opening = false;
        self.fd = fd;
        trackOpen(fd);
        self.emit("open", fd);
        return fd;
      },
      (error) => {
        self._opening = false;
        throw normalizeError(error);
      },
    );
  }

  _read(size) {
    if (this._closed) return;
    const self = this;
    this._open().then(
      (fd) => {
        if (self._closed) return;
        const want = size === undefined ? DEFAULT_STREAM_HWM : size;
        let length = Math.max(1, Math.min(want, DEFAULT_STREAM_HWM));
        if (self.end !== undefined) {
          const remaining = self.end + 1 - self.pos;
          if (remaining <= 0) {
            self.push(null);
            return;
          }
          length = Math.min(length, remaining);
        }
        promise("read", [fd, length, self.pos]).then(
          (bytes) => {
            if (self._closed) return;
            if (bytes.length === 0) {
              self.push(null);
              return;
            }
            self.pos += bytes.length;
            self.bytesRead += bytes.length;
            self.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            // Our `_read` fills asynchronously. `stream` only restarts the flowing read loop
            // from inside `read()`, so a chunk that arrives later would otherwise be the last
            // one (no 'end'). Nudging `read(0)` schedules the next `_read`.
            process.nextTick(() => {
              if (!self._closed && self.readable) self.read(0);
            });
          },
          (error) => self.destroy(normalizeError(error)),
        );
      },
      (error) => self.destroy(error),
    );
  }

  _destroy(error, callback) {
    const self = this;
    const finish = (next) => {
      self._closed = true;
      self.fd = null;
      if (self._handle !== null) self._handle._markClosed();
      callback(next);
    };
    if (!this.autoClose || !this._opened || this.fd === null) {
      finish(error);
      return;
    }
    const fd = this.fd;
    trackClose(fd);
    promise("close", [fd]).then(
      () => finish(error),
      (closeError) => finish(error === null || error === undefined ? closeError : error),
    );
  }
}

class WriteStream extends Writable {
  constructor(path, options) {
    const opts = options === undefined || options === null ? {} : options;
    super({ highWaterMark: opts.highWaterMark, emitClose: opts.emitClose !== false });
    this.path = path === undefined ? undefined : String(path);
    this.fd = opts.fd === undefined || opts.fd === null ? null : opts.fd;
    this.flags = opts.flags === undefined ? "w" : opts.flags;
    this.mode = opts.mode === undefined ? 0o666 : parseFileMode(opts.mode, "mode", 0o666);
    this.bytesWritten = 0;
    this.autoClose = opts.autoClose === undefined ? true : Boolean(opts.autoClose);
    this._handle = opts.handle === undefined ? null : opts.handle;
    this._opened = this.fd !== null;
    this._opening = false;
    this._closed = false;
    if (this.fd === null && this.path === undefined) {
      throw invalidArgType("path", "string or an instance of Buffer or URL", path);
    }
    if (opts.signal !== undefined && opts.signal !== null) addAbortSignal(opts.signal, this);
  }

  _open() {
    const self = this;
    if (this._opened) return Promise.resolve(this.fd);
    if (this._opening) {
      return new Promise((resolve, reject) => {
        self.once("open", () => resolve(self.fd));
        self.once("error", reject);
      });
    }
    this._opening = true;
    return promise("open", [this.path, normalizeFlags(this.flags), this.mode]).then(
      (fd) => {
        self._opened = true;
        self._opening = false;
        self.fd = fd;
        trackOpen(fd);
        self.emit("open", fd);
        return fd;
      },
      (error) => {
        self._opening = false;
        throw normalizeError(error);
      },
    );
  }

  _write(chunk, encoding, callback) {
    const self = this;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : toBytes(chunk);
    if (bytes === null) {
      callback(invalidArgType("chunk", "string, Buffer, or Uint8Array", chunk));
      return;
    }
    this._open().then(
      (fd) => {
        writeAllToFd(fd, bytes, -1).then(
          (written) => {
            self.bytesWritten += written;
            callback();
          },
          (error) => callback(normalizeError(error)),
        );
      },
      (error) => callback(error),
    );
  }

  _final(callback) {
    const self = this;
    if (!this.autoClose || !this._opened || this.fd === null) {
      callback();
      return;
    }
    const fd = this.fd;
    trackClose(fd);
    promise("close", [fd]).then(
      () => {
        self._closed = true;
        self.fd = null;
        if (self._handle !== null) self._handle._markClosed();
        callback();
      },
      (error) => callback(normalizeError(error)),
    );
  }

  _destroy(error, callback) {
    const self = this;
    if (!this.autoClose || !this._opened || this.fd === null) {
      callback(error);
      return;
    }
    const fd = this.fd;
    trackClose(fd);
    promise("close", [fd]).then(
      () => {
        self._closed = true;
        callback(error);
      },
      (closeError) => callback(error === null || error === undefined ? closeError : error),
    );
  }
}

function createReadStream(path, options) {
  const opts = options === undefined || options === null ? {} : options;
  const streamPath =
    opts.fd === undefined || opts.fd === null ? toPath(path, "path") : undefined;
  return new ReadStream(streamPath, opts);
}

function createWriteStream(path, options) {
  const opts = options === undefined || options === null ? {} : options;
  const streamPath =
    opts.fd === undefined || opts.fd === null ? toPath(path, "path") : undefined;
  return new WriteStream(streamPath, opts);
}

// --- module exports --------------------------------------------------------------------------

module.exports = {
  // classes
  Stats,
  Dirent,
  Dir,
  FileHandle,
  ReadStream,
  WriteStream,
  FileReadStream: ReadStream,
  FileWriteStream: WriteStream,

  // the single call path
  sync,
  callAsync,
  promise,
  hostSync,
  hostAsync,

  // constants and normalization
  constants,
  toPath,
  normalizeFlags,
  parseFileMode,
  normalizeEncoding,
  encodingOrNull,
  getOptions,
  validateInteger,
  validatePosition,
  validateOffsetLength,
  validateBuffers,
  asUint8Array,
  toBytes,
  toUnixTimestamp,
  decodeBytes,
  makeStats,
  makeStatsFs,
  makeDirent,
  dirIterator,
  copyInto,
  concatBytes,
  normalizeError,
  withDest,

  // error constructors
  codedError,
  invalidArgType,
  invalidArgValue,
  outOfRange,
  systemError,
  abortSignalOf,

  // fd bookkeeping
  trackOpen,
  trackClose,
  forgetFd,
  closedFdError,
  openFds,
  retiredFds,

  // streams
  createReadStream,
  createWriteStream,
  readAllFromFd,
  writeAllToFd,
  dataToBytes,
  READ_CHUNK,
  MAX_READ_LENGTH,
  requireInternal,
};
