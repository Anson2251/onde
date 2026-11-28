"use strict";

// Signature resolution and inference (§4).
//
// A declared signature is authoritative; typed values carry their type; untyped primitives are
// inferred only when they are unambiguous, and everything else throws with the position named.

const { test, run, assert, equal, throwsCode } = require("./harness.js");
const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
if (!path) throw new Error("ONDE_FFI_FIXTURE is not set; run this through test/ffi/run.sh");

const declared = ffi.dlopen(path, {
    fixture_add_i32: { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
    fixture_mul_f64: { args: [ffi.f64, ffi.f64], ret: ffi.f64 },
    fixture_cstrlen: { args: [ffi.cstring], ret: ffi.usize },
    fixture_ret_i64_min: { args: [], ret: ffi.i64 },
    fixture_not_bool: { args: [ffi.bool], ret: ffi.bool },
    fixture_is_null: { args: [ffi.Ptr], ret: ffi.i32 },
});

const lib = ffi.dlopen(path);

test("every type answers bytes and align", () => {
    for (const type of [
        ffi.i32,
        ffi.i64,
        ffi.f64,
        ffi.bool,
        ffi.cstring,
        ffi.voidType,
        ffi.Ptr,
        ffi.Callback,
        ffi.Ptr.of(ffi.i32),
        ffi.Callback.of([], ffi.i32),
    ]) {
        assert(Number.isInteger(type.bytes), `${type.name}: bytes is not an integer`);
        assert(Number.isInteger(type.align), `${type.name}: align is not an integer`);
    }
    equal(ffi.Ptr.bytes, 8);
    equal(ffi.Callback.bytes, 8);
    equal(ffi.voidType.bytes, 0);
    // Pointer-sized and C-long-sized tokens follow the target, not a constant.
    equal(ffi.isize.bytes, ffi.Ptr.bytes);
    equal(ffi.usize.bytes, ffi.Ptr.bytes);
    assert([4, 8].includes(ffi.cLong.bytes), "cLong must be 4 or 8 bytes");
    equal(ffi.buffer_length.bytes, ffi.usize.bytes);
    const usizeMax = 2n ** BigInt(ffi.usize.bytes * 8) - 1n;
    equal(ffi.usize(usizeMax).value, ffi.usize.bytes === 8 ? usizeMax : Number(usizeMax));
});

test("an int-tagged number infers i32", () => {
    equal(lib.call("fixture_add_i32", [2, 3]), 5);
});

test("Math.trunc keeps an int tag", () => {
    equal(lib.call("fixture_add_i32", [Math.trunc(2.9), Math.trunc(3.9)]), 5);
});

test("a string infers cstring", () => {
    equal(declared.symbols.fixture_cstrlen("hello"), 5n);
});

test("a boolean infers bool", () => {
    equal(declared.symbols.fixture_not_bool(true), false);
    equal(declared.symbols.fixture_not_bool(false), true);
});

test("a BigInt infers i64", () => {
    equal(lib.call("fixture_add_i64", [1n, 2n], ffi.i64), 3n);
});

test("null infers a null pointer", () => {
    equal(declared.symbols.fixture_is_null(null), 1);
});

test("a typed value carries its type", () => {
    equal(lib.call("fixture_mul_f64", [ffi.f64(1.5), ffi.f64(4)], ffi.f64), 6);
});

test("a float-tagged number is refused", () => {
    // `w * 0.5` goes through `js_float64`, so the tag stays float even though the product is
    // integral (§4.3).
    throwsCode(() => lib.call("fixture_add_i32", [2 * 0.5, 3 * 0.5]), "ERR_FFI_AMBIGUOUS_ARGUMENT");
});

test("division is value-dependent, which is why it is refused", () => {
    // `4 / 2` is normalized through `js_number` and takes the int tag; `3 / 2` stays float. The
    // suite asserts both halves so the surprising case cannot regress into a silent wrong call.
    equal(lib.call("fixture_add_i32", [4 / 2, 2 / 2]), 3);
    throwsCode(() => lib.call("fixture_add_i32", [3 / 2, 2 / 2]), "ERR_FFI_AMBIGUOUS_ARGUMENT");
});

test("undefined is a missing argument, not a null pointer", () => {
    throwsCode(() => lib.call("fixture_add_i32", [1, undefined]), "ERR_FFI_MISSING_ARGUMENT");
});

test("a struct instance is ambiguous by value or pointer", () => {
    class Pair extends ffi.Struct {
        static fields = [
            ["a", ffi.i32],
            ["b", ffi.i32],
        ];
    }
    throwsCode(() => lib.call("fixture_pair_sum", [new Pair()]), "ERR_FFI_AMBIGUOUS_ARGUMENT");
});

test("a bare function is ambiguous", () => {
    throwsCode(() => lib.call("fixture_add_i32", [() => 1, 2]), "ERR_FFI_AMBIGUOUS_ARGUMENT");
});

test("a 64-bit parameter outside int32 needs a declaration or a box", () => {
    // Inference refuses a number outside int32 rather than silently widening it.
    throwsCode(() => lib.call("fixture_i64_ident", [2147483648]), "ERR_FFI_AMBIGUOUS_ARGUMENT");
    equal(lib.call("fixture_i64_ident", [ffi.i64(2147483648)], ffi.i64), 2147483648n);
});

test("an undeclared symbol defaults its return to i32", () => {
    // The fixture's `int32_t`-shaped symbol is read as an int; `usize` must be stated.
    equal(lib.call("fixture_add_i32", [1, 2]), 3);
});

test("an omitted ret defers to the declaration", () => {
    equal(declared.symbols.fixture_ret_i64_min(), -9223372036854775808n);
});

test("a declared return may not change ABI class", () => {
    throwsCode(
        () => declared.call("fixture_ret_i64_min", [], ffi.i32),
        "ERR_FFI_SIGNATURE_CONFLICT",
    );
});

test("a pointer return may be refined to a callback", () => {
    const libc = ffi.dlopen(ffi.libcName, {
        dlopen: { args: [ffi.cstring, ffi.i32], ret: ffi.Ptr },
        dlsym: { args: [ffi.Ptr, ffi.cstring], ret: ffi.Ptr },
    });
    const handle = libc.symbols.dlopen(path, 2);
    const fn = libc.call(
        "dlsym",
        [handle, "fixture_ret_cstring"],
        ffi.Callback.of([], ffi.cstring),
    );
    equal(typeof fn, "function");
    equal(fn(), "onde-ffi");
});

test("a declaration that omitted ret still means i32, so an i64 refinement conflicts", () => {
    const implicit = ffi.dlopen(path, { fixture_add_i32: { args: [ffi.i32, ffi.i32] } });
    equal(implicit.symbols.fixture_add_i32(1, 2), 3);
    throwsCode(
        () => implicit.call("fixture_add_i32", [1, 2], ffi.i64),
        "ERR_FFI_SIGNATURE_CONFLICT",
    );
});

test("too few declared arguments throw", () => {
    throwsCode(() => declared.call("fixture_add_i32", [1]), "ERR_FFI_MISSING_ARGUMENT");
});

test("more than four shapes for one symbol is an error, not a silent wrong call", () => {
    const shapes = ffi.dlopen(path);
    // `fixture_is_null(const void*)` accepts every pointer-sized slot safely; the shapes differ in
    // the JS types, which is exactly what the cache limit is about.
    shapes.call("fixture_is_null", [1]);
    shapes.call("fixture_is_null", [1n]);
    shapes.call("fixture_is_null", [ffi.f64(1)]);
    shapes.call("fixture_is_null", [ffi.ptr(new Uint8Array(1))]);
    throwsCode(() => shapes.call("fixture_is_null", ["x"]), "ERR_FFI_SHAPE_LIMIT");
});

run();
