"use strict";

// Benchmarks for the parts of the stdlib that are still JavaScript, used to decide what is worth
// moving to the host. Read the ratios against the engine baseline in compute.js: ~12x is "this is
// what QuickJS costs", anything in the hundreds is "this implementation is the problem".
//
// Run through test/bench/run.js, which compares node and onde.

const punycode = require("punycode");
const util = require("util");
const assert = require("assert");
const { StringDecoder } = require("string_decoder");

function ms(fn) {
  fn(); // warm-up
  const start = Number(process.hrtime.bigint()) / 1e6;
  fn();
  return Number(process.hrtime.bigint()) / 1e6 - start;
}

const results = [];
function bench(name, fn) {
  results.push([name, ms(fn)]);
}

// Payloads: 1 KB is the size at which a per-byte loop shows up but the numbers stay readable, and
// 1 MB is what a `buf.indexOf` over a real file costs.
const KB = Buffer.alloc(1024, 0x61);
const B64 = KB.toString("base64");
const HEX = KB.toString("hex");
const MB = Buffer.alloc(1024 * 1024, 0x61);
MB[1000000] = 0;

bench("punycode:toASCII", () => {
  let n = 0;
  for (let i = 0; i < 20000; i += 1) n += punycode.toASCII("münchen-über-日本語").length;
  return n;
});

bench("buffer:base64-enc", () => {
  let n = 0;
  for (let i = 0; i < 20000; i += 1) n += KB.toString("base64").length;
  return n;
});

bench("buffer:base64-dec", () => {
  let n = 0;
  for (let i = 0; i < 20000; i += 1) n += Buffer.from(B64, "base64").length;
  return n;
});

bench("buffer:hex-enc", () => {
  let n = 0;
  for (let i = 0; i < 20000; i += 1) n += KB.toString("hex").length;
  return n;
});

bench("buffer:indexOf", () => {
  let n = 0;
  for (let i = 0; i < 500; i += 1) n += MB.indexOf(0);
  return n;
});

bench("buffer:compare", () => {
  let n = 0;
  for (let i = 0; i < 50000; i += 1) n += Buffer.compare(KB, KB);
  return n;
});

bench("buffer:readUInt32", () => {
  let n = 0;
  for (let i = 0; i < 200000; i += 1) n += KB.readUInt32LE(0);
  return n;
});

bench("util:format", () => {
  let n = 0;
  for (let i = 0; i < 50000; i += 1) n += util.format("%s=%d", "x", 1).length;
  return n;
});

bench("util:inspect", () => {
  let n = 0;
  for (let i = 0; i < 20000; i += 1) n += util.inspect({ a: 1, b: [1, 2], c: "x" }).length;
  return n;
});

bench("assert:deepEqual", () => {
  for (let i = 0; i < 50000; i += 1) assert.deepStrictEqual({ a: [1, 2] }, { a: [1, 2] });
});

bench("string_decoder:write", () => {
  let n = 0;
  for (let i = 0; i < 50000; i += 1) n += new StringDecoder().write(KB).length;
  return n;
});

for (const [name, value] of results) {
  console.log(`${JSON.stringify(name)} ${value.toFixed(1)}`);
}
