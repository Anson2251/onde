"use strict";
// Transform: mapping, _flush output and the end-before-finish ordering.
const { Transform } = require("stream");

const t = new Transform({
  transform(chunk, encoding, callback) {
    callback(null, String(chunk).toUpperCase());
  },
  flush(callback) {
    callback(null, "!");
  },
});
const events = [];
t.on("data", (chunk) => events.push("data:" + String(chunk)));
t.on("end", () => events.push("end"));
t.on("finish", () => {
  events.push("finish");
  console.log(events.join("|"));
});
t.write("a");
t.end("b");
