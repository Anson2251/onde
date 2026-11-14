"use strict";
const path = require("path");
const util = require("node:util");
const events = require("events");
const { Buffer } = require("buffer");
const os = require("os");
const { StringDecoder } = require("string_decoder");
const { URL } = require("url");
const assert = require("assert");

console.log(path.join("a", "b"), util.format("%s:%d", "x", 2));
console.log(typeof events.EventEmitter, Buffer.from("hi").toString("hex"));
console.log(typeof os.platform(), os.EOL.length);
const decoder = new StringDecoder("utf8");
console.log(decoder.write(Buffer.from("é")), decoder.end().length);
assert.strictEqual(new URL("https://example.com/a?b=1").search, "?b=1");
console.log("assert-ok");
