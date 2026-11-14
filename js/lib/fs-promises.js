"use strict";

// `fs/promises` — the promise surface.
//
// This is **not** `promisify(fs)` (D35). It is a separate API shape:
//
//   * no `*Sync` variants and no top-level fd calls (`close`, `read`, `write`, `readv`,
//     `writev`, `fstat`, `fchmod`, `fchown`, `fsync`, `fdatasync`, `ftruncate`, `futimes` are
//     `FileHandle` methods);
//   * `open` resolves a `FileHandle`, `watch` is an async iterator;
//   * `readFile`/`writeFile`/`appendFile`/`stat` also accept a `FileHandle`;
//   * `constants` is the same object `fs.constants` is.
//
// Bad arguments reject (every exported function is an async function) except `watch`, which
// returns an iterator synchronously and therefore throws synchronously like Node's does.

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

const internal = requireInternal("internal/fs", "./internal/fs.js");
const fs = EMBEDDED ? require("fs") : require("./fs.js");
const { constants } = internal;

let BufferCtor = null;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("./buffer.js");
}
const Buffer = BufferCtor;

// --- option helpers --------------------------------------------------------------------------

function parseReadFileOptions(options) {
  const opts =
    typeof options === "string" ? { encoding: options } : options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding:
      opts.encoding === undefined || opts.encoding === null
        ? null
        : internal.normalizeEncoding(opts.encoding),
    flags: internal.normalizeFlags(opts.flag, "options.flag"),
    flagGiven: opts.flag !== undefined,
    signal: internal.abortSignalOf(opts),
  };
}

function parseWriteFileOptions(options, defaultFlag) {
  const opts =
    typeof options === "string" ? { encoding: options } : options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding:
      opts.encoding === undefined || opts.encoding === null
        ? "utf8"
        : internal.normalizeEncoding(opts.encoding),
    mode: opts.mode === undefined ? 0o666 : internal.parseFileMode(opts.mode, "options.mode", 0o666),
    flags: internal.normalizeFlags(opts.flag === undefined ? defaultFlag : opts.flag, "options.flag"),
    signal: internal.abortSignalOf(opts),
  };
}

function parseMode(options) {
  if (options === undefined || options === null) return {};
  if (typeof options === "number") return { mode: options };
  if (typeof options !== "object") throw internal.invalidArgType("options", "object", options);
  if (options.bigint === true) {
    throw internal.invalidArgValue("options.bigint", true, "is not supported by lite-node M3");
  }
  return options;
}

function dirOptions(options) {
  if (typeof options === "string") {
    return { encoding: options === "buffer" ? "buffer" : internal.normalizeEncoding(options), withFileTypes: false, recursive: false };
  }
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding:
      opts.encoding === undefined
        ? "utf8"
        : opts.encoding === "buffer"
          ? "buffer"
          : internal.normalizeEncoding(opts.encoding),
    withFileTypes: opts.withFileTypes === true,
    recursive: opts.recursive === true,
  };
}

function fileEncoding(encoding) {
  if (encoding === undefined || encoding === null) return "utf8";
  if (encoding === "buffer") return "buffer";
  return internal.normalizeEncoding(encoding);
}

function entryValue(entry, encoding, parentPath, withFileTypes) {
  const name = encoding === "buffer" ? Buffer.from(entry.name, "utf8") : entry.name;
  if (withFileTypes) return new internal.Dirent(name, entry.kind, parentPath);
  return name;
}


// Composite helpers in `fs` (recursive readdir, cp, streams) are the same behaviour in both
// shapes; adapt their callback form here instead of keeping a second implementation.
function fromCallback(fn, args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// --- files -----------------------------------------------------------------------------------

async function access(path, mode) {
  const value = mode === undefined || mode === null ? constants.F_OK : mode;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw internal.invalidArgType("mode", "integer", value);
  }
  if (value < 0 || value > 7) throw internal.outOfRange("mode", ">= 0 && <= 7", value);
  await internal.promise("access", [internal.toPath(path), value]);
}

async function readFile(path, options) {
  if (path instanceof internal.FileHandle) return path.readFile(options);
  const parsed = parseReadFileOptions(options);
  const target = internal.toPath(path);
  if (parsed.flags === constants.O_RDONLY) {
    const bytes = await internal.promise("readFile", [target], parsed.signal);
    return internal.decodeBytes(bytes, parsed.encoding);
  }
  const fd = await internal.promise("open", [target, parsed.flags, 0o666], parsed.signal);
  internal.trackOpen(fd);
  try {
    const bytes = await internal.readAllFromFd(fd, -1, parsed.signal);
    return internal.decodeBytes(bytes, parsed.encoding);
  } finally {
    internal.trackClose(fd);
    await internal.promise("close", [fd]).then(
      () => undefined,
      () => undefined,
    );
  }
}

