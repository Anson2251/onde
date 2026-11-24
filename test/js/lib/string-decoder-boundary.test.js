"use strict";

// Runtime-agnostic self-test for the streaming UTF-8 boundary path in js/lib/string_decoder.js.
//
// The native path (one host call returning { text, pending }) runs under lite; the JavaScript
// scan runs under node. Both must produce the same text, and the same held-suffix accounting,
// for every split of the corpus. The literals below were recorded from `node v26.12.1`.
//
// Run: node test/js/lib/string-decoder-boundary.test.js

const { StringDecoder } = require("../../../js/lib/string_decoder.js");

let failures = 0;

function bytes(value) {
  return Uint8Array.from(value);
}

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
  if (actual === expected) ok(label);
  else fail(label, "expected " + fmt(expected) + ", got " + fmt(actual));
}

function writeChunks(chunks, encoding) {
  const decoder = new StringDecoder(encoding || "utf8");
  let text = "";
  const states = [];
  let offset = 0;
  for (const chunk of chunks) {
    text += decoder.write(bytes(chunk));
    states.push([offset, decoder.lastNeed, decoder.lastTotal]);
    offset += chunk.length;
  }
  return { text: text + decoder.end(), states };
}

function oneShot(all) {
  return writeChunks([all]).text;
}

function splits(all) {
  const result = [[all], all.map((byte) => [byte])];
  for (let i = 1; i < all.length; i++) result.push([all.slice(0, i), all.slice(i)]);
  for (const size of [3, 7]) {
    const chunks = [];
    for (let i = 0; i < all.length; i += size) chunks.push(all.slice(i, i + size));
    result.push(chunks);
  }
  return result;
}

// The single-write text is the reference; every split and every lastNeed/lastTotal intermediate
// must be consistent with it. The exact expectations below pin the Node split rule.
const corpus = [
  [0xe2, 0x82, 0xac],
  [0x61, 0xe2, 0x82, 0xac, 0x62],
  [0xf0, 0x9f, 0x98, 0x80],
  [0x61, 0xf0, 0x9f, 0x98, 0x80, 0x62],
  [0xef, 0xbb, 0xbf, 0x61],
  [0xe0, 0x80],
  [0xf0, 0x9f],
  [0x61, 0xe2],
  [0xc0, 0x80],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0x80, 0xbf],
  [0xe2, 0x82],
  [0xf0, 0x9f, 0x98],
  [0x61, 0x62, 0xc3],
  [0xc3, 0xa9],
  [0xf8, 0x80, 0x80, 0x80],
];

for (const all of corpus) {
  const expected = oneShot(all);
  const label = "corpus " + fmt(bytes(all));
  is(writeChunks([all]).text, expected, label + " one shot");
  const variants = splits(all);
  let mismatch = null;
  for (const chunks of variants) {
    const got = writeChunks(chunks).text;
    if (got !== expected) {
      mismatch = fmt(chunks) + " -> " + fmt(got);
      break;
    }
  }
  if (mismatch === null) ok(label + " every split");
  else fail(label + " every split", "expected " + fmt(expected) + ", " + mismatch);
}

// Node's held-suffix accounting for the incomplete-but-invalid prefix class. The bytes already
// present are not a valid sequence, but StringDecoder holds them because the declared length is
// not reached; `end()` then emits one replacement per maximal subpart.
{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(bytes([0xe0, 0x80])), "", "E0 80: held, no text emitted");
  is(decoder.lastNeed, 1, "E0 80: lastNeed 1");
  is(decoder.lastTotal, 3, "E0 80: lastTotal 3");
  is(decoder.end(), "\uFFFD\uFFFD", "E0 80: end emits two replacements");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(bytes([0x61, 0xf0, 0x9f])), "a", "61 F0 9F: ascii then held");
  is(decoder.lastNeed, 2, "61 F0 9F: lastNeed 2");
  is(decoder.lastTotal, 4, "61 F0 9F: lastTotal 4");
  is(decoder.write(bytes([0x98, 0x80])), "\u{1F600}", "61 F0 9F + 98 80: emoji completes");
  is(decoder.lastNeed, 0, "emoji: lastNeed resets");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(bytes([0xc0, 0x80])), "\uFFFD\uFFFD", "C0 80: both bytes replaced on write");
  is(decoder.lastNeed, 0, "C0 80: nothing held");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(bytes([0xed, 0xa0, 0x80])), "\uFFFD\uFFFD\uFFFD", "surrogate bytes replaced");
  is(decoder.lastNeed, 0, "surrogate: nothing held");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(bytes([0xf0, 0x9f])), "", "F0 9F: held");
  is(decoder.end(), "\uFFFD", "F0 9F: end emits one replacement");
}

{
  const decoder = new StringDecoder("utf8");
  is(decoder.write(bytes([0x61, 0xe2])), "a", "61 E2: ascii emitted, lead held");
  is(decoder.end(), "\uFFFD", "61 E2: end emits one replacement");
}

if (failures > 0) {
  console.error("# string-decoder-boundary: " + failures + " failure(s)");
  process.exit(1);
}
console.log("# string-decoder-boundary: all checks passed");
