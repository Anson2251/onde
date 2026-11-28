"use strict";

// The crash trace (`--trace-ffi`, ONDE_FFI_TRACE). run.sh checks the stderr lines; this script
// only exercises the boundary events: open, declare, image, struct layout, both call paths, close.

const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
if (!path) throw new Error("ONDE_FFI_FIXTURE is not set; run this through test/ffi/run.sh");

const Point = ffi.Struct.define(
    [
        ["x", ffi.i32],
        ["y", ffi.f64],
    ],
    { name: "TracePoint" },
);

const lib = ffi.dlopen(path, {
    fixture_add_i32: { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
});
// A second handle with no declarations takes the inferred `lib.call` path, which is the one the
// lab report's segfault used.
const bare = ffi.dlopen(path);

// Force the layout: it is computed on first use, not at `Struct.define`.
const point = new Point({ x: 1, y: 2.5 });

console.log("declared", lib.symbols.fixture_add_i32(2, 3));
console.log("generic", lib.call("fixture_add_i32", [4, 5]));
console.log("inferred", bare.call("fixture_add_i32", [6, 7], ffi.i32));
console.log("point", point.x + point.y);
bare.close();
lib.close();
