"use strict";

// `fs` — the synchronous + callback surface over `internal/fs`.
//
// The Rust host owns every syscall; `internal/fs` owns argument normalization and the single op
// call path. This file is only the public shape:
//
//   * a `*Sync` function for every operation, which throws;
//   * a callback function, which validates synchronously (Node does) and delivers syscall
//     failures through the callback from the completion dispatch;
//   * the fs streams, the polling watchers, `opendir`, `cp` and `exists`.
//
// `fs/promises` is a different API (D35) and lives in `fs-promises.js`; this module exposes it
// through the `promises` getter only.

const EMBEDDED = typeof __filename === "string" && __filename.startsWith("<lite:");

// Resolve an internal sibling: embedded builds name the builtin, a checkout run resolves the
// file next to this one. `./internal/fs` from `<lite:fs>` would otherwise resolve back to `fs`.
function requireInternal(name, relative) {
  if (EMBEDDED) return require(name);
  return require(relative);
}

const internal = requireInternal("internal/fs", "./internal/fs.js");
const { constants, Stats, Dirent, Dir, FileHandle } = internal;

let BufferCtor = null;
try {
  BufferCtor = require("buffer").Buffer;
} catch (_) {
  BufferCtor = require("./buffer.js");
}
const Buffer = BufferCtor;

let EventEmitterCtor = null;
try {
  EventEmitterCtor = require("events");
} catch (_) {
  EventEmitterCtor = require("./events.js");
}
const EventEmitter = EventEmitterCtor;

let pathModule = null;
function path() {
  if (pathModule === null) {
    try {
      pathModule = require("path");
    } catch (_) {
      pathModule = require("./path.js");
    }
  }
  return pathModule;
}

// --- small helpers ---------------------------------------------------------------------------

function checkCallback(callback, name) {
  if (typeof callback !== "function") {
    throw internal.invalidArgType(name === undefined ? "callback" : name, "function", callback);
  }
  return callback;
}

function validateFd(fd) {
  if (typeof fd !== "number") throw internal.invalidArgType("fd", "number", fd);
  if (!Number.isInteger(fd)) throw internal.invalidArgType("fd", "integer", fd);
  if (fd < -2147483648 || fd > 2147483647) {
    throw internal.outOfRange("fd", "a 32-bit signed integer", fd);
  }
  return fd;
}

function validateBigintOption(options) {
  if (options !== null && typeof options === "object" && options.bigint === true) {
    throw internal.invalidArgValue("options.bigint", true, "is not supported by lite-node M3");
  }
}

// Bad arguments throw synchronously before anything reaches the host; a syscall failure is
// delivered to the callback instead. Composite operations (cp) cannot use the completion
// dispatch for their final callback, so a throw from the user callback is rethrown on the next
// tick, which is what Node's async context gives it.
function deliver(callback) {
  const args = Array.prototype.slice.call(arguments, 1);
  try {
    callback.apply(undefined, args);
  } catch (error) {
    process.nextTick(() => {
      throw error;
    });
  }
}

function decodeResult(value, encoding) {
  if (typeof value === "string") return encoding === null ? Buffer.from(value) : value;
  return internal.decodeBytes(value, encoding);
}

function mapCreated(value) {
  return value === "" || value === undefined || value === null ? undefined : value;
}

function isPromise(value) {
  return value !== null && typeof value === "object" && typeof value.then === "function";
}

function parseReadFileOptions(options) {
  const opts =
    typeof options === "string" ? { encoding: options } : options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  const encoding =
    opts.encoding === undefined || opts.encoding === null
      ? null
      : internal.normalizeEncoding(opts.encoding);
  const flags = internal.normalizeFlags(opts.flag, "options.flag");
  return { encoding, flags, signal: internal.abortSignalOf(opts) };
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
    flush: opts.flush === true,
    signal: internal.abortSignalOf(opts),
  };
}

function requiredMode(mode) {
  if (mode === undefined || mode === null) {
    throw internal.invalidArgType("mode", "integer", mode);
  }
  return internal.parseFileMode(mode, "mode", 0o666);
}

// --- readFile / writeFile / appendFile -------------------------------------------------------

function readFile(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const parsed = parseReadFileOptions(options);
  const target = internal.toPath(pathValue);
  if (parsed.flags === constants.O_RDONLY) {
    internal.callAsync("readFile", [target], {
      signal: parsed.signal,
      callback: (error, value) =>
        callback(error, error ? undefined : internal.decodeBytes(value, parsed.encoding)),
    });
    return;
  }
  readFileWithFlags(target, parsed).then(
    (value) => deliver(callback, null, value),
    (error) => deliver(callback, error),
  );
}

function readFileWithFlags(target, parsed) {
  return internal.promise("open", [target, parsed.flags, 0o666], parsed.signal).then((fd) => {
    internal.trackOpen(fd);
    const close = () =>
      internal.promise("close", [fd]).then(
        () => undefined,
        () => undefined,
      );
    return internal.readAllFromFd(fd, -1, parsed.signal).then(
      (bytes) => close().then(() => internal.decodeBytes(bytes, parsed.encoding)),
      (error) => close().then(() => { throw error; }),
    );
  });
}

function readFileSync(pathValue, options) {
  const parsed = parseReadFileOptions(options);
  const target = internal.toPath(pathValue);
  if (parsed.flags === constants.O_RDONLY) {
    return internal.decodeBytes(internal.sync("readFile", [target]), parsed.encoding);
  }
  const fd = internal.sync("open", [target, parsed.flags, 0o666]);
  internal.trackOpen(fd);
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const bytes = internal.sync("read", [fd, internal.READ_CHUNK, -1]);
      if (bytes.length === 0) break;
      chunks.push(bytes);
      total += bytes.length;
    }
    return internal.decodeBytes(internal.concatBytes(chunks, total), parsed.encoding);
  } finally {
    internal.trackClose(fd);
    internal.sync("close", [fd]);
  }
}

function writeFile(file, data, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const parsed = parseWriteFileOptions(options, "w");
  const target = internal.toPath(file);
  const bytes = internal.dataToBytes(data, parsed.encoding, true);
  const args = [target, bytes, parsed.mode, parsed.flags];
  if (!isPromise(bytes)) {
    internal.callAsync("writeFile", args, {
      signal: parsed.signal,
      callback: (error) => callback(error),
    });
    return;
  }
  bytes.then(
    (resolved) =>
      internal.callAsync("writeFile", [target, resolved, parsed.mode, parsed.flags], {
        signal: parsed.signal,
        callback: (error) => callback(error),
      }),
    (error) => deliver(callback, error),
  );
}

