"use strict";
// Readable.pipe: pipe/unpipe lifecycle, data forwarding and the destination finish.
const { Readable, Writable } = require("stream");

const source = new Readable({ read() {} });
const seen = [];
const dest = new Writable({
  write(chunk, encoding, callback) {
    seen.push(String(chunk));
    callback();
  },
});
dest.on("pipe", () => console.log("pipe"));
dest.on("unpipe", () => console.log("unpipe", seen.join(",")));
dest.on("finish", () => console.log("finish", seen.join(",")));
source.pipe(dest);
source.push("a");
source.push("b");
source.push(null);
