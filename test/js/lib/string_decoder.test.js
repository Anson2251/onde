"use strict";

// Runtime-agnostic self-test for js/lib/string_decoder.js.
//
// Run under `node` (and `onde`): node test/js/lib/string_decoder.test.js
// Prints one `ok <label>` line per passing check and exits 1 on any failure.

const { StringDecoder } = require("../../../js/lib/string_decoder.js");

let failures = 0;

function fmt(value) {
  if (value instanceof Uint8Array) return "[" + Array.from(value).join(",") + "]";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function ok(label) {
  console.log("ok " + label);
}

function fail(label, detail) {
  failures++;
  console.error("not ok " + label + (detail ? " - " + detail : ""));
}

function is(actual, expected, label) {
  if (actual === expected) {
    ok(label);
  } else {
    fail(label, "expected " + fmt(expected) + ", got " + fmt(actual));
  }
}

function throwsWith(fn, name, code, label) {
  try {
    fn();
    fail(label, "expected a " + name + " to be thrown");
  } catch (err) {
    if (err && err.name === name && err.code === code) {
      ok(label);
    } else {
      fail(
        label,
        "expected " + name + " " + code + ", got " + (err && err.name) + " " + (err && err.code),
      );
    }
  }
}

function from(bytes) {
  return Uint8Array.from(bytes);
}

function writeAll(encoding, bytes, chunkSize) {
  const decoder = new StringDecoder(encoding);
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    text += decoder.write(from(bytes.slice(offset, offset + chunkSize)));
  }
  return text + decoder.end();
}

// -------------------------------------------------------------------------------------------
// Construction and encoding normalisation
// -------------------------------------------------------------------------------------------

is(new StringDecoder().encoding, "utf8", "default encoding is utf8");
is(new StringDecoder("utf8").encoding, "utf8", "utf8 label");
is(new StringDecoder("utf-8").encoding, "utf8", "utf-8 label normalises to utf8");
is(new StringDecoder("ucs2").encoding, "utf16le", "ucs2 normalises to utf16le");
is(new StringDecoder("ucs-2").encoding, "utf16le", "ucs-2 normalises to utf16le");
is(new StringDecoder("utf-16le").encoding, "utf16le", "utf-16le normalises to utf16le");
is(new StringDecoder("binary").encoding, "latin1", "binary normalises to latin1");
is(new StringDecoder("hex").encoding, "hex", "hex encoding");
is(new StringDecoder("base64url").encoding, "base64url", "base64url encoding");
throwsWith(
  () => new StringDecoder("bogus"),
  "TypeError",
  "ERR_UNKNOWN_ENCODING",
  "unknown encoding throws",
);

{
  const decoder = new StringDecoder("utf8");
  is(decoder.lastNeed, 0, "lastNeed starts at 0");
  is(decoder.lastTotal, 0, "lastTotal starts at 0");
}

// -------------------------------------------------------------------------------------------
// Stateless encodings
// -------------------------------------------------------------------------------------------

is(new StringDecoder("latin1").write(from([0x41, 0x80, 0xff])), "A\u0080\u00ff", "latin1 passes bytes through");
is(new StringDecoder("ascii").write(from([0x41, 0x80])), "A\u0000", "ascii masks the high bit");
is(new StringDecoder("hex").write(from([0x0a, 0xbc])), "0abc", "hex renders two nibbles per byte");
is(new StringDecoder("hex").end(), "", "hex has nothing pending");
is(new StringDecoder("hex").write(from([0x01])), "01", "hex never holds a nibble");

// -------------------------------------------------------------------------------------------
// UTF-8
// -------------------------------------------------------------------------------------------

