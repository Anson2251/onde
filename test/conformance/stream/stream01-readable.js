"use strict";
// Pull-mode Readable: push/read accounting, objectMode chunks and EOF.
const { Readable } = require("stream");

const r = new Readable({ highWaterMark: 8, read() {} });
console.log("empty", r.read(), r.readableLength);
r.push("hello");
console.log("len", r.readableLength);
console.log("read2", String(r.read(2)), r.readableLength);
console.log("read-rest", String(r.read()), r.readableLength);
r.push(null);
console.log("eof", r.read(), r.readableEnded);

const objects = new Readable({ objectMode: true, read() {} });
objects.push(0);
objects.push(false);
objects.push("");
console.log("object len", objects.readableLength);
console.log("object reads", objects.read(), objects.read(), JSON.stringify(objects.read()));
console.log("hwm", r.readableHighWaterMark, r.readableObjectMode);
