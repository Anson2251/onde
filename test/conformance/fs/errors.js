"use strict";
// fs: error codes, errno sign, syscall names and the throw-vs-callback split.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-err-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "");
const missing = path.join(dir, "missing.txt");

function capture(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const enoent = capture(() => fs.readFileSync(missing));
console.log("enoent", enoent.code, enoent.errno, enoent.syscall, path.basename(enoent.path));
const eisdir = capture(() => fs.readFileSync(dir));
console.log("eisdir", eisdir.code, eisdir.errno, eisdir.syscall);
const encoding = capture(() => fs.readFileSync(file, "not-an-encoding"));
console.log("encoding", encoding.code);
const data = capture(() => fs.writeFileSync(file, 42));
console.log("data", data.code);
const mkdirFile = capture(() => fs.mkdirSync(file, { recursive: true }));
console.log("mkdir-file", mkdirFile.code, mkdirFile.errno, mkdirFile.syscall, path.basename(mkdirFile.path));

const fd = fs.openSync(file, "r");
fs.closeSync(fd);
const doubleClose = capture(() => fs.closeSync(fd));
console.log("double-close", doubleClose.code, doubleClose.errno, doubleClose.syscall);

const argThrow = capture(() => fs.readFile(file, 42, () => {}));
console.log("arg-throw", argThrow.code);

let synchronous = true;
fs.readFile(missing, (error) => {
  console.log("callback", error.code, "async", !synchronous);
  fs.rmSync(dir, { recursive: true, force: true });
});
synchronous = false;
