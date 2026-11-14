"use strict";

// Self-check for `js/lib/fs-promises.js` (D35: the promise surface is a different API shape,
// not `promisify(fs)`).
//
//   ./target/debug/lite test/js/lib/fs-promises.test.js
//
// Plain Node skips: there is no host to call. Nothing absolute is printed.

if (typeof globalThis.__ln_host !== "object") {
  console.log("skip: lite host unavailable");
  process.exit(0);
}

// Prefer the registered builtins; fall back to the files for a pre-registry checkout run. Both
// modules must come from the same source so `constants` identity is the one users see.
let fsp;
let fs;
try {
  fsp = require("fs/promises");
  fs = require("fs");
} catch (_) {
  fsp = require("../../../js/lib/fs-promises.js");
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

async function rejectsCode(promise, code, message) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  record(
    caught !== null && caught !== undefined && caught.code === code,
    `${message} (code was ${caught && caught.code})`,
  );
  return caught;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lite-fsp-"));
const file = path.join(scratch, "a.txt");

// ---------------------------------------------------------------------------------------------
// Surface: no *Sync, no top-level fd calls, constants identity

const expectedKeys = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "constants",
  "copyFile",
  "cp",
  "link",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "watch",
  "writeFile",
];
eq(Object.keys(fsp).sort().join(","), expectedKeys.join(","), "fs/promises keys match the documented surface");
eq(fsp.constants, fs.constants, "fs/promises.constants is the fs.constants object");
eq(
  Object.keys(fsp).filter((key) => key.endsWith("Sync")).join(","),
  "",
  "fs/promises has no *Sync variants",
);
const fdLevel = [
  "close",
  "read",
  "write",
  "readv",
  "writev",
  "fstat",
  "fchmod",
  "fchown",
  "fsync",
  "fdatasync",
  "ftruncate",
  "futimes",
  "createReadStream",
  "createWriteStream",
  "exists",
  "watchFile",
];
eq(
  fdLevel.filter((key) => fsp[key] !== undefined).join(","),
  "",
  "fs/promises has no top-level fd calls or fs-only helpers",
);

// ---------------------------------------------------------------------------------------------
// read / write / append / readFile+FileHandle

async function fileChecks() {
  await fsp.writeFile(file, "hello");
  eq(await fsp.readFile(file, "utf8"), "hello", "writeFile accepts a string");
  ok(Buffer.isBuffer(await fsp.readFile(file)), "readFile returns a Buffer without encoding");
  await fsp.writeFile(file, Buffer.from("bytes"), { encoding: "utf8" });
  eq(await fsp.readFile(file, { encoding: "utf8" }), "bytes", "writeFile accepts a Buffer");

  eq(await fsp.appendFile(file, "!"), undefined, "appendFile resolves undefined");
  eq(await fsp.readFile(file, "utf8"), "bytes!", "appendFile appends");

  eq(await fsp.writeFile(file, "abc", { mode: 0o600 }), undefined, "writeFile resolves undefined");

  async function* chunks() {
    yield "async-";
    yield Buffer.from("iterable");
  }
  await fsp.writeFile(file, chunks());
  eq(await fsp.readFile(file, "utf8"), "async-iterable", "writeFile consumes an async iterable");

  // non-default flag through the open/read/close path
  await fsp.writeFile(file, "flagged");
  eq((await fsp.readFile(file, { flag: "r" })).toString(), "flagged", "readFile supports a flag option");

  // FileHandle accepted by readFile / writeFile / appendFile / stat
  await fsp.writeFile(file, "handle");
  let handle = await fsp.open(file, "r+");
  eq((await fsp.readFile(handle)).toString(), "handle", "readFile accepts a FileHandle");
  eq(await fsp.writeFile(handle, "HANDLE"), undefined, "writeFile accepts a FileHandle");
  eq(await fsp.appendFile(handle, "!"), undefined, "appendFile accepts a FileHandle");
  const handleStat = await fsp.stat(handle);
  eq(handleStat.isFile(), true, "stat accepts a FileHandle");
  await handle.close();
  await handle.close();
  eq(handle.fd, -1, "FileHandle.fd is -1 after close");
}