async function writeFile(file, data, options) {
  if (file instanceof internal.FileHandle) return file.writeFile(data, options);
  const parsed = parseWriteFileOptions(options, "w");
  const target = internal.toPath(file);
  const bytes = await internal.dataToBytes(data, parsed.encoding, true);
  await internal.promise("writeFile", [target, bytes, parsed.mode, parsed.flags], parsed.signal);
}

async function appendFile(file, data, options) {
  if (file instanceof internal.FileHandle) return file.appendFile(data, options);
  const parsed = parseWriteFileOptions(options, "a");
  const target = internal.toPath(file);
  const bytes = await internal.dataToBytes(data, parsed.encoding, true);
  await internal.promise("appendFile", [target, bytes, parsed.mode, parsed.flags], parsed.signal);
}

async function copyFile(src, dest, mode) {
  const from = internal.toPath(src, "src");
  const to = internal.toPath(dest, "dest");
  let flags = 0;
  if (mode !== undefined && mode !== null) {
    flags = internal.validateInteger(mode, "mode", 0, 7);
    if ((flags & ~7) !== 0) throw internal.invalidArgValue("mode", mode, "is invalid");
  }
  await internal.promise("copyFile", [from, to, flags]).then(undefined, (error) => {
    throw internal.withDest(error, to);
  });
}

async function cp(src, dest, options) {
  await fromCallback(fs.cp, [src, dest, options]);
}

// --- directories -----------------------------------------------------------------------------

