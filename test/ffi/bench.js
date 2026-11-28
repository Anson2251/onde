"use strict";

// Per-call overhead for the numbers in docs/ffi-plan.md §15 item 8.
//
//   ONDE_FFI_FIXTURE=/path/to/libffi-fixture.dylib ./target/release/onde test/ffi/bench.js
//
// Not part of `run.sh`: a shared CI runner measures the runner (the same rule m7 applies to its
// hard perf gates), so this prints numbers instead of asserting them.

const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
if (!path) throw new Error("ONDE_FFI_FIXTURE is not set");

const lib = ffi.dlopen(path, {
    fixture_add_i32: { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
});
const symbol = lib.symbols.fixture_add_i32;
const prebound = lib.fn("fixture_add_i32", ffi.i32);
const iterations = 100_000;
let sink = 0;

function bench(label, fn) {
    // Warm up so the first plan and the JIT-free interpreter's inline caches settle.
    for (let i = 0; i < 10_000; i += 1) sink += fn(i);
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) sink += fn(i);
    const elapsed = Number(process.hrtime.bigint() - start);
    console.log(`${label}: ${(elapsed / iterations).toFixed(1)} ns/call`);
}

bench("js add", (i) => i + 1);
bench("declared symbol", (i) => symbol(i, 1));
bench("declared via fn()", (i) => prebound(i, 1));
bench("undeclared call()", (i) => lib.call("fixture_add_i32", [i, 1]));
console.log("sink", sink % 1000);
