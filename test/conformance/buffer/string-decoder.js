"use strict";
// `StringDecoder`'s stateless hex flush and its base64 pending-group logic both go through the same
// codec seam (`internal/bytes.js`), so the split corpus belongs next to the Buffer cases: the same
// bytes fed in different chunkings must produce the same text.

const { Buffer } = require("buffer");
const { StringDecoder } = require("string_decoder");

function feed(encoding, chunks) {
  const decoder = new StringDecoder(encoding);
  const parts = [];
  for (const chunk of chunks) parts.push(decoder.write(Buffer.from(chunk)));
  parts.push(decoder.end());
  console.log(`${encoding} ${parts.map((part) => JSON.stringify(part)).join(" ")}`);
  console.log(`${encoding} lastNeed ${decoder.lastNeed} lastTotal ${decoder.lastTotal}`);
}

feed("hex", [[0xde, 0xad], [0xbe, 0xef]]);
feed("hex", [[0x00], [0x0f], [0xff]]);
feed("hex", [[]]);
feed("base64", [[0x00], [0x01, 0x02], [0x03, 0x04, 0x05], [0xfb, 0xff]]);
feed("base64", [[0x41], [0x42], [0x43], [0x44]]);
feed("base64", [[]]);
feed("base64url", [[0xfb, 0xff], [0x00]]);
feed("base64url", [[0xfb], [0xff], [0xfe]]);

// `text()` discards the pending group and decodes the rest.
const decoder = new StringDecoder("base64");
console.log(`text ${JSON.stringify(decoder.text(Buffer.from([0x01, 0x02])))}`);
console.log(`text again ${JSON.stringify(decoder.text(Buffer.from([0x03, 0x04])))}`);
console.log(`text end ${JSON.stringify(decoder.end())}`);

// A Buffer built from a base64 string is the same bytes whichever spelling produced it.
const spelled = ["aGVsbG8=", "aGVsbG8", "aGVs bG8=", "aGVsbG8="];
for (const text of spelled) {
  console.log(`from ${text} ${Buffer.from(text, "base64").toString("hex")}`);
}