function writeFileSync(file, data, options) {
  const parsed = parseWriteFileOptions(options, "w");
  const target = internal.toPath(file);
  const bytes = internal.dataToBytes(data, parsed.encoding, false);
  internal.sync("writeFile", [target, bytes, parsed.mode, parsed.flags]);
}

function appendFile(file, data, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const parsed = parseWriteFileOptions(options, "a");
  const target = internal.toPath(file);
  const bytes = internal.dataToBytes(data, parsed.encoding, true);
  if (!isPromise(bytes)) {
    internal.callAsync("appendFile", [target, bytes, parsed.mode, parsed.flags], {
      signal: parsed.signal,
      callback: (error) => callback(error),
    });
    return;
  }
  bytes.then(
    (resolved) =>
      internal.callAsync("appendFile", [target, resolved, parsed.mode, parsed.flags], {
        signal: parsed.signal,
        callback: (error) => callback(error),
      }),
    (error) => deliver(callback, error),
  );
}

function appendFileSync(file, data, options) {
  const parsed = parseWriteFileOptions(options, "a");
  const target = internal.toPath(file);
  const bytes = internal.dataToBytes(data, parsed.encoding, false);
  internal.sync("appendFile", [target, bytes, parsed.mode, parsed.flags]);
}

// --- copyFile / cp ---------------------------------------------------------------------------

function parseCopyFileFlags(mode) {
  if (mode === undefined || mode === null) return 0;
  const value = internal.validateInteger(mode, "mode", 0, 7);
  if ((value & ~7) !== 0) throw internal.invalidArgValue("mode", mode, "is invalid");
  return value;
}

function copyFile(src, dest, mode, callback) {
  if (typeof mode === "function") {
    callback = mode;
    mode = undefined;
  }
  checkCallback(callback);
  const from = internal.toPath(src, "src");
  const to = internal.toPath(dest, "dest");
  const flags = parseCopyFileFlags(mode);
  internal.callAsync("copyFile", [from, to, flags], {
    callback: (error) => {
      if (error) internal.withDest(error, to);
      callback(error);
    },
  });
}

function copyFileSync(src, dest, mode) {
  const from = internal.toPath(src, "src");
  const to = internal.toPath(dest, "dest");
  const flags = parseCopyFileFlags(mode);
  try {
    internal.sync("copyFile", [from, to, flags]);
  } catch (error) {
    throw internal.withDest(error, to);
  }
}

function parseCpOptions(options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  if (opts.filter !== undefined && typeof opts.filter !== "function") {
    throw internal.invalidArgType("options.filter", "function", opts.filter);
  }
  return {
    recursive: opts.recursive === true,
    force: opts.force !== false,
    errorOnExist: opts.errorOnExist === true,
    dereference: opts.dereference === true,
    preserveTimestamps: opts.preserveTimestamps === true,
    verbatimSymlinks: opts.verbatimSymlinks === true,
    filter: opts.filter,
  };
}

function eisdirError(operation, source) {
  return internal.codedError(
    Error,
    "ERR_FS_EISDIR",
    `Path is a directory: ${operation} returned EISDIR (is a directory) ${String(source)}`,
  );
}

function existsSyncInternal(target) {
  try {
    internal.sync("lstat", [target]);
    return true;
  } catch (_) {
    return false;
  }
}

function copyTimesSync(source, dest, stat) {
  internal.sync("utimes", [dest, stat.atimeMs, stat.mtimeMs, true]);
}

function ensureDirectorySync(dest) {
  const existed = existingDirectory(dest);
  if (!existed) internal.sync("mkdir", [dest, 0o777, true]);
  return !existed;
}

function cpSyncImpl(src, dest, opts) {
  if (opts.filter !== undefined && !opts.filter(src, dest)) return;
  let stat = internal.makeStats(internal.sync("lstat", [src]));
  if (stat.isSymbolicLink() && opts.dereference) {
    stat = internal.makeStats(internal.sync("stat", [src]));
  }
  if (stat.isDirectory()) {
    if (!opts.recursive) throw eisdirError("cp", src);
    const created = ensureDirectorySync(dest);
    const entries = internal.sync("readdir", [src, true]);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      cpSyncImpl(path().join(src, entry.name), path().join(dest, entry.name), opts);
    }
    if (created && opts.preserveTimestamps) copyTimesSync(src, dest, stat);
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = internal.decodeBytes(internal.sync("readlink", [src]), "utf8");
    const link = opts.verbatimSymlinks ? target : path().resolve(path().dirname(src), target);
    if (!opts.force && existsSyncInternal(dest)) {
      if (opts.errorOnExist) throw internal.systemError("EEXIST", "copyfile", dest);
      return;
    }
    internal.sync("symlink", [link, dest]);
    return;
  }
  if (!opts.force && existsSyncInternal(dest)) {
    if (opts.errorOnExist) throw internal.systemError("EEXIST", "copyfile", dest);
    return;
  }
  internal.sync("copyFile", [src, dest, 0]);
  if (opts.preserveTimestamps) copyTimesSync(src, dest, stat);
}

function checkCpDistinct(from, to) {
  const resolvedFrom = path().resolve(from);
  const resolvedTo = path().resolve(to);
  if (resolvedFrom === resolvedTo) {
    throw internal.codedError(Error, "ERR_FS_CP_EINVAL", "Source and destination must not be the same.");
  }
  if (resolvedTo.startsWith(resolvedFrom + path().sep)) {
    throw internal.codedError(
      Error,
      "ERR_FS_CP_EINVAL",
      `Cannot copy ${resolvedFrom} to a subdirectory of self ${resolvedTo}`,
    );
  }
}

function cpSync(src, dest, options) {
  const opts = parseCpOptions(options);
  const from = internal.toPath(src, "src");
  const to = internal.toPath(dest, "dest");
  if (opts.recursive) checkCpDistinct(from, to);
  cpSyncImpl(from, to, opts);
}

function ensureDirectory(dest) {
  return new Promise((resolve) => {
    resolve(existingDirectory(dest));
  }).then((existed) =>
    existed
      ? false
      : internal.promise("mkdir", [dest, 0o777, true]).then(() => true),
  );
}