async function checkRecursiveTarget(target) {
  try {
    const raw = await internal.promise("lstat", [target]);
    if (!internal.makeStats(raw).isDirectory()) {
      throw internal.systemError("EEXIST", "mkdir", target);
    }
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

async function mkdir(path, options) {
  let recursive = false;
  let mode = 0o777;
  if (typeof options === "number") {
    mode = internal.parseFileMode(options, "mode", 0o777);
  } else if (options !== undefined && options !== null) {
    if (typeof options !== "object") throw internal.invalidArgType("options", "object", options);
    recursive = options.recursive === true;
    mode = options.mode === undefined ? 0o777 : internal.parseFileMode(options.mode, "options.mode", 0o777);
  }
  const target = internal.toPath(path);
  if (recursive) await checkRecursiveTarget(target);
  const value = await internal.promise("mkdir", [target, mode, recursive]);
  if (!recursive) return undefined;
  return value === "" || value === undefined || value === null ? undefined : value;
}

async function mkdtemp(prefix, options) {
  const opts = options === undefined || options === null ? {} : options;
  let encoding = "utf8";
  if (typeof opts === "string") encoding = fileEncoding(opts);
  else if (typeof opts === "object") encoding = fileEncoding(opts.encoding);
  else throw internal.invalidArgType("options", "object", options);
  const value = await internal.promise("mkdtemp", [internal.toPath(prefix, "prefix")]);
  return encoding === "buffer" ? Buffer.from(value) : value;
}

async function readdir(path, options) {
  const opts = dirOptions(options);
  if (opts.recursive) return fromCallback(fs.readdir, [path, options]);
  const target = internal.toPath(path);
  const entries = await internal.promise("readdir", [target, true]);
  const result = [];
  for (let index = 0; index < entries.length; index++) {
    result.push(entryValue(entries[index], opts.encoding, target, opts.withFileTypes));
  }
  return result;
}

async function opendir(path, options) {
  const opts = dirOptions(options);
  const target = internal.toPath(path);
  const entries = await internal.promise("readdir", [target, true]);
  const dirents = [];
  for (let index = 0; index < entries.length; index++) {
    dirents.push(entryValue(entries[index], opts.encoding, target, true));
  }
  return new internal.Dir(target, dirents);
}

async function rm(path, options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  const maxRetries =
    opts.maxRetries === undefined
      ? 0
      : internal.validateInteger(opts.maxRetries, "options.maxRetries", 0, 2147483647);
  const retryDelay =
    opts.retryDelay === undefined
      ? 0
      : internal.validateInteger(opts.retryDelay, "options.retryDelay", 0, Number.MAX_SAFE_INTEGER);
  await internal.promise("rm", [
    internal.toPath(path),
    opts.recursive === true,
    opts.force === true,
    maxRetries,
    retryDelay,
  ]);
}

async function rmdir(path, options) {
  const opts = options === undefined || options === null ? {} : options;
  await internal.promise("rmdir", [internal.toPath(path), opts && opts.recursive === true]);
}

// --- metadata --------------------------------------------------------------------------------

async function stat(path, options) {
  if (path instanceof internal.FileHandle) return path.stat(options);
  parseMode(options);
  const raw = await internal.promise("stat", [internal.toPath(path)]);
  return internal.makeStats(raw);
}

async function lstat(path, options) {
  parseMode(options);
  const raw = await internal.promise("lstat", [internal.toPath(path)]);
  return internal.makeStats(raw);
}

async function chmod(path, mode) {
  if (mode === undefined || mode === null) throw internal.invalidArgType("mode", "integer", mode);
  await internal.promise("chmod", [internal.toPath(path), internal.parseFileMode(mode, "mode", 0o666), true]);
}

async function chown(path, uid, gid) {
  const userId = internal.validateInteger(uid, "uid", 0, 4294967295);
  const groupId = internal.validateInteger(gid, "gid", 0, 4294967295);
  await internal.promise("chown", [internal.toPath(path), userId, groupId, true]);
}

async function truncate(path, len) {
  await internal.promise("truncate", [
    internal.toPath(path),
    internal.validateInteger(len, "len", 0, Number.MAX_SAFE_INTEGER),
  ]);
}

async function utimes(path, atime, mtime) {
  if (atime === undefined || atime === null) {
    throw internal.invalidArgType("atime", "number, string, or Date", atime);
  }
  if (mtime === undefined || mtime === null) {
    throw internal.invalidArgType("mtime", "number, string, or Date", mtime);
  }
  await internal.promise("utimes", [
    internal.toPath(path),
    internal.toUnixTimestamp(atime),
    internal.toUnixTimestamp(mtime),
    true,
  ]);
}

// --- links -----------------------------------------------------------------------------------

async function link(existingPath, newPath) {
  const link = internal.toPath(newPath, "newPath");
  await internal.promise("link", [internal.toPath(existingPath, "existingPath"), link]).then(
    undefined,
    (error) => {
      throw internal.withDest(error, link);
    },
  );
}

async function symlink(target, path, type) {
  if (type !== undefined && type !== null) {
    if (typeof type !== "string") throw internal.invalidArgType("type", "string", type);
    if (type !== "dir" && type !== "file" && type !== "junction") {
      throw internal.invalidArgValue("type", type, "must be one of 'dir', 'file', or 'junction'");
    }
  }
  const link = internal.toPath(path);
  await internal.promise("symlink", [internal.toPath(target, "target"), link]).then(
    undefined,
    (error) => {
      throw internal.withDest(error, link);
    },
  );
}

async function readlink(path, options) {
  const encoding = fileEncoding(typeof options === "string" ? options : options && options.encoding);
  const raw = await internal.promise("readlink", [internal.toPath(path)]);
  if (encoding === "buffer") return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return internal.decodeBytes(raw, encoding);
}

async function realpath(path, options) {
  const encoding = fileEncoding(typeof options === "string" ? options : options && options.encoding);
  const value = await internal.promise("realpath", [internal.toPath(path)]);
  return encoding === "buffer" ? Buffer.from(value) : value;
}

async function rename(oldPath, newPath) {
  const to = internal.toPath(newPath, "newPath");
  await internal.promise("rename", [internal.toPath(oldPath, "oldPath"), to]).then(
    undefined,
    (error) => {
      throw internal.withDest(error, to);
    },
  );
}

async function unlink(path) {
  await internal.promise("unlink", [internal.toPath(path)]);
}

// --- open / FileHandle -----------------------------------------------------------------------

async function open(path, flags, mode) {
  const target = internal.toPath(path);
  const openFlags = internal.normalizeFlags(flags);
  const openMode = mode === undefined ? 0o666 : internal.parseFileMode(mode, "mode", 0o666);
  const fd = await internal.promise("open", [target, openFlags, openMode]);
  internal.trackOpen(fd);
  return new internal.FileHandle(fd, target);
}

// --- watch -----------------------------------------------------------------------------------

// fs/promises.watch returns an async iterator of { eventType, filename }. The watcher itself is
// fs.watch's polling implementation (D3); this adapter converts events into promises.
function watch(filename, options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  const signal = internal.abortSignalOf(opts);
  const watcher = fs.watch(filename, opts);
  const queue = [];
  const waiters = [];
  let done = false;
  let failure = null;

  function settleWaiters() {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (failure !== null) waiter.reject(failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  function push(value) {
    if (waiters.length > 0) waiters.shift().resolve({ value, done: false });
    else queue.push({ value, done: false });
  }

  function finish(error) {
    if (done) return;
    done = true;
    if (error !== undefined) failure = error;
    settleWaiters();
  }

  watcher.on("change", (eventType, name) => push({ eventType, filename: name }));
  watcher.on("error", (error) => finish(error));
  watcher.on("close", () => finish());

  let onAbort = null;
  if (signal !== undefined) {
    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      finish(error);
      watcher.close();
    };
    if (signal.aborted) {
      process.nextTick(abort);
    } else {
      onAbort = abort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const iterator = {
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (failure !== null) return Promise.reject(failure);
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    return() {
      if (onAbort !== null && signal !== undefined) signal.removeEventListener("abort", onAbort);
      watcher.close();
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(error) {
      if (onAbort !== null && signal !== undefined) signal.removeEventListener("abort", onAbort);
      watcher.close();
      finish();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

// --- exports ---------------------------------------------------------------------------------

module.exports = {
  access,
  appendFile,
  chmod,
  chown,
  constants,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
};