// ---------------------------------------------------------------------------------------------
// directories, metadata, links

async function directoryChecks() {
  const nested = path.join(scratch, "x/y/z");
  eq(await fsp.mkdir(nested, { recursive: true }), path.join(scratch, "x"), "mkdir recursive resolves the first created path");
  eq(await fsp.mkdir(nested, { recursive: true }), undefined, "mkdir recursive resolves undefined when nothing was created");
  eq(await fsp.mkdir(path.join(scratch, "plain")), undefined, "mkdir non-recursive resolves undefined");
  await rejectsCode(fsp.mkdir(file, { recursive: true }), "EEXIST", "mkdir recursive on a file rejects EEXIST");

  const created = await fsp.mkdtemp(path.join(os.tmpdir(), "lite-fsp-tmp-"));
  ok(path.basename(created).startsWith("lite-fsp-tmp-"), "mkdtemp resolves under the prefix");
  await fsp.rm(created, { recursive: true });

  await fsp.writeFile(path.join(scratch, "readme.md"), "");
  await fsp.symlink(file, path.join(scratch, "sym"));
  const names = await fsp.readdir(scratch);
  ok(names.includes("a.txt") && names.includes("readme.md"), "readdir resolves names");
  const dirents = await fsp.readdir(scratch, { withFileTypes: true });
  const byName = new Map(dirents.map((entry) => [entry.name, entry]));
  eq(byName.get("a.txt").isFile(), true, "readdir withFileTypes returns Dirents");
  eq(byName.get("sym").isSymbolicLink(), true, "Dirent.isSymbolicLink");
  const recursive = (await fsp.readdir(scratch, { recursive: true })).sort();
  ok(recursive.includes(path.join("x", "y", "z")), "readdir recursive returns relative paths");

  eq((await fsp.stat(file)).isFile(), true, "stat resolves Stats");
  eq((await fsp.lstat(path.join(scratch, "sym"))).isSymbolicLink(), true, "lstat does not follow");
  eq((await fsp.stat(path.join(scratch, "sym"))).isFile(), true, "stat follows symlinks");
  eq(await fsp.access(file), undefined, "access resolves undefined");
  await rejectsCode(fsp.access(path.join(scratch, "nope")), "ENOENT", "access rejects ENOENT");

  eq(await fsp.chmod(file, 0o600), undefined, "chmod resolves undefined");
  eq((await fsp.stat(file)).mode & 0o777, 0o600, "chmod applies the mode");
  eq(await fsp.truncate(file, 3), undefined, "truncate resolves undefined");
  eq((await fsp.stat(file)).size, 3, "truncate shrinks the file");
  eq(await fsp.utimes(file, 1000000, 2000000), undefined, "utimes resolves undefined");
  eq(Math.round((await fsp.stat(file)).mtimeMs / 1000), 2000000, "utimes applies seconds");

  eq(await fsp.rename(file, path.join(scratch, "renamed.txt")), undefined, "rename resolves undefined");
  eq(await fsp.rename(path.join(scratch, "renamed.txt"), file), undefined, "rename round-trips");
  eq(await fsp.link(file, path.join(scratch, "hard")), undefined, "link resolves undefined");
  eq(await fsp.readlink(path.join(scratch, "sym")), file, "readlink resolves the target");
  const resolved = await fsp.realpath(path.join(scratch, "sym"));
  ok(path.isAbsolute(resolved), "realpath is absolute");

  await fsp.writeFile(path.join(scratch, "copy.txt"), "C");
  eq(await fsp.copyFile(path.join(scratch, "copy.txt"), path.join(scratch, "copy2.txt")), undefined, "copyFile resolves undefined");
  eq(await fsp.readFile(path.join(scratch, "copy2.txt"), "utf8"), "C", "copyFile copies");

  const cpSource = path.join(scratch, "cp-src");
  await fsp.mkdir(path.join(cpSource, "inner"), { recursive: true });
  await fsp.writeFile(path.join(cpSource, "inner", "f.txt"), "F");
  eq(await fsp.cp(cpSource, path.join(scratch, "cp-dst"), { recursive: true }), undefined, "cp resolves undefined");
  eq(await fsp.readFile(path.join(scratch, "cp-dst", "inner", "f.txt"), "utf8"), "F", "cp copies recursively");

  await fsp.writeFile(path.join(scratch, "unlink-me"), "");
  eq(await fsp.unlink(path.join(scratch, "unlink-me")), undefined, "unlink resolves undefined");
  await fsp.mkdir(path.join(scratch, "rmdir-me"));
  eq(await fsp.rmdir(path.join(scratch, "rmdir-me")), undefined, "rmdir resolves undefined");
  eq(await fsp.rm(path.join(scratch, "cp-dst"), { recursive: true }), undefined, "rm resolves undefined");
  eq(fs.existsSync(path.join(scratch, "cp-dst")), false, "rm removed the tree");
}