function cpWithOptions(src, dest, opts) {
  if (opts.recursive) checkCpDistinct(src, dest);
  function visit(from, to) {
    if (opts.filter !== undefined && !opts.filter(from, to)) return Promise.resolve();
    return internal.promise("lstat", [from]).then((raw) => {
      const original = internal.makeStats(raw);
      const followed = original.isSymbolicLink() && opts.dereference
        ? internal.promise("stat", [from]).then((value) => internal.makeStats(value))
        : Promise.resolve(original);
      return followed.then((stat) => copyEntry(from, to, stat, original));
    });
  }

  function copyEntry(from, to, stat, original) {
    if (stat.isDirectory()) {
      if (!opts.recursive) throw eisdirError("cp", from);
      return ensureDirectory(to).then((created) =>
        internal.promise("readdir", [from, true]).then((entries) => {
          let chain = Promise.resolve();
          for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            const childFrom = path().join(from, entry.name);
            const childTo = path().join(to, entry.name);
            chain = chain.then(() => visit(childFrom, childTo));
          }
          return chain.then(() =>
            created && opts.preserveTimestamps
              ? internal.promise("utimes", [to, stat.atimeMs, stat.mtimeMs, true])
              : undefined,
          );
        }),
      );
    }
    if (original.isSymbolicLink() && !opts.dereference) {
      return internal.promise("readlink", [from]).then((raw) => {
        const target = internal.decodeBytes(raw, "utf8");
        const link = opts.verbatimSymlinks ? target : path().resolve(path().dirname(from), target);
        if (!opts.force && existsSyncInternal(to)) {
          if (opts.errorOnExist) throw internal.systemError("EEXIST", "copyfile", to);
          return undefined;
        }
        return internal.promise("symlink", [link, to]);
      });
    }
    if (!opts.force && existsSyncInternal(to)) {
      if (opts.errorOnExist) throw internal.systemError("EEXIST", "copyfile", to);
      return Promise.resolve();
    }
    return internal.promise("copyFile", [from, to, 0]).then(() =>
      opts.preserveTimestamps
        ? internal.promise("utimes", [to, stat.atimeMs, stat.mtimeMs, true])
        : undefined,
    );
  }

  return visit(internal.toPath(src, "src"), internal.toPath(dest, "dest"));
}

function cp(src, dest, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = parseCpOptions(options);
  cpWithOptions(src, dest, opts).then(
    () => deliver(callback, null),
    (error) => deliver(callback, internal.normalizeError(error)),
  );
}

// --- mkdir / mkdtemp -------------------------------------------------------------------------

// `mkdir -p` on an existing non-directory is EEXIST in Node. The host's recursive walk stops at
// the existing entry and reports "nothing created", so the check happens here.
function existingDirectory(target) {
  try {
    const stat = internal.makeStats(internal.sync("lstat", [target]));
    if (!stat.isDirectory()) throw internal.systemError("EEXIST", "mkdir", target);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function checkRecursiveTarget(target) {
  existingDirectory(target);
}

function mkdirOptions(options) {
  if (typeof options === "number") {
    return { recursive: false, mode: internal.parseFileMode(options, "mode", 0o777) };
  }
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    recursive: opts.recursive === true,
    mode: opts.mode === undefined ? 0o777 : internal.parseFileMode(opts.mode, "options.mode", 0o777),
  };
}

function mkdir(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = mkdirOptions(options);
  const target = internal.toPath(pathValue);
  if (opts.recursive) checkRecursiveTarget(target);
  internal.callAsync("mkdir", [target, opts.mode, opts.recursive], {
    callback: (error, value) => callback(error, error ? undefined : mapCreated(value)),
  });
}

function mkdirSync(pathValue, options) {
  const opts = mkdirOptions(options);
  const target = internal.toPath(pathValue);
  if (opts.recursive) checkRecursiveTarget(target);
  return mapCreated(internal.sync("mkdir", [target, opts.mode, opts.recursive]));
}

function decodeStringResult(value, encoding) {
  return encoding === "buffer" ? Buffer.from(value) : value;
}

function mkdtempOptions(options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts === "string") return { encoding: fileEncoding(opts) };
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding:
      opts.encoding === undefined || opts.encoding === null
        ? "utf8"
        : fileEncoding(opts.encoding),
  };
}

function mkdtemp(prefix, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = mkdtempOptions(options);
  internal.callAsync("mkdtemp", [internal.toPath(prefix, "prefix")], {
    callback: (error, value) =>
      callback(error, error ? undefined : decodeStringResult(value, opts.encoding)),
  });
}

function mkdtempSync(prefix, options) {
  const opts = mkdtempOptions(options);
  return decodeStringResult(internal.sync("mkdtemp", [internal.toPath(prefix, "prefix")]), opts.encoding);
}

// --- readdir / opendir -----------------------------------------------------------------------

function dirEncoding(encoding) {
  if (encoding === "buffer") return "buffer";
  return internal.normalizeEncoding(encoding);
}

function readdirOptions(options) {
  if (typeof options === "string") {
    return { encoding: dirEncoding(options), withFileTypes: false, recursive: false };
  }
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding: opts.encoding === undefined ? "utf8" : dirEncoding(opts.encoding),
    withFileTypes: opts.withFileTypes === true,
    recursive: opts.recursive === true,
  };
}

function entryValue(entry, encoding, parentPath, withFileTypes, displayName) {
  const name = encoding === "buffer" ? Buffer.from(entry.name, "utf8") : entry.name;
  if (withFileTypes) return new Dirent(name, entry.kind, parentPath);
  const label = displayName === undefined ? entry.name : displayName;
  return encoding === "buffer" ? Buffer.from(label, "utf8") : label;
}

function readdirSync(pathValue, options) {
  const opts = readdirOptions(options);
  const target = internal.toPath(pathValue);
  const result = [];
  function walk(directory, relative, parentPath) {
    const entries = internal.sync("readdir", [directory, true]);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const rel = relative === "" ? entry.name : path().join(relative, entry.name);
      const childParent = relative === "" ? parentPath : path().join(parentPath, relative);
      result.push(entryValue(entry, opts.encoding, childParent, opts.withFileTypes, rel));
      if (opts.recursive && entry.kind === constants.UV_DIRENT_DIR) {
        walk(path().join(directory, entry.name), rel, parentPath);
      }
    }
  }
  walk(target, "", target);
  return result;
}

