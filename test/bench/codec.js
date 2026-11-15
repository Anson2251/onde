"use strict";

// Encoding benchmarks: the byte-level codecs, plus a real text read.
//
// These are the paths behind `readFileSync(path, "utf8")`, `Buffer.from(string)`,
// `Buffer.toString()` and `TextDecoder.decode()` — the ones that were JavaScript until 1.2 moved
// their core to a Rust host call. Run through test/bench/run.js, which compares node and onde.

const fs = require("fs");
const os = require("os");
const path = require("path");

function ms(fn) {
  fn(); // warm-up: both engines optimize differently on a cold first run
  const start = Number(process.hrtime.bigint()) / 1e6;
  fn();
  return Number(process.hrtime.bigint()) / 1e6 - start;
}

const results = [];
function bench(name, fn) {
  results.push([name, ms(fn)]);
}

// A 1 MB text file, written once so the read workload measures decoding rather than page faults.
const unit = "the quick brown fox jumps over the lazy dog 0123456789\n";
const big = Buffer.from(unit.repeat(Math.ceil((1024 * 1024) / unit.length))).subarray(0, 1024 * 1024);
const file = path.join(os.tmpdir(), `onde-bench-${process.pid}.txt`);
fs.writeFileSync(file, big);
try {
  const TEXT = "hello world, this is a utf8 string with some length to it";
  const BYTES = Buffer.from(TEXT);

  bench("buffer:from", () => {
    let total = 0;
    for (let i = 0; i < 100000; i += 1) total += Buffer.from(TEXT).length;
    return total;
  });

  bench("buffer:toString", () => {
    let total = 0;
    for (let i = 0; i < 100000; i += 1) total += BYTES.toString("utf8").length;
    return total;
  });

  bench("textdecoder:decode", () => {
    const decoder = new TextDecoder();
    let total = 0;
    for (let i = 0; i < 50000; i += 1) total += decoder.decode(BYTES).length;
    return total;
  });

  bench("read:1mb:utf8", () => {
    let total = 0;
    for (let i = 0; i < 20; i += 1) total += fs.readFileSync(file, "utf8").length;
    return total;
  });

  // Baseline: the same reads without decoding, so the syscall cost can be subtracted.
  bench("read:1mb:buffer", () => {
    let total = 0;
    for (let i = 0; i < 20; i += 1) total += fs.readFileSync(file).length;
    return total;
  });
} finally {
  fs.unlinkSync(file);
}

for (const [name, value] of results) {
  console.log(`${JSON.stringify(name)} ${value.toFixed(1)}`);
}
