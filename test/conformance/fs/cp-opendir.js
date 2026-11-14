"use strict";
// fs: recursive cp, cp self-refusal and Dir iteration.
const fs = require("fs");
const os = require("os");
const path = require("path");

const source = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-cp-"));
const destination = source + "-copy";
fs.mkdirSync(path.join(source, "inner/deep"), { recursive: true });
fs.writeFileSync(path.join(source, "top.txt"), "T");
fs.writeFileSync(path.join(source, "inner/deep/f.txt"), "F");

fs.cpSync(source, destination, { recursive: true });
console.log("cp", fs.readFileSync(path.join(destination, "inner/deep/f.txt"), "utf8"), fs.existsSync(path.join(destination, "top.txt")));
let selfError = null;
try {
  fs.cpSync(source, path.join(source, "inner/self"), { recursive: true });
} catch (error) {
  selfError = error.code;
}
console.log("self", selfError);

const dir = fs.opendirSync(source);
const names = [];
let entry = dir.readSync();
while (entry !== null) {
  names.push(entry.name);
  entry = dir.readSync();
}
console.log("opendir", names.sort().join(","), dir.readSync() === null);
dir.closeSync();

fs.rmSync(source, { recursive: true, force: true });
fs.rmSync(destination, { recursive: true, force: true });