function readdir(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = readdirOptions(options);
  const target = internal.toPath(pathValue);
  if (!opts.recursive) {
    internal.callAsync("readdir", [target, true], {
      callback: (error, entries) => {
        if (error) {
          callback(error);
          return;
        }
        const result = [];
        for (let index = 0; index < entries.length; index++) {
          result.push(entryValue(entries[index], opts.encoding, target, opts.withFileTypes));
        }
        callback(null, result);
      },
    });
    return;
  }
  const result = [];
  function walk(directory, relative, parentPath) {
    return internal.promise("readdir", [directory, true]).then((entries) => {
      let chain = Promise.resolve();
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const rel = relative === "" ? entry.name : path().join(relative, entry.name);
        const childParent = relative === "" ? parentPath : path().join(parentPath, relative);
        result.push(entryValue(entry, opts.encoding, childParent, opts.withFileTypes, rel));
        if (entry.kind === constants.UV_DIRENT_DIR) {
          const name = entry.name;
          chain = chain.then(() =>
            walk(path().join(directory, name), rel, parentPath),
          );
        }
      }
      return chain;
    });
  }
  walk(target, "", target).then(
    () => deliver(callback, null, result),
    (error) => deliver(callback, internal.normalizeError(error)),
  );
}

function opendirSync(pathValue, options) {
  const opts = readdirOptions(options);
  const target = internal.toPath(pathValue);
  const entries = internal.sync("readdir", [target, true]);
  const dirents = [];
  for (let index = 0; index < entries.length; index++) {
    dirents.push(entryValue(entries[index], opts.encoding, target, true));
  }
  return new Dir(target, dirents);
}

function opendir(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = readdirOptions(options);
  const target = internal.toPath(pathValue);
  internal.callAsync("readdir", [target, true], {
    callback: (error, entries) => {
      if (error) {
        callback(error);
        return;
      }
      const dirents = [];
      for (let index = 0; index < entries.length; index++) {
        dirents.push(entryValue(entries[index], opts.encoding, target, true));
      }
      callback(null, new Dir(target, dirents));
    },
  });
}

// --- stat family -----------------------------------------------------------------------------

function statFrom(raw) {
  return internal.makeStats(raw);
}

function stat(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  validateBigintOption(options);
  internal.callAsync("stat", [internal.toPath(pathValue)], {
    callback: (error, value) => callback(error, error ? undefined : statFrom(value)),
  });
}

