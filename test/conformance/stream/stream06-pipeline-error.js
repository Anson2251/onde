"use strict";
// pipeline: the first error reaches the callback and every stream in the chain is destroyed.
const { Readable, Writable, pipeline } = require("stream");

const source = new Readable({ read() {} });
const dest = new Writable({
  write(chunk, encoding, callback) {
    callback(new Error("dest boom"));
  },
});
source.on("error", () => {});
dest.on("error", () => {});
pipeline(source, dest, (err) => {
  console.log("error", err && err.message, source.destroyed, dest.destroyed);
});
source.push("a");
