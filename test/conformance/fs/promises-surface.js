"use strict";
// fs/promises: the documented shape, not a promisified fs (D35).
const fs = require("fs");
const fsp = require("fs/promises");

const fdCalls = [
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

console.log("no-sync", Object.keys(fsp).filter((key) => key.endsWith("Sync")).length === 0);
console.log("fd-calls", fdCalls.filter((key) => fsp[key] !== undefined).join(",") || "-");
console.log("constants", fsp.constants === fs.constants);
console.log("promises-getter", fs.promises === fsp);
console.log(
    "api",
    typeof fsp.open,
    typeof fsp.watch,
    typeof fsp.cp,
    typeof fsp.opendir,
    typeof fsp.readFile,
);