function statSync(pathValue, options) {
  const opts = options === undefined || options === null ? {} : options;
  validateBigintOption(opts);
  try {
    return statFrom(internal.sync("stat", [internal.toPath(pathValue)]));
  } catch (error) {
    if (opts.throwIfNoEntry === false && error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function lstat(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  validateBigintOption(options);
  internal.callAsync("lstat", [internal.toPath(pathValue)], {
    callback: (error, value) => callback(error, error ? undefined : statFrom(value)),
  });
}

function lstatSync(pathValue, options) {
  const opts = options === undefined || options === null ? {} : options;
  validateBigintOption(opts);
  try {
    return statFrom(internal.sync("lstat", [internal.toPath(pathValue)]));
  } catch (error) {
    if (opts.throwIfNoEntry === false && error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function fstat(fd, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  validateBigintOption(options);
  const value = validateFd(fd);
  internal.callAsync("fstat", [value], {
    callback: (error, raw) => callback(error, error ? undefined : statFrom(raw)),
  });
}

function fstatSync(fd, options) {
  validateBigintOption(options);
  return statFrom(internal.sync("fstat", [validateFd(fd)]));
}

// --- access / chmod / chown ------------------------------------------------------------------

function accessMode(mode) {
  if (mode === undefined || mode === null) return constants.F_OK;
  if (typeof mode !== "number" || !Number.isInteger(mode)) {
    throw internal.invalidArgType("mode", "integer", mode);
  }
  if (mode < 0 || mode > 7) throw internal.outOfRange("mode", ">= 0 && <= 7", mode);
  return mode;
}

function access(pathValue, mode, callback) {
  if (typeof mode === "function") {
    callback = mode;
    mode = undefined;
  }
  checkCallback(callback);
  const value = accessMode(mode);
  internal.callAsync("access", [internal.toPath(pathValue), value], {
    callback: (error) => callback(error),
  });
}

function accessSync(pathValue, mode) {
  internal.sync("access", [internal.toPath(pathValue), accessMode(mode)]);
}

function chmod(pathValue, mode, callback) {
  checkCallback(callback);
  const value = requiredMode(mode);
  internal.callAsync("chmod", [internal.toPath(pathValue), value, true], {
    callback: (error) => callback(error),
  });
}

function chmodSync(pathValue, mode) {
  internal.sync("chmod", [internal.toPath(pathValue), requiredMode(mode), true]);
}

function parseId(value, name) {
  if (value === undefined || value === null) throw internal.invalidArgType(name, "integer", value);
  return internal.validateInteger(value, name, 0, 4294967295);
}

function chown(pathValue, uid, gid, callback) {
  checkCallback(callback);
  const userId = parseId(uid, "uid");
  const groupId = parseId(gid, "gid");
  internal.callAsync("chown", [internal.toPath(pathValue), userId, groupId, true], {
    callback: (error) => callback(error),
  });
}

function chownSync(pathValue, uid, gid) {
  internal.sync("chown", [internal.toPath(pathValue), parseId(uid, "uid"), parseId(gid, "gid"), true]);
}

// --- truncate family -------------------------------------------------------------------------

function validateLength(value) {
  return internal.validateInteger(value, "len", 0, Number.MAX_SAFE_INTEGER);
}

function truncate(pathValue, len, callback) {
  checkCallback(callback);
  internal.callAsync("truncate", [internal.toPath(pathValue), validateLength(len)], {
    callback: (error) => callback(error),
  });
}

function truncateSync(pathValue, len) {
  internal.sync("truncate", [internal.toPath(pathValue), validateLength(len)]);
}

function ftruncate(fd, len, callback) {
  checkCallback(callback);
  internal.callAsync("ftruncate", [validateFd(fd), validateLength(len)], {
    callback: (error) => callback(error),
  });
}

function ftruncateSync(fd, len) {
  internal.sync("ftruncate", [validateFd(fd), validateLength(len)]);
}

// --- links / realpath / utimes ---------------------------------------------------------------

function fileEncoding(encoding) {
  if (encoding === "buffer") return "buffer";
  return internal.normalizeEncoding(encoding);
}

function readlinkOptions(options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts === "string") return { encoding: fileEncoding(opts) };
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding:
      opts.encoding === undefined || opts.encoding === null
        ? "utf8"
        : fileEncoding(opts.encoding),
  };
}

function readlinkResult(raw, encoding) {
  if (encoding === "buffer") return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return internal.decodeBytes(raw, encoding);
}

function readlink(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = readlinkOptions(options);
  internal.callAsync("readlink", [internal.toPath(pathValue)], {
    callback: (error, raw) => callback(error, error ? undefined : readlinkResult(raw, opts.encoding)),
  });
}

function readlinkSync(pathValue, options) {
  const opts = readlinkOptions(options);
  return readlinkResult(internal.sync("readlink", [internal.toPath(pathValue)]), opts.encoding);
}

function symlinkType(type) {
  if (type === undefined || type === null) return undefined;
  if (typeof type !== "string") throw internal.invalidArgType("type", "string", type);
  if (type !== "dir" && type !== "file" && type !== "junction") {
    throw internal.invalidArgValue("type", type, "must be one of 'dir', 'file', or 'junction'");
  }
  return type;
}

function symlink(target, pathValue, type, callback) {
  if (typeof type === "function") {
    callback = type;
    type = undefined;
  }
  checkCallback(callback);
  symlinkType(type);
  const link = internal.toPath(pathValue);
  internal.callAsync("symlink", [internal.toPath(target, "target"), link], {
    callback: (error) => {
      if (error) internal.withDest(error, link);
      callback(error);
    },
  });
}

function symlinkSync(target, pathValue, type) {
  symlinkType(type);
  const link = internal.toPath(pathValue);
  try {
    internal.sync("symlink", [internal.toPath(target, "target"), link]);
  } catch (error) {
    throw internal.withDest(error, link);
  }
}

function link(existingPath, newPath, callback) {
  checkCallback(callback);
  const link = internal.toPath(newPath, "newPath");
  internal.callAsync("link", [internal.toPath(existingPath, "existingPath"), link], {
    callback: (error) => {
      if (error) internal.withDest(error, link);
      callback(error);
    },
  });
}

function linkSync(existingPath, newPath) {
  const link = internal.toPath(newPath, "newPath");
  try {
    internal.sync("link", [internal.toPath(existingPath, "existingPath"), link]);
  } catch (error) {
    throw internal.withDest(error, link);
  }
}

function realpathOptions(options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts === "string") return { encoding: fileEncoding(opts) };
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    encoding:
      opts.encoding === undefined || opts.encoding === null
        ? "utf8"
        : fileEncoding(opts.encoding),
  };
}

function realpathResult(value, encoding) {
  return encoding === "buffer" ? Buffer.from(value) : value;
}

function realpath(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = realpathOptions(options);
  internal.callAsync("realpath", [internal.toPath(pathValue)], {
    callback: (error, value) =>
      callback(error, error ? undefined : realpathResult(value, opts.encoding)),
  });
}

function realpathSync(pathValue, options) {
  const opts = realpathOptions(options);
  return realpathResult(internal.sync("realpath", [internal.toPath(pathValue)]), opts.encoding);
}

// `realpath.native` is a distinct function object in Node, not the same reference.
function realpathNative(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = realpathOptions(options);
  internal.callAsync("realpath", [internal.toPath(pathValue)], {
    callback: (error, value) =>
      callback(error, error ? undefined : realpathResult(value, opts.encoding)),
  });
}

function realpathSyncNative(pathValue, options) {
  const opts = realpathOptions(options);
  return realpathResult(internal.sync("realpath", [internal.toPath(pathValue)]), opts.encoding);
}

function utimes(pathValue, atime, mtime, callback) {
  checkCallback(callback);
  if (atime === undefined || atime === null) {
    throw internal.invalidArgType("atime", "number, string, or Date", atime);
  }
  if (mtime === undefined || mtime === null) {
    throw internal.invalidArgType("mtime", "number, string, or Date", mtime);
  }
  internal.callAsync(
    "utimes",
    [internal.toPath(pathValue), internal.toUnixTimestamp(atime), internal.toUnixTimestamp(mtime), true],
    { callback: (error) => callback(error) },
  );
}

function utimesSync(pathValue, atime, mtime) {
  if (atime === undefined || atime === null) {
    throw internal.invalidArgType("atime", "number, string, or Date", atime);
  }
  if (mtime === undefined || mtime === null) {
    throw internal.invalidArgType("mtime", "number, string, or Date", mtime);
  }
  internal.sync("utimes", [
    internal.toPath(pathValue),
    internal.toUnixTimestamp(atime),
    internal.toUnixTimestamp(mtime),
    true,
  ]);
}

// --- open / close / read / write -------------------------------------------------------------

function open(pathValue, flags, mode, callback) {
  if (typeof flags === "function") {
    callback = flags;
    flags = undefined;
    mode = undefined;
  } else if (typeof mode === "function") {
    callback = mode;
    mode = undefined;
  }
  checkCallback(callback);
  const target = internal.toPath(pathValue);
  const openFlags = internal.normalizeFlags(flags);
  const openMode = mode === undefined ? 0o666 : internal.parseFileMode(mode, "mode", 0o666);
  internal.callAsync("open", [target, openFlags, openMode], {
    callback: (error, fd) => {
      if (!error) internal.trackOpen(fd);
      callback(error, fd);
    },
  });
}

function openSync(pathValue, flags, mode) {
  const fd = internal.sync("open", [
    internal.toPath(pathValue),
    internal.normalizeFlags(flags),
    mode === undefined ? 0o666 : internal.parseFileMode(mode, "mode", 0o666),
  ]);
  internal.trackOpen(fd);
  return fd;
}

function close(fd, callback) {
  checkCallback(callback);
  const value = validateFd(fd);
  const closed = internal.closedFdError(value, "close");
  if (closed !== null) {
    process.nextTick(() => callback(closed));
    return;
  }
  internal.callAsync("close", [value], {
    callback: (error) => {
      if (!error) internal.trackClose(value);
      callback(error);
    },
  });
}

function closeSync(fd) {
  const value = validateFd(fd);
  const closed = internal.closedFdError(value, "close");
  if (closed !== null) throw closed;
  internal.sync("close", [value]);
  internal.trackClose(value);
}

function parseReadArgs(fd, buffer, offset, length, position, allowOptions) {
  const value = validateFd(fd);
  const optionsObject = buffer !== null && typeof buffer === "object" && !ArrayBuffer.isView(buffer);
  if (optionsObject && allowOptions === false) {
    throw internal.invalidArgType("buffer", "Buffer, TypedArray, or DataView", buffer);
  }
  let target;
  let opts;
  if (buffer === undefined || buffer === null) {
    if (allowOptions === false) {
      throw internal.invalidArgType("buffer", "Buffer, TypedArray, or DataView", buffer);
    }
    target = Buffer.alloc(16384);
    opts = { offset: 0, length: 16384, position: undefined };
  } else if (buffer instanceof Uint8Array || ArrayBuffer.isView(buffer)) {
    target = buffer instanceof Uint8Array ? buffer : internal.asUint8Array(buffer, "buffer");
    opts = { offset, length, position };
  } else if (typeof buffer === "object") {
    opts = buffer;
    target = opts.buffer === undefined ? Buffer.alloc(16384) : internal.asUint8Array(opts.buffer, "buffer");
  } else {
    throw internal.invalidArgType("buffer", "Buffer, TypedArray, or DataView", buffer);
  }
  const window = internal.validateOffsetLength(target, opts.offset, opts.length);
  return {
    fd: value,
    buffer: target,
    offset: window.offset,
    length: window.length,
    position: internal.validatePosition(opts.position),
  };
}

function read(fd, buffer, offset, length, position, callback) {
  if (typeof buffer === "function") {
    callback = buffer;
    buffer = undefined;
    offset = undefined;
    length = undefined;
    position = undefined;
  } else if (typeof offset === "function") {
    callback = offset;
    offset = undefined;
    length = undefined;
    position = undefined;
  } else if (typeof length === "function") {
    callback = length;
    length = undefined;
    position = undefined;
  } else if (typeof position === "function") {
    callback = position;
    position = undefined;
  }
  checkCallback(callback);
  const parsed = parseReadArgs(fd, buffer, offset, length, position);
  if (parsed.length === 0) {
    process.nextTick(() => callback(null, 0, parsed.buffer));
    return;
  }
  internal.callAsync("read", [parsed.fd, parsed.length, parsed.position], {
    callback: (error, bytes) => {
      if (error) {
        callback(error);
        return;
      }
      const count = internal.copyInto(bytes, parsed.buffer, parsed.offset);
      callback(null, count, parsed.buffer);
    },
  });
}

function readSync(fd, buffer, offset, length, position) {
  const parsed = parseReadArgs(fd, buffer, offset, length, position, false);
  const bytes = internal.sync("read", [parsed.fd, parsed.length, parsed.position]);
  return internal.copyInto(bytes, parsed.buffer, parsed.offset);
}

function write(fd, data, arg3, arg4, arg5, callback) {
  if (typeof arg5 === "function") {
    callback = arg5;
    arg5 = undefined;
  } else if (typeof arg4 === "function") {
    callback = arg4;
    arg4 = undefined;
    arg5 = undefined;
  } else if (typeof arg3 === "function") {
    callback = arg3;
    arg3 = undefined;
    arg4 = undefined;
    arg5 = undefined;
  }
  checkCallback(callback);
  const value = validateFd(fd);
  if (typeof data === "string") {
    let position = arg3;
    let encoding = arg4;
    if (typeof arg3 === "string") {
      encoding = arg3;
      position = undefined;
    }
    const bytes = Buffer.from(data, encoding === undefined ? "utf8" : internal.normalizeEncoding(encoding));
    internal.callAsync("write", [value, bytes, internal.validatePosition(position)], {
      callback: (error, written) => callback(error, written, data),
    });
    return;
  }
  const buffer = internal.asUint8Array(data, "buffer");
  const window = internal.validateOffsetLength(buffer, arg3, arg4);
  const position = internal.validatePosition(arg5);
  const bytes = buffer.subarray(window.offset, window.offset + window.length);
  internal.callAsync("write", [value, bytes, position], {
    callback: (error, written) => callback(error, written, buffer),
  });
}

function writeSync(fd, data, arg3, arg4, arg5) {
  const value = validateFd(fd);
  if (typeof data === "string") {
    let position = arg3;
    let encoding = arg4;
    if (typeof arg3 === "string") {
      encoding = arg3;
      position = undefined;
    }
    const bytes = Buffer.from(
      data,
      encoding === undefined ? "utf8" : internal.normalizeEncoding(encoding),
    );
    return internal.sync("write", [value, bytes, internal.validatePosition(position)]);
  }
  const buffer = internal.asUint8Array(data, "buffer");
  const window = internal.validateOffsetLength(buffer, arg3, arg4);
  const position = internal.validatePosition(arg5);
  const bytes = buffer.subarray(window.offset, window.offset + window.length);
  return internal.sync("write", [value, bytes, position]);
}

function distributeRead(bytes, buffers) {
  let read = 0;
  for (let index = 0; index < buffers.length && read < bytes.length; index++) {
    read += internal.copyInto(bytes.subarray(read), buffers[index], 0);
  }
  return read;
}

function readv(fd, buffers, position, callback) {
  if (typeof position === "function") {
    callback = position;
    position = undefined;
  }
  checkCallback(callback);
  const value = validateFd(fd);
  const list = internal.validateBuffers(buffers);
  const pos = internal.validatePosition(position);
  let total = 0;
  for (let index = 0; index < list.length; index++) total += list[index].length;
  if (total === 0) {
    process.nextTick(() => callback(null, 0, list));
    return;
  }
  internal.callAsync("read", [value, total, pos], {
    callback: (error, bytes) => {
      if (error) {
        callback(error);
        return;
      }
      callback(null, distributeRead(bytes, list), list);
    },
  });
}

function readvSync(fd, buffers, position) {
  const value = validateFd(fd);
  const list = internal.validateBuffers(buffers);
  const pos = internal.validatePosition(position);
  let total = 0;
  for (let index = 0; index < list.length; index++) total += list[index].length;
  if (total === 0) return 0;
  const bytes = internal.sync("read", [value, total, pos]);
  return distributeRead(bytes, list);
}

function writev(fd, buffers, position, callback) {
  if (typeof position === "function") {
    callback = position;
    position = undefined;
  }
  checkCallback(callback);
  const value = validateFd(fd);
  const list = internal.validateBuffers(buffers);
  const pos = internal.validatePosition(position);
  let total = 0;
  for (let index = 0; index < list.length; index++) total += list[index].length;
  if (total === 0) {
    process.nextTick(() => callback(null, 0, list));
    return;
  }
  const combined = internal.concatBytes(list, total);
  internal.callAsync("write", [value, combined, pos], {
    callback: (error, written) => callback(error, written, list),
  });
}

function writevSync(fd, buffers, position) {
  const value = validateFd(fd);
  const list = internal.validateBuffers(buffers);
  const pos = internal.validatePosition(position);
  let total = 0;
  for (let index = 0; index < list.length; index++) total += list[index].length;
  if (total === 0) return 0;
  return internal.sync("write", [value, internal.concatBytes(list, total), pos]);
}

function fsync(fd, callback) {
  checkCallback(callback);
  internal.callAsync("fsync", [validateFd(fd)], { callback: (error) => callback(error) });
}

function fsyncSync(fd) {
  internal.sync("fsync", [validateFd(fd)]);
}

function fdatasync(fd, callback) {
  checkCallback(callback);
  internal.callAsync("fdatasync", [validateFd(fd)], { callback: (error) => callback(error) });
}

function fdatasyncSync(fd) {
  internal.sync("fdatasync", [validateFd(fd)]);
}

// --- rm / rmdir / unlink / rename ------------------------------------------------------------

function rmOptions(options) {
  const opts = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw internal.invalidArgType("options", "object", options);
  return {
    force: opts.force === true,
    recursive: opts.recursive === true,
    maxRetries: opts.maxRetries === undefined ? 0 : internal.validateInteger(opts.maxRetries, "options.maxRetries", 0, 2147483647),
    retryDelay: opts.retryDelay === undefined ? 0 : internal.validateInteger(opts.retryDelay, "options.retryDelay", 0, Number.MAX_SAFE_INTEGER),
  };
}

function rm(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = rmOptions(options);
  internal.callAsync(
    "rm",
    [internal.toPath(pathValue), opts.recursive, opts.force, opts.maxRetries, opts.retryDelay],
    { callback: (error) => callback(error) },
  );
}

function rmSync(pathValue, options) {
  const opts = rmOptions(options);
  internal.sync("rm", [
    internal.toPath(pathValue),
    opts.recursive,
    opts.force,
    opts.maxRetries,
    opts.retryDelay,
  ]);
}

function rmdir(pathValue, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  checkCallback(callback);
  const opts = options === undefined || options === null ? {} : options;
  internal.callAsync("rmdir", [internal.toPath(pathValue), opts.recursive === true], {
    callback: (error) => callback(error),
  });
}

function rmdirSync(pathValue, options) {
  const opts = options === undefined || options === null ? {} : options;
  internal.sync("rmdir", [internal.toPath(pathValue), opts.recursive === true]);
}

function unlink(pathValue, callback) {
  checkCallback(callback);
  internal.callAsync("unlink", [internal.toPath(pathValue)], {
    callback: (error) => callback(error),
  });
}

function unlinkSync(pathValue) {
  internal.sync("unlink", [internal.toPath(pathValue)]);
}

function rename(from, to, callback) {
  checkCallback(callback);
  const destination = internal.toPath(to, "newPath");
  internal.callAsync("rename", [internal.toPath(from, "oldPath"), destination], {
    callback: (error) => {
      if (error) internal.withDest(error, destination);
      callback(error);
    },
  });
}

function renameSync(from, to) {
  const destination = internal.toPath(to, "newPath");
  try {
    internal.sync("rename", [internal.toPath(from, "oldPath"), destination]);
  } catch (error) {
    throw internal.withDest(error, destination);
  }
}

// --- exists ----------------------------------------------------------------------------------

function exists(pathValue, callback) {
  if (typeof callback !== "function") throw internal.invalidArgType("cb", "function", callback);
  let target;
  try {
    target = internal.toPath(pathValue);
  } catch (_) {
    process.nextTick(() => callback(false));
    return;
  }
  internal.callAsync("access", [target, constants.F_OK], {
    callback: (error) => callback(!error),
  });
}

function existsSync(pathValue) {
  try {
    const target = internal.toPath(pathValue);
    internal.sync("access", [target, constants.F_OK]);
    return true;
  } catch (_) {
    return false;
  }
}

// --- polling watchers ------------------------------------------------------------------------

const kWatchState = Symbol("lite.fs.watchState");

function statSignature(stat) {
  return [
    stat.mtimeMs,
    stat.ctimeMs,
    stat.size,
    stat.mode,
    stat.ino,
    stat.nlink,
    stat.uid,
    stat.gid,
  ].join(":");
}

function statChanged(previous, current) {
  return statSignature(previous) !== statSignature(current);
}

function zeroStats() {
  return new Stats(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

class StatWatcher extends EventEmitter {
  constructor(filename, interval, persistent) {
    super();
    const self = this;
    Object.defineProperty(this, kWatchState, {
      value: {
        filename,
        interval,
        persistent,
        timer: null,
        previous: null,
        missing: false,
        closed: false,
      },
      enumerable: false,
    });
    // The first poll runs on the first interval tick: a missing watched path emits its zeroed
    // Stats only after the listener has been attached (Node does the same).
    this._timer = setInterval(() => self._poll(), interval);
    if (!persistent) this._timer.unref();
  }

  _poll() {
    const state = this[kWatchState];
    if (state.closed) return;
    let current = null;
    try {
      current = statFrom(internal.sync("stat", [state.filename]));
    } catch (_) {
      current = null;
    }
    if (current === null) {
      // Node reports a missing file with a zeroed Stats and then waits for it to appear (or
      // reports the deletion of a watched file the same way).
      if (state.missing) return;
      const missing = zeroStats();
      const previous = state.previous === null ? missing : state.previous;
      state.previous = missing;
      state.missing = true;
      this.emit("change", missing, previous);
      return;
    }
    if (state.previous === null) {
      state.previous = current;
      return;
    }
    if (state.missing) {
      const previous = state.previous;
      state.previous = current;
      state.missing = false;
      this.emit("change", current, previous);
      return;
    }
    if (statChanged(state.previous, current)) {
      const previous = state.previous;
      state.previous = current;
      this.emit("change", current, previous);
    }
  }

  close() {
    const state = this[kWatchState];
    if (state.closed) return;
    state.closed = true;
    if (this._timer !== undefined) clearInterval(this._timer);
    this.emit("stop");
  }

  ref() {
    if (this._timer !== undefined) this._timer.ref();
    return this;
  }

  unref() {
    if (this._timer !== undefined) this._timer.unref();
    return this;
  }
}

const statWatchers = new Map();

function watchFile(filename, options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }
  if (typeof listener !== "function") {
    throw internal.invalidArgType("listener", "function", listener);
  }
  const target = internal.toPath(filename);
  const opts = options === undefined || options === null ? {} : options;
  const interval =
    opts.interval === undefined
      ? 5007
      : internal.validateInteger(opts.interval, "options.interval", 0, Number.MAX_SAFE_INTEGER);
  const existing = statWatchers.get(target);
  if (existing !== undefined) {
    existing.on("change", listener);
    return existing;
  }
  const watcher = new StatWatcher(target, interval, opts.persistent !== false);
  watcher.on("change", listener);
  statWatchers.set(target, watcher);
  return watcher;
}

function unwatchFile(filename, listener) {
  const target = internal.toPath(filename);
  const watcher = statWatchers.get(target);
  if (watcher === undefined) return;
  if (typeof listener === "function") {
    watcher.removeListener("change", listener);
    if (watcher.listenerCount("change") === 0) {
      watcher.close();
      statWatchers.delete(target);
    }
    return;
  }
  watcher.close();
  statWatchers.delete(target);
}

// One polled snapshot of a path. Directories are expanded one level (or fully for
// `recursive`); symlinks are not descended, matching D3's polling watcher.
function snapshotOf(target, recursive) {
  const map = new Map();
  function add(absolute, relative) {
    let stat;
    try {
      stat = internal.sync("lstat", [absolute]);
    } catch (_) {
      return false;
    }
    map.set(relative, statSignature(statFrom(stat)) + ":" + kindOf(stat));
    return true;
  }
  function walk(directory, relative) {
    let entries;
    try {
      entries = internal.sync("readdir", [directory, true]);
    } catch (_) {
      return;
    }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const childRelative = relative === "" ? entry.name : relative + "/" + entry.name;
      const childAbsolute = path().join(directory, entry.name);
      add(childAbsolute, childRelative);
      if (recursive && entry.kind === constants.UV_DIRENT_DIR) {
        walk(childAbsolute, childRelative);
      }
    }
  }
  let root = null;
  try {
    root = internal.makeStats(internal.sync("lstat", [target]));
  } catch (_) {
    return map;
  }
  if (root.isDirectory()) walk(target, "");
  else map.set("", statSignature(root) + ":file");
  return map;
}

function kindOf(stat) {
  const value = stat.mode;
  if ((value & constants.S_IFMT) === constants.S_IFDIR) return "dir";
  if ((value & constants.S_IFMT) === constants.S_IFLNK) return "link";
  return "file";
}

class FSWatcher extends EventEmitter {
  constructor(filename, options, listener) {
    super();
    const opts = options === undefined || options === null ? {} : options;
    const interval =
      opts.interval === undefined
        ? 1000
        : internal.validateInteger(opts.interval, "options.interval", 1, Number.MAX_SAFE_INTEGER);
    const recursive = opts.recursive === true;
    // Node throws ENOENT synchronously when the watched path does not exist.
    internal.sync("lstat", [filename]);
    const state = {
      filename,
      interval,
      recursive,
      persistent: opts.persistent !== false,
      closed: false,
      timer: null,
      snapshot: snapshotOf(filename, recursive),
    };
    Object.defineProperty(this, kWatchState, { value: state, enumerable: false });
    if (typeof listener === "function") this.on("change", listener);
    const self = this;
    state.timer = setInterval(() => self._poll(), interval);
    this._timer = state.timer;
    if (!state.persistent) state.timer.unref();
  }

  _poll() {
    const state = this[kWatchState];
    if (state.closed) return;
    const next = snapshotOf(state.filename, state.recursive);
    const previous = state.snapshot;
    state.snapshot = next;
    const changes = [];
    for (const [name, signature] of next) {
      if (!previous.has(name)) changes.push(["rename", name]);
      else if (previous.get(name) !== signature) changes.push(["change", name]);
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) changes.push(["rename", name]);
    }
    for (let index = 0; index < changes.length; index++) {
      const name = changes[index][1];
      const label = name === "" ? path().basename(state.filename) : name;
      this.emit("change", changes[index][0], label);
    }
  }

  close() {
    const state = this[kWatchState];
    if (state.closed) return;
    state.closed = true;
    clearInterval(state.timer);
    this.emit("close");
  }

  ref() {
    const state = this[kWatchState];
    if (state.timer !== null) state.timer.ref();
    return this;
  }

  unref() {
    const state = this[kWatchState];
    if (state.timer !== null) state.timer.unref();
    return this;
  }
}

function watch(filename, options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }
  const target = internal.toPath(filename);
  return new FSWatcher(target, options, listener);
}