// ---------------------------------------------------------------------------------------------
// FileHandle

async function handleChecks() {
  await fsp.writeFile(file, "0123456789");
  const handle = await fsp.open(file, "r+");
  ok(typeof handle.fd === "number" && handle.fd > 2, "FileHandle.fd is the OS descriptor");

  const read = await handle.read(Buffer.alloc(4), 1, 2, 2);
  eq(read.bytesRead, 2, "FileHandle.read returns bytesRead");
  eq(read.buffer.toString("utf8", 1, 3), "23", "FileHandle.read copies into the buffer");

  const write = await handle.write(Buffer.from("XY"), 0, 2, 0);
  eq(write.bytesWritten, 2, "FileHandle.write returns bytesWritten");
  eq(write.buffer instanceof Uint8Array, true, "FileHandle.write returns the buffer");

  const stringWrite = await handle.write("Z", 2, "utf8");
  eq(stringWrite.bytesWritten, 1, "FileHandle.write accepts a string");
  eq(stringWrite.buffer, "Z", "FileHandle.write returns the string");

  const readv = await handle.readv([Buffer.alloc(2), Buffer.alloc(2)], 0);
  eq(readv.bytesRead, 4, "FileHandle.readv returns bytesRead");
  eq(readv.buffers.length, 2, "FileHandle.readv returns the buffers");

  const writev = await handle.writev([Buffer.from("ab")], 4);
  eq(writev.bytesWritten, 2, "FileHandle.writev returns bytesWritten");
  eq(writev.buffers.length, 1, "FileHandle.writev returns the buffers");

  eq((await handle.stat()).isFile(), true, "FileHandle.stat resolves Stats");
  eq(await handle.chmod(0o600), undefined, "FileHandle.chmod resolves undefined");
  eq(await handle.utimes(1000000, 2000000), undefined, "FileHandle.utimes resolves undefined");
  eq(Math.round((await handle.stat()).mtimeMs / 1000), 2000000, "FileHandle.utimes applies seconds");
  eq(await handle.sync(), undefined, "FileHandle.sync resolves undefined");
  eq(await handle.datasync(), undefined, "FileHandle.datasync resolves undefined");
  eq(await handle.truncate(2), undefined, "FileHandle.truncate resolves undefined");
  eq((await handle.stat()).size, 2, "FileHandle.truncate shrinks the file");

  await handle.writeFile("replaced");
  eq((await handle.stat()).size, 8, "FileHandle.writeFile writes at the current offset");
  eq(await handle.readFile("utf8"), "", "FileHandle.readFile reads from the current offset (EOF)");
  await handle.close();
  eq(await handle.close(), undefined, "FileHandle.close is idempotent");

  await rejectsCode(handle.stat(), "EBADF", "FileHandle.stat after close rejects EBADF");
  await rejectsCode(handle.read(Buffer.alloc(1), 0, 1, 0), "EBADF", "FileHandle.read after close rejects EBADF");
  await rejectsCode(handle.write(Buffer.from("x")), "EBADF", "FileHandle.write after close rejects EBADF");
  await rejectsCode(handle.writeFile("x"), "EBADF", "FileHandle.writeFile after close rejects EBADF");
  await rejectsCode(handle.readFile(), "EBADF", "FileHandle.readFile after close rejects EBADF");

  // createReadStream / createWriteStream from a handle
  const readHandle = await fsp.open(file, "r");
  const streamed = await new Promise((resolve, reject) => {
    let text = "";
    const stream = readHandle.createReadStream({ start: 0, end: 1 });
    stream.on("data", (chunk) => (text += chunk));
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
  eq(streamed, "re", "FileHandle.createReadStream honours start/end");
  await rejectsCode(readHandle.stat(), "EBADF", "an auto-closing handle stream retires the handle");
  eq(await readHandle.close(), undefined, "closing the retired handle resolves");

  const writeHandle = await fsp.open(path.join(scratch, "handle-out.txt"), "w");
  await new Promise((resolve, reject) => {
    const stream = writeHandle.createWriteStream();
    stream.on("error", reject);
    stream.on("close", resolve);
    stream.end("from-handle");
  });
  eq(await fsp.readFile(path.join(scratch, "handle-out.txt"), "utf8"), "from-handle", "FileHandle.createWriteStream writes");
  await writeHandle.close();
}

// ---------------------------------------------------------------------------------------------
// errors, abort, watch

async function errorChecks() {
  await rejectsCode(fsp.readFile(123), "ERR_INVALID_ARG_TYPE", "bad arguments reject, not throw");
  await rejectsCode(fsp.readFile(path.join(scratch, "absent")), "ENOENT", "missing file rejects ENOENT");
  await rejectsCode(fsp.readFile(scratch), "EISDIR", "reading a directory rejects EISDIR");
  const missing = await rejectsCode(fsp.stat(path.join(scratch, "absent")), "ENOENT", "stat rejects ENOENT");
  ok(missing.errno < 0, "rejection errno is negative");
  eq(missing.syscall, "stat", "rejection syscall");

  // AbortSignal while in flight
  await fsp.writeFile(path.join(scratch, "big.txt"), "z".repeat(4 * 1024 * 1024));
  const controller = new AbortController();
  const pending = fsp.readFile(path.join(scratch, "big.txt"), { signal: controller.signal });
  controller.abort();
  const aborted = await rejectsCode(pending, "ABORT_ERR", "AbortSignal rejects with ABORT_ERR");
  eq(aborted.name, "AbortError", "aborted rejection is an AbortError");

  // already-aborted signal
  const preAborted = new AbortController();
  preAborted.abort();
  await rejectsCode(
    fsp.readFile(file, { signal: preAborted.signal }),
    "ABORT_ERR",
    "an already-aborted signal rejects",
  );

  // opendir + Dir async iteration
  const dirHandle = await fsp.opendir(scratch);
  ok((await dirHandle.read()) !== null, "opendir resolves a Dir");
  await dirHandle.close();

  // watch async iterator
  const watched = path.join(scratch, "watch.txt");
  await fsp.writeFile(watched, "1");
  const iterator = fsp.watch(watched, { interval: 20 });
  eq(typeof iterator.next, "function", "watch returns an async iterator");
  const next = iterator.next();
  setTimeout(() => fs.writeFileSync(watched, "22"), 40);
  const event = await next;
  eq(event.done, false, "watch iterator yields an event");
  ok(event.value && typeof event.value.eventType === "string", "watch event has an eventType");
  await iterator.return();
  eq((await iterator.next()).done, true, "watch iterator is done after return()");
}

function finish() {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
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

(async () => {
  await fileChecks();
  await directoryChecks();
  await handleChecks();
  await errorChecks();
})()
  .then(finish)
  .catch((error) => {
    console.log(`FAIL: ${error && error.stack ? error.stack.split("\n")[0] : String(error)}`);
    process.exitCode = 1;
  });
