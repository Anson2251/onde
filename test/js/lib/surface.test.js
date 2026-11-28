"use strict";

// The build-time minifier (crates/ln-runtime/build.rs) compresses the stdlib and strips whitespace
// but does not rename bindings. The Node-facing names must survive compression, so this test pins
// the surface a user can observe. It skips under plain node (the host and the minified bundle are
// onde-only).

if (typeof globalThis.__ln_host !== "object") {
    console.log("skip: onde host unavailable");
    process.exit(0);
}

let failures = 0;
function check(label, actual, expected) {
    if (actual === expected) return;
    failures += 1;
    console.log(`not ok ${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function checkName(value, expected) {
    check(`name ${expected}`, typeof value === "function" ? value.name : undefined, expected);
}

const { EventEmitter, once } = require("events");
const { Readable, Writable } = require("stream");
const { Stats } = require("fs");
const { Socket } = require("net");
const { Worker } = require("worker_threads");
const { Buffer } = require("buffer");
const util = require("util");
const path = require("path");

checkName(EventEmitter, "EventEmitter");
checkName(once, "once");
checkName(Readable, "Readable");
checkName(Writable, "Writable");
checkName(Stats, "Stats");
checkName(Socket, "Socket");
checkName(Worker, "Worker");
checkName(Buffer, "Buffer");
checkName(util.promisify, "promisify");
checkName(util.inspect, "inspect");
checkName(path.join, "join");
check("module exports keep their keys", typeof require("fs").readFile, "function");
check("module exports keep their names", require("fs").readFile.name, "readFile");

console.log(failures === 0 ? "surface: ok" : `surface: ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
