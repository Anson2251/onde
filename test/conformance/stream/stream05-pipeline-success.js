"use strict";
// pipeline: a Readable -> PassThrough -> Writable chain resolves the callback cleanly.
const { Readable, Writable, PassThrough, pipeline } = require("stream");

const out = [];
const dest = new Writable({
  write(chunk, encoding, callback) {
    out.push(String(chunk));
    callback();
  },
});
const returned = pipeline(Readable.from(["x", "y"]), new PassThrough(), dest, (err) => {
  console.log("callback", err === undefined || err === null, out.join(""), returned === dest);
});
