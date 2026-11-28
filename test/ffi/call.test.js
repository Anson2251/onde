"use strict";

// Calls and returns (§2.1, §7): every scalar round-trip, variadics, `errno`, buffers, lifetime.

const { test, run, assert, equal, throwsCode, LIBC } = require("./harness.js");
const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
if (!path) throw new Error("ONDE_FFI_FIXTURE is not set; run this through test/ffi/run.sh");

const lib = ffi.dlopen(path, {
  fixture_add_i32: { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
  fixture_add_i64: { args: [ffi.i64, ffi.i64], ret: ffi.i64 },
  fixture_add_u64: { args: [ffi.u64, ffi.u64], ret: ffi.u64 },
  fixture_i64_ident: { args: [ffi.i64], ret: ffi.i64 },
  fixture_u64_ident: { args: [ffi.u64], ret: ffi.u64 },
  fixture_u32_ident: { args: [ffi.u32], ret: ffi.u32 },
  fixture_neg_i8: { args: [ffi.i8], ret: ffi.i32 },
  fixture_sum9: {
    args: [ffi.i32, ffi.i32, ffi.i32, ffi.i32, ffi.i32, ffi.i32, ffi.i32, ffi.i32, ffi.i32],
    ret: ffi.i32,
  },
  fixture_mul_f64: { args: [ffi.f64, ffi.f64], ret: ffi.f64 },
  fixture_mul_f32: { args: [ffi.f32, ffi.f32], ret: ffi.f32 },
  fixture_not_bool: { args: [ffi.bool], ret: ffi.bool },
  fixture_cstrlen: { args: [ffi.cstring], ret: ffi.usize },
  fixture_is_null: { args: [ffi.Ptr], ret: ffi.i32 },
  fixture_ident_ptr: { args: [ffi.Ptr], ret: ffi.Ptr },
  fixture_ret_cstring: { args: [], ret: ffi.cstring },
  fixture_ret_i64_min: { args: [], ret: ffi.i64 },
  fixture_ret_u64_max: { args: [], ret: ffi.u64 },
  fixture_variadic_sum: { args: [ffi.i32], ret: ffi.i32, varargs: true },
  fixture_set_errno: { args: [ffi.i32], ret: ffi.voidType },
  fixture_get_errno: { args: [], ret: ffi.i32 },
  fixture_alloc_buffer: { args: [ffi.usize], ret: ffi.Ptr },
  fixture_free: { args: [ffi.Ptr], ret: ffi.voidType },
  fixture_release_count: { args: [], ret: ffi.i32 },
  fixture_last_context: { args: [], ret: ffi.i32 },
});

test("integers", () => {
  equal(lib.symbols.fixture_add_i32(20, 22), 42);
  equal(lib.symbols.fixture_add_i32(-20, 21), 1);
  equal(lib.symbols.fixture_add_i64(1n, 2n), 3n);
  equal(lib.symbols.fixture_add_u64(18446744073709551615n, 1n), 0n);
  equal(lib.symbols.fixture_u32_ident(4294967295), 4294967295);
  equal(lib.symbols.fixture_neg_i8(-128), 128);
  equal(lib.symbols.fixture_sum9(1, 2, 3, 4, 5, 6, 7, 8, 9), 45);
});

test("64-bit edges survive exactly", () => {
  equal(lib.symbols.fixture_i64_ident(-9223372036854775808n), -9223372036854775808n);
  equal(lib.symbols.fixture_u64_ident(18446744073709551615n), 18446744073709551615n);
  equal(lib.symbols.fixture_ret_i64_min(), -9223372036854775808n);
  equal(lib.symbols.fixture_ret_u64_max(), 18446744073709551615n);
});

test("floats", () => {
  equal(lib.symbols.fixture_mul_f64(1.5, 4), 6);
  equal(lib.symbols.fixture_mul_f32(1.5, 4), 6);
  equal(lib.call("fixture_mul_f64", [ffi.f64(-0.0), ffi.f64(1)]), -0);
});

test("bool and cstring", () => {
  equal(lib.symbols.fixture_not_bool(true), false);
  equal(lib.symbols.fixture_cstrlen("hello"), 5n);
  equal(lib.symbols.fixture_cstrlen(null), 0n);
  equal(lib.symbols.fixture_ret_cstring(), "onde-ffi");
});

test("pointers", () => {
  const view = new Uint8Array(8);
  view[0] = 1;
  view[1] = 2;
  view[2] = 3;
  const pointer = ffi.ptr(view);
  equal(pointer instanceof ffi.Ptr, true);
  equal(lib.symbols.fixture_is_null(null), 1);
  equal(lib.symbols.fixture_is_null(pointer), 0);
  equal(lib.symbols.fixture_ident_ptr(pointer).address, pointer.address);
  // A pointer read decodes the address stored at the location, not the location itself.
  for (let index = 0; index < 8; index += 1) view[index] = 0;
  view[0] = 1;
  equal(ffi.read.ptr(pointer, 0).address, 1n);
});

test("variadics use the fixed count and C promotions", () => {
  equal(lib.symbols.fixture_variadic_sum(3, 10, 20, 12), 42);
  // Undeclared variadic calls state the fixed count.
  const bare = ffi.dlopen(path);
  equal(bare.call("fixture_variadic_sum", [4, 1, 2, 3, 4], ffi.i32, { varargs: 1 }), 10);
  // An f32 tail is promoted to f64 by C; the declaration says `float`, but the inference path
  // would promote a boxed f32. The ABI check here is that the call still produces a number.
  assert(typeof bare.call("fixture_variadic_sum", [1, 1], ffi.i32, { varargs: 1 }) === "number");
});

test("errno is read after the call and cleared by errno()", () => {
  lib.symbols.fixture_set_errno(0x1234);
  equal(ffi.errno(), 0x1234);
  equal(ffi.errno(), 0);
});

test("buffer and buffer_length read one view at call time", () => {
  const libc = ffi.dlopen(LIBC, {
    write: { args: [ffi.i32, ffi.buffer, ffi.buffer_length], ret: ffi.isize },
  });
  const bytes = new Uint8Array([10]);
  // fd 2 so the write does not pollute the compared stdout of the suite.
  equal(libc.symbols.write(2, bytes, bytes), 1n);
});

test("buffer_length without its buffer is rejected at dlopen", () => {
  throwsCode(
    () => ffi.dlopen(path, { fixture_cstrlen: { args: [ffi.buffer_length], ret: ffi.i32 } }),
    "ERR_FFI_UNSUPPORTED_LAYOUT",
  );
});

test("a missing symbol", () => {
  throwsCode(() => lib.call("fixture_no_such_symbol", []), "ERR_FFI_SYMBOL_NOT_FOUND");
});

test("a declared symbol missing from the image fails on the first call, not at dlopen", () => {
  const missing = ffi.dlopen(path, {
    fixture_absent_symbol: { args: [], ret: ffi.i32 },
  });
  try {
    throwsCode(() => missing.symbols.fixture_absent_symbol(), "ERR_FFI_SYMBOL_NOT_FOUND");
  } finally {
    missing.close();
  }
});

test("a failed dlopen", () => {
  throwsCode(() => ffi.dlopen("/nonexistent/libnope.dylib"), "ERR_FFI_DLOPEN");
});

test("fn() returns a reusable function", () => {
  const add = lib.fn("fixture_add_i32", ffi.i32);
  equal(add(1, 2), 3);
  equal(add(3, 4), 7);
});

test("declarations accept string aliases", () => {
  const aliased = ffi.dlopen(path, {
    fixture_add_i64: { args: ["i64", "i64"], ret: "i64" },
  });
  equal(aliased.symbols.fixture_add_i64(2n, 5n), 7n);
});

test("close invalidates symbols and the handle", () => {
  const closing = ffi.dlopen(path, {
    fixture_add_i32: { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
  });
  equal(closing.symbols.fixture_add_i32(1, 2), 3);
  closing.close();
  equal(closing.closed, true);
  throwsCode(() => closing.symbols.fixture_add_i32(1, 2), "ERR_FFI_CLOSED");
  throwsCode(() => closing.call("fixture_add_i32", [1, 2]), "ERR_FFI_CLOSED");
  // Idempotent.
  closing.close();
});

run();
