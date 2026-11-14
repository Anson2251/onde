"use strict";
// fs: sync/callback read, write and append with encodings and Buffer data.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-fs-rw-"));
const file = path.join(dir, "f.txt");

fs.writeFileSync(file, "hello");
console.log("sync", fs.readFileSync(file, "utf8"));
console.log("buffer", Buffer.isBuffer(fs.readFileSync(file)));
fs.appendFileSync(file, "!");
console.log("append", fs.readFileSync(file, "utf8"));
fs.writeFileSync(file, Buffer.from("bytes"));
console.log("buffer-write", fs.readFileSync(file, "utf8"));
fs.writeFileSync(file, "options", { encoding: "utf8" });
console.log("options", fs.readFileSync(file, { encoding: "utf8" }));

let synchronous = true;
fs.readFile(file, "utf8", (error, text) => {
  console.log("callback", error, text, "async", !synchronous);
  fs.writeFile(file, "cb", (writeError) => {
    console.log("write-callback", writeError, fs.readFileSync(file, "utf8"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
synchronous = false;
