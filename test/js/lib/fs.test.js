"use strict";

// Self-check for `js/lib/fs.js` (sync + callback). Runtime-agnostic in the sense that plain
// Node skips it: the host primitives only exist under lite, and the point of the test is the
// syscall surface, not a Node shim.
//
//   ./target/debug/lite test/js/lib/fs.test.js
//
// Scratch files live in a `mkdtemp` directory under the OS temp dir. Nothing absolute is ever
// printed: failures name the assertion, not a path.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

// Prefer the registered builtin (the real path users take); fall back to the file for a
// checkout run before the registry entry exists.
let fs;
try {
  fs = require("fs");
} catch (_) {
  fs = require("../../../js/lib/fs.js");
}
const os = require("os");
const path = require("path");

let passed = 0;
let failed = 0;
const failures = [];

function record(condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(detail);
  }
}

function ok(value, message) {
  record(Boolean(value), `${message} (expected truthy, got ${String(value)})`);
}

function eq(actual, expected, message) {
  record(
    actual === expected,
    `${message} (expected ${String(expected)}, got ${String(actual)})`,
  );
}

function throwsCode(fn, code, message) {
  try {
    fn();
    record(false, `${message} (expected a throw)`);
    return undefined;
  } catch (error) {
    record(
      error !== null && typeof error === "object" && error.code === code,
      `${message} (code was ${error && error.code})`,
    );
    return error;
  }
}