{
  const bytes = [0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x92, 0xa9, 0xc3, 0xa9, 0x41];
  const expected = "€💩éA";
  is(writeAll("utf8", bytes, bytes.length), expected, "utf8 whole-buffer decode");
  is(writeAll("utf8", bytes, 1), expected, "utf8 byte-by-byte decode matches whole-buffer output");
  is(writeAll("utf8", bytes, 2), expected, "utf8 two-byte chunks match whole-buffer output");
  is(writeAll("utf8", bytes, 3), expected, "utf8 three-byte chunks match whole-buffer output");
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new StringDecoder("utf8");
    let text = decoder.write(from(bytes.slice(0, split)));
    text += decoder.write(from(bytes.slice(split)));
    text += decoder.end();
    is(text, expected, "utf8 two-chunk split at " + split);
  }
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(from([0xe2])), "", "utf8 holds a lone three-byte lead");
  is(decoder.lastNeed, 2, "utf8 lastNeed after a three-byte lead");
  is(decoder.lastTotal, 3, "utf8 lastTotal after a three-byte lead");
  is(decoder.write(from([0x82])), "", "utf8 holds a two-byte prefix");
  is(decoder.lastNeed, 1, "utf8 lastNeed after a two-byte prefix");
  is(decoder.lastTotal, 3, "utf8 lastTotal after a two-byte prefix");
  is(decoder.write(from([0xac])), "€", "utf8 completes the sequence");
  is(decoder.lastNeed, 0, "utf8 lastNeed resets");
  is(decoder.lastTotal, 0, "utf8 lastTotal resets");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(from([0xf0, 0x9f])), "", "utf8 holds a four-byte prefix");
  is(decoder.lastNeed, 2, "utf8 four-byte lastNeed");
  is(decoder.lastTotal, 4, "utf8 four-byte lastTotal");
  is(decoder.end(), "\uFFFD", "utf8 end flushes an incomplete sequence as U+FFFD");
  is(decoder.lastNeed, 0, "utf8 end clears lastNeed");
  is(decoder.lastTotal, 0, "utf8 end clears lastTotal");
}

is(new StringDecoder("utf8").end(), "", "utf8 end with nothing pending");
is(new StringDecoder("utf8").write(from([0x61])), "a", "utf8 ascii");

{
  // Invalid sequences are replaced like Node: one U+FFFD per maximal subpart.
  is(writeAll("utf8", [0xe2, 0x28, 0xa1], 3), "\uFFFD(\uFFFD", "utf8 invalid continuation");
  is(writeAll("utf8", [0xf0, 0x28, 0x8c, 0x28], 4), "\uFFFD(\uFFFD(", "utf8 invalid four-byte sequence");
  is(writeAll("utf8", [0xff], 1), "\uFFFD", "utf8 invalid byte FF");
  is(writeAll("utf8", [0xe0, 0x80, 0x80], 3), "\uFFFD\uFFFD\uFFFD", "utf8 overlong E0 80 80");
  is(writeAll("utf8", [0xc0, 0xaf], 2), "\uFFFD\uFFFD", "utf8 overlong C0 AF");
}

{
  // A pending but already-invalid sequence is held until end(), then flushed as one
  // replacement per maximal subpart (Node behaviour).
  const decoder = new StringDecoder("utf8");
  is(decoder.write(from([0xe0, 0x80])), "", "utf8 holds an invalid two-byte prefix");
  is(decoder.lastNeed, 1, "utf8 invalid prefix lastNeed");
  is(decoder.lastTotal, 3, "utf8 invalid prefix lastTotal");
  is(decoder.end(), "\uFFFD\uFFFD", "utf8 end flushes an invalid prefix");
}

// -------------------------------------------------------------------------------------------
// UTF-16LE
// -------------------------------------------------------------------------------------------

{
  const decoder = new StringDecoder("utf16le");
  is(decoder.write(from([0x61, 0x00])), "a", "utf16le decodes a code unit");
  is(decoder.write(from([0x3d, 0xd8, 0xa9, 0xdc])), "💩", "utf16le decodes a surrogate pair");
  is(decoder.end(), "", "utf16le end after complete input");
}

{
  const decoder = new StringDecoder("utf16le");
  is(decoder.write(from([0x61])), "", "utf16le holds an odd byte");
  is(decoder.lastNeed, 1, "utf16le odd byte lastNeed");
  is(decoder.lastTotal, 2, "utf16le odd byte lastTotal");
  is(decoder.write(from([0x00])), "a", "utf16le completes a split code unit");
  is(decoder.lastNeed, 0, "utf16le lastNeed resets after completion");
}

{
  const decoder = new StringDecoder("utf16le");
  is(decoder.write(from([0x61])), "", "utf16le holds the high byte");
  is(decoder.end(), "", "utf16le end drops a lone trailing byte");
}

