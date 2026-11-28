"use strict";

// `node:constants` is a forwarding module, so this case only prints values that the platform does
// not vary (no O_* flags whose numbers differ between Linux and macOS) plus the shape facts.
const constants = require("constants");
const fs = require("fs");
const os = require("os");

console.log(constants.O_RDONLY, constants.F_OK, constants.COPYFILE_EXCL, constants.S_IRWXU);
console.log(constants.SIGHUP, constants.ENOENT, constants.PRIORITY_LOW);

const flat = Object.keys(constants).every(
    (key) => constants[key] === null || typeof constants[key] !== "object",
);
console.log("flat:", flat);
console.log(
    "forwarded:",
    constants.O_RDONLY === fs.constants.O_RDONLY &&
        constants.SIGHUP === os.constants.signals.SIGHUP &&
        constants.ENOENT === os.constants.errno.ENOENT,
);
console.log("zlib-included:", constants.Z_NO_COMPRESSION !== undefined);
console.log("node-prefix:", require("node:constants") === constants);
