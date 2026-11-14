"use strict";
// fs: readdir names, Dirent kinds, recursive relative paths and buffer names.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-readdir-"));
fs.writeFileSync(path.join(dir, "a.txt"), "");
fs.mkdirSync(path.join(dir, "sub/inner"), { recursive: true });
fs.writeFileSync(path.join(dir, "sub/inner/deep.txt"), "");
fs.symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link"));

console.log("names", fs.readdirSync(dir).sort().join(","));
const dirents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
console.log("dirents", dirents.map((entry) => `${entry.name}:${entry.isFile() ? "f" : entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "?"}`).join(","));
console.log("parent", dirents.every((entry) => entry.parentPath === dir));
console.log("recursive", fs.readdirSync(dir, { recursive: true }).sort().join(","));
console.log("buffer", fs.readdirSync(dir, { encoding: "buffer" }).every((name) => Buffer.isBuffer(name)));

fs.rmSync(dir, { recursive: true, force: true });