function basename(value) {
  return value === undefined || value === null ? String(value) : path.basename(String(value));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lite-fs-"));
const file = path.join(dir, "a.txt");

// ---------------------------------------------------------------------------------------------
// Surface

eq(typeof fs.readFileSync, "function", "readFileSync is a function");
eq(typeof fs.writeFileSync, "function", "writeFileSync is a function");
eq(typeof fs.cpSync, "function", "cpSync is a function");
eq(typeof fs.watchFile, "function", "watchFile is a function");
eq(typeof fs.createReadStream, "function", "createReadStream is a function");
eq(typeof fs.ReadStream, "function", "ReadStream class is exported");
eq(typeof fs.Stats, "function", "Stats class is exported");
eq(typeof fs.Dirent, "function", "Dirent class is exported");
eq(typeof fs.Dir, "function", "Dir class is exported");
eq(typeof fs.constants, "object", "constants is an object");
eq(fs.constants.O_RDONLY, 0, "O_RDONLY is 0");
eq(fs.constants.F_OK, 0, "F_OK is 0");
eq(fs.constants.COPYFILE_EXCL, 1, "COPYFILE_EXCL is 1");
eq(fs.constants.UV_FS_O_FILEMAP, undefined, "UV_FS_O_FILEMAP is absent");
eq(typeof fs.realpath.native, "function", "realpath.native exists");
ok(fs.realpath.native !== fs.realpath, "realpath.native is a distinct function");
const promises = fs.promises;
eq(typeof promises.readFile, "function", "fs.promises is the promise surface");
eq(promises.constants, fs.constants, "fs.promises.constants is fs.constants");

// ---------------------------------------------------------------------------------------------
// read / write / append

fs.writeFileSync(file, "hello");
eq(fs.readFileSync(file, "utf8"), "hello", "readFileSync decodes with an encoding string");
ok(Buffer.isBuffer(fs.readFileSync(file)), "readFileSync returns a Buffer without encoding");
eq(fs.readFileSync(file, { encoding: "utf8" }), "hello", "readFileSync accepts an options object");
eq(fs.readFileSync(file, { flag: "r" }).length, 5, "readFileSync accepts a flag option");

fs.writeFileSync(file, Buffer.from("bytes"));
eq(fs.readFileSync(file, "utf8"), "bytes", "writeFileSync accepts a Buffer");

fs.appendFileSync(file, "!");
eq(fs.readFileSync(file, "utf8"), "bytes!", "appendFileSync appends");

const missing = throwsCode(
  () => fs.readFileSync(path.join(dir, "missing.txt")),
  "ENOENT",
  "readFileSync ENOENT is reproducible",
);
ok(missing.errno < 0, "ENOENT errno is negative");
eq(missing.syscall, "open", "ENOENT syscall is open");
eq(basename(missing.path), "missing.txt", "ENOENT path is the requested path");

throwsCode(() => fs.readFileSync(dir), "EISDIR", "readFileSync on a directory throws EISDIR");
throwsCode(
  () => fs.writeFileSync(file, 123),
  "ERR_INVALID_ARG_TYPE",
  "writeFileSync rejects a non-buffer data argument",
);
throwsCode(
  () => fs.readFileSync(file, { encoding: "not-an-encoding" }),
  "ERR_INVALID_ARG_VALUE",
  "readFileSync rejects an unknown encoding",
);

// ---------------------------------------------------------------------------------------------
// mkdir / mkdtemp

const nested = path.join(dir, "one/two/three");
eq(fs.mkdirSync(nested, { recursive: true }), path.join(dir, "one"), "mkdirSync recursive returns the first created path");
eq(fs.mkdirSync(nested, { recursive: true }), undefined, "mkdirSync recursive returns undefined when it exists");
eq(fs.mkdirSync(path.join(dir, "plain")), undefined, "mkdirSync returns undefined unless recursive");
throwsCode(
  () => fs.mkdirSync(file, { recursive: true }),
  "EEXIST",
  "mkdirSync recursive on a file throws EEXIST",
);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lite-fs-tmp-"));
ok(path.basename(temp).startsWith("lite-fs-tmp-"), "mkdtempSync returns a path under the prefix");
ok(temp !== fs.mkdtempSync(path.join(os.tmpdir(), "lite-fs-tmp-")), "mkdtempSync is unique");
fs.rmSync(temp, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------
// readdir / opendir / Dirent

fs.writeFileSync(path.join(dir, "readme.md"), "");
fs.mkdirSync(path.join(dir, "subdir"));
fs.symlinkSync(file, path.join(dir, "link"));

const names = fs.readdirSync(dir).sort();
ok(names.includes("a.txt") && names.includes("readme.md"), "readdirSync returns names");
const dirents = fs.readdirSync(dir, { withFileTypes: true });
const byName = new Map(dirents.map((entry) => [entry.name, entry]));
eq(byName.get("a.txt").isFile(), true, "Dirent.isFile for a file");
eq(byName.get("subdir").isDirectory(), true, "Dirent.isDirectory for a directory");
eq(byName.get("link").isSymbolicLink(), true, "Dirent.isSymbolicLink for a symlink");
eq(byName.get("a.txt").parentPath, dir, "Dirent.parentPath is the directory");
eq(byName.get("a.txt") instanceof fs.Dirent, true, "readdir returns Dirent instances");

const recursiveNames = fs.readdirSync(dir, { recursive: true }).sort();
ok(recursiveNames.includes(path.join("one", "two", "three")), "readdirSync recursive returns relative paths");
ok(recursiveNames.includes(path.join("subdir")), "readdirSync recursive includes directories");

const iterated = fs.opendirSync(dir);
const first = iterated.readSync();
ok(first !== null && typeof first.name === "string", "Dir.readSync returns a Dirent");
eq(iterated.path, dir, "Dir.path is the opened path");
let remaining = 1;
while (iterated.readSync() !== null) remaining += 1;
eq(remaining, names.length, "Dir.readSync yields every entry");
eq(iterated.readSync(), null, "Dir.readSync returns null at the end");
iterated.closeSync();
throwsCode(() => iterated.readSync(), "ERR_DIR_CLOSED", "Dir.readSync after close throws ERR_DIR_CLOSED");

// ---------------------------------------------------------------------------------------------
// stat / lstat / fstat / access / chmod / truncate / utimes

const statOfFile = fs.statSync(file);
eq(statOfFile.isFile(), true, "statSync isFile");
ok(statOfFile.size > 0, "statSync size");
ok(statOfFile.atime instanceof Date, "Stats.atime is a Date");
ok(statOfFile.mtime instanceof Date, "Stats.mtime is a Date");
eq(fs.statSync(path.join(dir, "link")).isFile(), true, "statSync follows symlinks");
eq(fs.lstatSync(path.join(dir, "link")).isSymbolicLink(), true, "lstatSync does not follow symlinks");
eq(fs.statSync(path.join(dir, "nope"), { throwIfNoEntry: false }), undefined, "statSync throwIfNoEntry false returns undefined");
throwsCode(() => fs.statSync(path.join(dir, "nope")), "ENOENT", "statSync throws ENOENT");

const fd = fs.openSync(file, "r+");
const fstatValue = fs.fstatSync(fd);
eq(fstatValue.isFile(), true, "fstatSync reports a file");
fs.ftruncateSync(fd, 2);
eq(fs.fstatSync(fd).size, 2, "ftruncateSync truncates");
fs.closeSync(fd);

fs.accessSync(file);
throwsCode(() => fs.accessSync(path.join(dir, "missing-again")), "ENOENT", "accessSync throws ENOENT");
eq(fs.existsSync(file), true, "existsSync true for a file");
eq(fs.existsSync(path.join(dir, "missing-again")), false, "existsSync false for a missing path");

fs.chmodSync(file, 0o600);
eq(fs.statSync(file).mode & 0o777, 0o600, "chmodSync applies the mode");
fs.chmodSync(file, "644");
eq(fs.statSync(file).mode & 0o777, 0o644, "chmodSync accepts an octal string");

fs.utimesSync(file, 1000000, 2000000);
eq(Math.round(fs.statSync(file).mtimeMs / 1000), 2000000, "utimesSync applies seconds");
fs.utimesSync(file, new Date(3000000), new Date(4000000));
eq(Math.round(fs.statSync(file).mtimeMs / 1000), 4000, "utimesSync accepts Dates");

fs.writeFileSync(file, "0123456789");
fs.truncateSync(file, 4);
eq(fs.readFileSync(file, "utf8"), "0123", "truncateSync truncates a path");

// ---------------------------------------------------------------------------------------------
// open / read / write / readv / writev / fsync

fs.writeFileSync(file, "0123456789");
const readFd = fs.openSync(file, "r");
const target = Buffer.alloc(4);
const bytesRead = fs.readSync(readFd, target, 1, 2, 3);
eq(bytesRead, 2, "readSync returns the number of bytes read");
eq(target.toString("utf8", 1, 3), "34", "readSync copies into the caller buffer at offset");
eq(fs.readSync(readFd, Buffer.alloc(2), 0, 2, 100), 0, "readSync returns 0 at EOF");
fs.closeSync(readFd);

const writeFd = fs.openSync(file, "r+");
eq(fs.writeSync(writeFd, Buffer.from("XY"), 0, 2, 0), 2, "writeSync writes at a position");
eq(fs.writeSync(writeFd, "Z", 2), 1, "writeSync writes a string at a position");
fs.fsyncSync(writeFd);
eq(fs.readFileSync(file, "utf8").slice(0, 3), "XYZ", "written bytes are visible");
fs.closeSync(writeFd);

const vFd = fs.openSync(file, "r");
eq(fs.readvSync(vFd, [Buffer.alloc(2), Buffer.alloc(2)], 0), 4, "readvSync returns the byte count");
fs.closeSync(vFd);
const wvFd = fs.openSync(file, "r+");
eq(fs.writevSync(wvFd, [Buffer.from("AB")], 0), 2, "writevSync returns the byte count");
fs.closeSync(wvFd);

throwsCode(() => fs.closeSync(12345), "EBADF", "closeSync on an unknown descriptor throws EBADF");
const doubleFd = fs.openSync(file, "r");
fs.closeSync(doubleFd);
throwsCode(() => fs.closeSync(doubleFd), "EBADF", "closing an already closed descriptor throws EBADF");

// ---------------------------------------------------------------------------------------------
// links / realpath

const linkPath = path.join(dir, "hardlink");
fs.linkSync(file, linkPath);
eq(fs.readFileSync(linkPath, "utf8"), fs.readFileSync(file, "utf8"), "linkSync creates a hard link");

const symlinkPath = path.join(dir, "sym");
fs.symlinkSync(file, symlinkPath);
eq(fs.readlinkSync(symlinkPath), file, "readlinkSync returns the target");
eq(fs.readlinkSync(symlinkPath, { encoding: "buffer" }) instanceof Uint8Array, true, "readlinkSync encoding buffer returns bytes");
const resolved = fs.realpathSync(symlinkPath);
ok(path.isAbsolute(resolved), "realpathSync returns an absolute path");

// ---------------------------------------------------------------------------------------------
// copyFile / cp

const copySource = path.join(dir, "copy-source.txt");
const copyTarget = path.join(dir, "copy-target.txt");
fs.writeFileSync(copySource, "copy me");
fs.copyFileSync(copySource, copyTarget);
eq(fs.readFileSync(copyTarget, "utf8"), "copy me", "copyFileSync copies");
throwsCode(
  () => fs.copyFileSync(copySource, copyTarget, fs.constants.COPYFILE_EXCL),
  "EEXIST",
  "copyFileSync COPYFILE_EXCL refuses an existing destination",
);

const cpSource = path.join(dir, "cp-src");
fs.mkdirSync(path.join(cpSource, "inner"), { recursive: true });
fs.writeFileSync(path.join(cpSource, "inner", "x.txt"), "X");
const cpTarget = path.join(dir, "cp-dst");
fs.cpSync(cpSource, cpTarget, { recursive: true });
eq(fs.readFileSync(path.join(cpTarget, "inner", "x.txt"), "utf8"), "X", "cpSync copies recursively");
throwsCode(
  () => fs.cpSync(cpSource, path.join(cpSource, "inner", "self"), { recursive: true }),
  "ERR_FS_CP_EINVAL",
  "cpSync refuses to copy a directory into itself",
);

// ---------------------------------------------------------------------------------------------
// rm / rmdir / unlink / rename

const doomed = path.join(dir, "doomed");
fs.mkdirSync(doomed);
fs.rmdirSync(doomed);
eq(fs.existsSync(doomed), false, "rmdirSync removes an empty directory");
fs.writeFileSync(path.join(dir, "unlink-me"), "");
fs.unlinkSync(path.join(dir, "unlink-me"));
eq(fs.existsSync(path.join(dir, "unlink-me")), false, "unlinkSync removes a file");
fs.writeFileSync(path.join(dir, "old-name"), "x");
fs.renameSync(path.join(dir, "old-name"), path.join(dir, "new-name"));
eq(fs.readFileSync(path.join(dir, "new-name"), "utf8"), "x", "renameSync renames");

const tree = path.join(dir, "tree");
fs.mkdirSync(path.join(tree, "a"), { recursive: true });
fs.writeFileSync(path.join(tree, "a", "f"), "");
fs.rmSync(tree, { recursive: true, force: true });
eq(fs.existsSync(tree), false, "rmSync recursive removes a tree");
fs.rmSync(path.join(dir, "never-existed"), { force: true });

// ---------------------------------------------------------------------------------------------
// Dialogs: async callbacks, watchers, streams, abort. Everything below runs in one async main so
// the event loop can drive the completion dispatch.

async function asyncChecks() {
  // callback read: (err, bytesRead, buffer)
  fs.writeFileSync(file, "0123456789");
  await new Promise((resolve, reject) => {
    fs.open(file, "r", (openError, openedFd) => {
      if (openError) return reject(openError);
      fs.read(openedFd, Buffer.alloc(4), 0, 2, 2, (error, count, buffer) => {
        try {
          eq(error, null, "read callback error is null");
          eq(count, 2, "read callback bytesRead");
          eq(buffer.toString("utf8", 0, 2), "23", "read callback returns the buffer");
        } catch (failure) {
          return reject(failure);
        }
        fs.close(openedFd, () => resolve());
      });
    });
  });

  // callback write: (err, bytesWritten, buffer)
  await new Promise((resolve, reject) => {
    fs.open(file, "r+", (openError, openedFd) => {
      if (openError) return reject(openError);
      fs.write(openedFd, Buffer.from("AB"), 0, 2, 0, (error, count, buffer) => {
        try {
          eq(error, null, "write callback error is null");
          eq(count, 2, "write callback bytesWritten");
          eq(buffer instanceof Uint8Array, true, "write callback returns the buffer");
        } catch (failure) {
          return reject(failure);
        }
        fs.close(openedFd, () => resolve());
      });
    });
  });
  eq(fs.readFileSync(file, "utf8").slice(0, 2), "AB", "callback write lands");

  // callback readv/writev
  await new Promise((resolve, reject) => {
    fs.open(file, "r", (openError, openedFd) => {
      if (openError) return reject(openError);
      fs.readv(openedFd, [Buffer.alloc(2), Buffer.alloc(2)], 0, (error, count, buffers) => {
        try {
          eq(error, null, "readv callback error is null");
          eq(count, 4, "readv callback bytesRead");
          eq(buffers.length, 2, "readv callback returns the buffers");
        } catch (failure) {
          return reject(failure);
        }
        fs.close(openedFd, () => resolve());
      });
    });
  });

  // readdir async
  const asyncNames = await new Promise((resolve, reject) => {
    fs.readdir(dir, { withFileTypes: true }, (error, entries) => {
      if (error) return reject(error);
      resolve(entries);
    });
  });
  ok(asyncNames.some((entry) => entry.name === "a.txt" && entry.isFile()), "readdir callback with Dirents");

  // error delivery: invalid argument throws synchronously, syscall failure reaches the callback
  let threw = false;
  try {
    fs.readFile(file, 123, () => {});
  } catch (error) {
    threw = error && error.code === "ERR_INVALID_ARG_TYPE";
  }
  eq(threw, true, "callback form throws synchronously on a bad argument");
  let callbackError = null;
  await new Promise((resolve) => {
    fs.readFile(path.join(dir, "absent"), (error) => {
      callbackError = error;
      resolve();
    });
  });
  eq(callbackError && callbackError.code, "ENOENT", "callback form delivers ENOENT through the callback");

  // exists callback
  const existsResults = [];
  await new Promise((resolve) => fs.exists(file, (value) => { existsResults.push(value); resolve(); }));
  await new Promise((resolve) => fs.exists(path.join(dir, "absent"), (value) => { existsResults.push(value); resolve(); }));
  eq(existsResults.join(","), "true,false", "exists callback reports booleans");

  // stat callback
  const statValue = await new Promise((resolve, reject) => {
    fs.stat(file, (error, value) => (error ? reject(error) : resolve(value)));
  });
  eq(statValue.isFile(), true, "stat callback returns a Stats");

  // opendir callback
  const dirHandle = await new Promise((resolve, reject) => {
    fs.opendir(dir, (error, value) => (error ? reject(error) : resolve(value)));
  });
  ok((await dirHandle.read()) !== null, "opendir callback returns a readable Dir");
  await dirHandle.close();

  // streams
  fs.writeFileSync(file, "stream-body");
  const readChunks = [];
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { start: 0, end: 5 });
    stream.on("data", (chunk) => readChunks.push(chunk.toString()));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  eq(readChunks.join(""), "stream", "createReadStream honours start/end");
  ok(streamInstanceSeen(), "createReadStream returns a ReadStream");

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(path.join(dir, "stream-out.txt"));
    stream.on("error", reject);
    stream.on("close", resolve);
    stream.end("written-by-stream");
  });
  eq(fs.readFileSync(path.join(dir, "stream-out.txt"), "utf8"), "written-by-stream", "createWriteStream writes");

  // flow with a plain data listener (no manual read())
  fs.writeFileSync(path.join(dir, "stream-big.txt"), "x".repeat(200000));
  const big = await new Promise((resolve, reject) => {
    let text = "";
    const stream = fs.createReadStream(path.join(dir, "stream-big.txt"));
    stream.on("data", (chunk) => (text += chunk));
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
  eq(big.length, 200000, "createReadStream reads a multi-chunk file to the end");

  // watchFile / unwatchFile
  const watched = path.join(dir, "watched.txt");
  fs.writeFileSync(watched, "1");
  let changes = 0;
  fs.watchFile(watched, { interval: 10 }, () => {
    changes += 1;
  });
  await delay(30);
  fs.writeFileSync(watched, "22");
  await delay(100);
  fs.unwatchFile(watched);
  ok(changes > 0, "watchFile reports a change");
  const changesAfter = changes;
  fs.writeFileSync(watched, "333");
  await delay(60);
  eq(changes, changesAfter, "unwatchFile stops reporting");

  // watch
  const watched2 = path.join(dir, "watch-event.txt");
  fs.writeFileSync(watched2, "1");
  const event = await new Promise((resolve, reject) => {
    const watcher = fs.watch(watched2, { interval: 20 }, (eventType, name) => {
      watcher.close();
      resolve({ eventType, name });
    });
    watcher.on("error", reject);
    setTimeout(() => fs.writeFileSync(watched2, "changed"), 30);
  });
  eq(event.eventType === "change" || event.eventType === "rename", true, "fs.watch emits a change event");
  eq(path.basename(event.name), basename(watched2), "fs.watch reports the file name");

  // realpath.native callback form
  await new Promise((resolve, reject) => {
    fs.realpath.native(symlinkPath, (error, value) => {
      try {
        eq(error, null, "realpath.native callback error is null");
        eq(value, resolved, "realpath.native resolves the same path");
      } catch (failure) {
        return reject(failure);
      }
      resolve();
    });
  });

  // AbortSignal: promise form rejects with ABORT_ERR while the op is in flight
  fs.writeFileSync(path.join(dir, "big.txt"), "y".repeat(4 * 1024 * 1024));
  const controller = new AbortController();
  const aborted = fs.promises.readFile(path.join(dir, "big.txt"), { signal: controller.signal });
  controller.abort();
  let abortError = null;
  try {
    await aborted;
  } catch (error) {
    abortError = error;
  }
  eq(abortError && abortError.code, "ABORT_ERR", "AbortSignal rejects with ABORT_ERR");
  eq(abortError && abortError.name, "AbortError", "AbortSignal rejection is an AbortError");

  // callback form with an already-aborted signal
  const preAborted = new AbortController();
  preAborted.abort();
  const callbackAbort = await new Promise((resolve) => {
    fs.readFile(file, { signal: preAborted.signal }, (error) => resolve(error));
  });
  eq(callbackAbort && callbackAbort.code, "ABORT_ERR", "callback form delivers ABORT_ERR");

  // invalid callback
  throwsCode(() => fs.readFile(file, "utf8"), "ERR_INVALID_ARG_TYPE", "readFile without a callback throws");
}

function streamInstanceSeen() {
  const stream = fs.createReadStream(file);
  const result = stream instanceof fs.ReadStream;
  stream.destroy();
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finish() {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // A failed assertion may have removed part of the tree already.
  }
  if (failed > 0) {
    console.log(`${failed} failed, ${passed} passed`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok: ${passed} assertions`);
}

asyncChecks()
  .then(finish)
  .catch((error) => {
    console.log(`FAIL: ${error && error.stack ? error.stack.split("\n")[0] : String(error)}`);
    process.exitCode = 1;
  });
