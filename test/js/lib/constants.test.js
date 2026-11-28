"use strict";

// Runtime-agnostic self-check for js/lib/constants.js.
//
// The test loads the checkout sources under both runtimes rather than the builtin, because Node's
// builtin `constants` is composed from Node's much larger `fs`/`os`/`crypto` tables. Loading the
// sources here means Node and onde assert the same key set and print the same assertion count.
// The builtin is checked separately for registration (`constants` and `node:constants` are one
// object) and for the shape a caller sees.
//
//   node test/js/lib/constants.test.js
//   ./target/debug/onde test/js/lib/constants.test.js

const constants = require("../../../js/lib/constants.js");
const fsConstants = require("../../../js/lib/fs.js").constants;
const osConstants = require("../../../js/lib/os.js").constants;
const cryptoConstants = require("../../../js/lib/crypto.js").constants;
const zlibConstants = require("../../../js/lib/zlib.js").constants;

const builtin = require("constants");
const prefixed = require("node:constants");

let passed = 0;
const failures = [];

function record(condition, message) {
    if (condition) {
        passed += 1;
    } else {
        failures.push(message);
    }
}

function eq(actual, expected, message) {
    record(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function finish() {
    if (failures.length === 0) {
        console.log(`ok: ${passed} assertions`);
        process.exit(0);
    }
    for (const failure of failures) console.log(`not ok: ${failure}`);
    process.exit(1);
}

// --- shape -----------------------------------------------------------------------------------

record(
    constants !== null && typeof constants === "object" && !Array.isArray(constants),
    "constants is a plain object",
);
eq(Object.getPrototypeOf(constants), Object.prototype, "constants has Object.prototype");
record(Object.isFrozen(constants), "constants is frozen, like Node's");
record(Object.keys(constants).length > 0, "constants is not empty");

const nested = Object.keys(constants).filter(
    (key) => constants[key] !== null && typeof constants[key] === "object",
);
eq(nested.length, 0, `constants has no nested object values (found ${nested.join(", ")})`);

record(
    builtin !== null &&
        typeof builtin === "object" &&
        Object.getPrototypeOf(builtin) === Object.prototype,
    "require('constants') is a plain object",
);
eq(builtin, prefixed, "require('constants') === require('node:constants')");
record(
    Object.keys(builtin).every((key) => builtin[key] === null || typeof builtin[key] !== "object"),
    "the builtin has no nested object values",
);
record(Object.isFrozen(builtin), "the builtin is frozen, like Node's");

// --- representative values, one group at a time ----------------------------------------------

// fs.constants
eq(constants.O_RDONLY, 0, "O_RDONLY");
eq(constants.F_OK, 0, "F_OK");
eq(constants.COPYFILE_EXCL, 1, "COPYFILE_EXCL");
eq(constants.S_IRWXU, 448, "S_IRWXU");

// os.constants groups
eq(constants.SIGHUP, 1, "SIGHUP");
eq(constants.ENOENT, 2, "ENOENT");
eq(constants.EACCES, 13, "EACCES");
eq(constants.PRIORITY_NORMAL, 0, "PRIORITY_NORMAL");
eq(constants.PRIORITY_LOW, 19, "PRIORITY_LOW");
eq(constants.PRIORITY_HIGHEST, -20, "PRIORITY_HIGHEST");

// These two are platform values in Node and in onde's os.constants, so assert what this platform
// defines rather than one platform's literal. CI runs both Linux and macOS.
const isDarwin = process.platform === "darwin";
eq(constants.PRIORITY_HIGH, isDarwin ? -14 : -20, "PRIORITY_HIGH follows the platform");
eq(constants.O_NOFOLLOW, isDarwin ? 256 : 131072, "O_NOFOLLOW follows the platform");

// --- coverage: everything the owner modules export, nothing else -----------------------------

function forwarded(source, label) {
    for (const key of Object.keys(source)) {
        record(
            Object.prototype.hasOwnProperty.call(constants, key),
            `${label}.${key} is forwarded`,
        );
        eq(constants[key], source[key], `${label}.${key} keeps its value`);
    }
}

const expectedKeys = new Set(Object.keys(fsConstants));
forwarded(fsConstants, "fs.constants");

for (const group of Object.keys(osConstants)) {
    const values = osConstants[group];
    if (values !== null && typeof values === "object") {
        for (const key of Object.keys(values)) expectedKeys.add(key);
        forwarded(values, `os.constants.${group}`);
    }
}

// onde's crypto has no `constants` today; when it gains one this loop starts asserting it without
// changing the test. Both runtimes load the same source module, so the branch is identical.
if (cryptoConstants !== null && typeof cryptoConstants === "object") {
    for (const key of Object.keys(cryptoConstants)) expectedKeys.add(key);
    forwarded(cryptoConstants, "crypto.constants");
}

// Every owner key is present above; matching the counts proves there is no invented key either.
eq(Object.keys(constants).length, expectedKeys.size, "constants has exactly the forwarded keys");

// --- deliberately excluded modules ------------------------------------------------------------

eq(constants.Z_NO_COMPRESSION, undefined, "zlib constants are not forwarded");
eq(builtin.Z_NO_COMPRESSION, undefined, "the builtin also excludes zlib constants");
eq(zlibConstants.Z_NO_COMPRESSION, 0, "onde's zlib still defines Z_NO_COMPRESSION itself");

finish();
