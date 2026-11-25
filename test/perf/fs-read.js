"use strict";

// `fs.readFile` workload for test/perf/run.sh.
//
//   <runtime> test/perf/fs-read.js <file> [iterations]
//
// Reads the same file repeatedly and prints one RESULT line. The harness runs this script under
// node and under onde with the same 10 MB file and compares the medians, so the measurement is the
// runtime's read path, not the filesystem: by the second iteration the file is in the page cache
// for both.
//
// Why sync: `readFileSync` is the path D36 describes (the host copies the op's bytes into a
// `Uint8Array`), it has no queueing to confound the number, and it is what a build tool uses.

const fs = require("fs");

const file = process.argv[2];
const iterations = Number(process.argv[3] || 30);

if (!file) {
  console.error("usage: fs-read.js <file> [iterations]");
  process.exit(2);
}

const size = fs.statSync(file).size;

// Three discarded reads: the first pays for open + page-cache population, which is the filesystem
// and not the runtime.
for (let i = 0; i < 3; i += 1) fs.readFileSync(file);

const samples = [];
for (let i = 0; i < iterations; i += 1) {
  const started = process.hrtime.bigint();
  const bytes = fs.readFileSync(file);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (bytes.length !== size) {
    console.error(`fs-read: short read ${bytes.length} of ${size}`);
    process.exit(1);
  }
  samples.push(elapsed);
}

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const min = samples[0];
const max = samples[samples.length - 1];
console.log(
  `RESULT mode=sync bytes=${size} iterations=${iterations} median_ms=${median.toFixed(3)} ` +
    `min_ms=${min.toFixed(3)} max_ms=${max.toFixed(3)}`,
);