// --- streams ---------------------------------------------------------------------------------

function createReadStream(pathValue, options) {
  return internal.createReadStream(pathValue, options);
}

function createWriteStream(pathValue, options) {
  return internal.createWriteStream(pathValue, options);
}

// --- promises getter -------------------------------------------------------------------------

let promisesModule = null;
function loadPromises() {
  if (promisesModule === null) {
    promisesModule = EMBEDDED ? require("fs/promises") : require("./fs-promises.js");
  }
  return promisesModule;
}

// --- exports ---------------------------------------------------------------------------------

const fs = {
  // classes
  Stats,
  Dirent,
  Dir,
  ReadStream: internal.ReadStream,
  WriteStream: internal.WriteStream,
  FileReadStream: internal.ReadStream,
  FileWriteStream: internal.WriteStream,
  constants,

  // files
  readFile,
  readFileSync,
  writeFile,
  writeFileSync,
  appendFile,
  appendFileSync,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  readdir,
  readdirSync,
  opendir,
  opendirSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  unlink,
  unlinkSync,
  rename,
  renameSync,
  readlink,
  readlinkSync,
  symlink,
  symlinkSync,
  link,
  linkSync,
  realpath,
  realpathSync,
  utimes,
  utimesSync,
  truncate,
  truncateSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  access,
  accessSync,
  stat,
  statSync,
  lstat,
  lstatSync,
  fstat,
  fstatSync,

  // descriptors
  open,
  openSync,
  close,
  closeSync,
  read,
  readSync,
  write,
  writeSync,
  readv,
  readvSync,
  writev,
  writevSync,
  fsync,
  fsyncSync,
  fdatasync,
  fdatasyncSync,
  ftruncate,
  ftruncateSync,

  // predicates and watchers
  exists,
  existsSync,
  watchFile,
  unwatchFile,
  watch,

  // streams
  createReadStream,
  createWriteStream,
};

realpath.native = realpathNative;
realpathSync.native = realpathSyncNative;
fs.realpath = realpath;
fs.realpathSync = realpathSync;

Object.defineProperty(fs, "promises", {
  enumerable: true,
  configurable: true,
  get: loadPromises,
});

module.exports = fs;
