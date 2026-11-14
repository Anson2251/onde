"use strict";
// fs: stat follows a symlink, lstat does not; Stats dates and mode.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-stat-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "12345");
fs.chmodSync(file, 0o640);
const link = path.join(dir, "link");
fs.symlinkSync(file, link);

const followed = fs.statSync(link);
const own = fs.lstatSync(link);
console.log("stat", followed.isFile(), followed.isSymbolicLink(), followed.size);
console.log("lstat", own.isSymbolicLink(), own.isFile());
console.log("mode", (fs.statSync(file).mode & 0o777).toString(8));
console.log("dates", followed.atime instanceof Date, followed.mtime instanceof Date, followed.birthtime instanceof Date);
console.log("plain", fs.statSync(file).isFile(), fs.lstatSync(file).isSymbolicLink());
console.log("missing", fs.statSync(path.join(dir, "nope"), { throwIfNoEntry: false }) === undefined);

fs.rmSync(dir, { recursive: true, force: true });