{
  const decoder = new StringDecoder("utf16le");
  is(decoder.write(from([0x3d, 0xd8])), "", "utf16le holds a lead surrogate");
  is(decoder.lastNeed, 2, "utf16le lead surrogate lastNeed");
  is(decoder.lastTotal, 4, "utf16le lead surrogate lastTotal");
  is(decoder.write(from([0xa9, 0xdc])), "💩", "utf16le joins a split surrogate pair");
}

{
  const decoder = new StringDecoder("utf16le");
  decoder.write(from([0x00, 0xd8]));
  is(decoder.end(), "\uD800", "utf16le end emits a held lead surrogate as-is");
}

{
  const decoder = new StringDecoder("utf16le");
  let text = "";
  for (const byte of [0x61, 0x00, 0x62, 0x00]) text += decoder.write(from([byte]));
  text += decoder.end();
  is(text, "ab", "utf16le byte-by-byte feeding");
}

// -------------------------------------------------------------------------------------------
// Base64
// -------------------------------------------------------------------------------------------

{
  const decoder = new StringDecoder("base64");
  is(decoder.write(from([0x66])), "", "base64 holds one byte");
  is(decoder.lastNeed, 2, "base64 lastNeed after one byte");
  is(decoder.lastTotal, 3, "base64 lastTotal after one byte");
  is(decoder.write(from([0x6f])), "", "base64 holds two bytes");
  is(decoder.lastNeed, 1, "base64 lastNeed after two bytes");
  is(decoder.lastTotal, 3, "base64 lastTotal after two bytes");
  is(decoder.write(from([0x6f])), "Zm9v", "base64 emits a complete group");
  is(decoder.lastNeed, 0, "base64 lastNeed resets");
  is(decoder.end(), "", "base64 end after a complete group");
}

{
  const decoder = new StringDecoder("base64");
  is(decoder.write(from([0x66])), "", "base64 holds a byte before end");
  is(decoder.end(), "Zg==", "base64 end pads a single byte");
  is(decoder.end(), "", "base64 second end is empty");
}

{
  const decoder = new StringDecoder("base64");
  decoder.write(from([0x66, 0x6f]));
  is(decoder.end(), "Zm8=", "base64 end pads two bytes");
}

{
  const decoder = new StringDecoder("base64");
  is(writeAll("base64", [0x68, 0x65, 0x6c, 0x6c, 0x6f], 1), "aGVsbG8=", "base64 byte-by-byte");
}

{
  const decoder = new StringDecoder("base64url");
  is(decoder.write(from([0x66, 0x6f, 0x6f, 0x62, 0x61])), "Zm9v", "base64url emits complete groups");
  is(decoder.lastNeed, 1, "base64url lastNeed");
  is(decoder.end(), "YmE", "base64url end has no padding");
}

// -------------------------------------------------------------------------------------------
// Input handling
// -------------------------------------------------------------------------------------------

{
  const decoder = new StringDecoder("utf8");
  const bytes = from([0x61, 0x62]);
  is(decoder.write(bytes.buffer), "ab", "write accepts an ArrayBuffer");
}

{
  const decoder = new StringDecoder("utf8");
  const bytes = from([0x61, 0x62, 0x63]);
  is(decoder.write(new DataView(bytes.buffer, 1, 1)), "b", "write accepts a DataView");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write("already text"), "already text", "write passes strings through");
}

{
  const decoder = new StringDecoder("utf8");
  decoder.write(from([0xe2, 0x82]));
  is(decoder.end(from([0xac])), "€", "end(buffer) decodes the tail and flushes");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(from([0xe2])), "", "text() precondition: pending sequence");
  is(decoder.text(from([0x61, 0x62])), "ab", "text() discards buffered bytes and decodes the rest");
  is(decoder.lastNeed, 0, "text() resets lastNeed");
}

throwsWith(
  () => new StringDecoder("utf8").write(123),
  "TypeError",
  "ERR_INVALID_ARG_TYPE",
  "write rejects a non-buffer argument",
);

// -------------------------------------------------------------------------------------------

if (failures > 0) {
  console.error("# string_decoder: " + failures + " failure(s)");
  process.exit(1);
}
console.log("# string_decoder: all checks passed");
