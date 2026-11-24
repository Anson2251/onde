"use strict";

// Adapted from test/conformance/buffer/string-decoder.js.
//
// The conformance case prints each decoder flush; this version asserts the same parts. Feeding the
// same bytes in different chunkings is the whole point of `StringDecoder`, and none of it needs a
// fixture or a wall-clock timer, so the case survives a sequential runner unchanged.

const test = require("node:test");
const assert = require("node:assert");
const { Buffer } = require("node:buffer");
const { StringDecoder } = require("node:string_decoder");

function feed(encoding, chunks) {
  const decoder = new StringDecoder(encoding);
  const parts = [];
  for (const chunk of chunks) parts.push(decoder.write(Buffer.from(chunk)));
  parts.push(decoder.end());
  return parts;
}

test.describe("StringDecoder", () => {
  test("hex has no pending state", () => {
    assert.deepStrictEqual(feed("hex", [[0xde, 0xad], [0xbe, 0xef]]), ["dead", "beef", ""]);
    assert.deepStrictEqual(feed("hex", [[0x00], [0x0f], [0xff]]), ["00", "0f", "ff", ""]);
    assert.deepStrictEqual(feed("hex", [[]]), ["", ""]);
  });

  test("base64 holds an incomplete group", () => {
    assert.deepStrictEqual(
      feed("base64", [[0x00], [0x01, 0x02], [0x03, 0x04, 0x05], [0xfb, 0xff]]),
      ["", "AAEC", "AwQF", "", "+/8="],
    );
    assert.deepStrictEqual(
      feed("base64", [[0x41], [0x42], [0x43], [0x44]]),
      ["", "", "QUJD", "", "RA=="],
    );
    assert.deepStrictEqual(feed("base64", [[]]), ["", ""]);
  });

  test("base64url chunking matches the standard alphabet's rule", () => {
    assert.deepStrictEqual(feed("base64url", [[0xfb, 0xff], [0x00]]), ["", "-_8A", ""]);
    assert.deepStrictEqual(feed("base64url", [[0xfb], [0xff], [0xfe]]), ["", "", "-__-", ""]);
  });

  test("text() discards the pending group", () => {
    const decoder = new StringDecoder("base64");
    assert.strictEqual(decoder.text(Buffer.from([0x01, 0x02])), "");
    assert.strictEqual(decoder.text(Buffer.from([0x03, 0x04])), "");
    assert.strictEqual(decoder.end(), "AwQ=");
  });
});

test("a base64 string is its bytes whatever the spelling", () => {
  for (const text of ["aGVsbG8=", "aGVsbG8", "aGVs bG8=", "aGVsbG8="]) {
    assert.strictEqual(Buffer.from(text, "base64").toString("hex"), "68656c6c6f");
  }
});
