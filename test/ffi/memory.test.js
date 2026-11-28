"use strict";

// Memory and lifetime (§8): zero-copy external buffers, the deallocator contract, `CString`,
// one-shot reads and `close()`'s live-reference rule.

const { test, run, assert, equal, throwsCode, LIBC } = require("./harness.js");
const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
if (!path) throw new Error("ONDE_FFI_FIXTURE is not set; run this through test/ffi/run.sh");

const lib = ffi.dlopen(path, {
  fixture_alloc: { args: [ffi.usize], ret: ffi.Ptr },
  fixture_free: { args: [ffi.Ptr], ret: ffi.voidType },
  fixture_alloc_buffer: { args: [ffi.usize], ret: ffi.Ptr },
  fixture_cstrlen: { args: [ffi.cstring], ret: ffi.usize },
  fixture_release: { args: [ffi.Ptr, ffi.Ptr], ret: ffi.voidType },
  fixture_release_count: { args: [], ret: ffi.i32 },
  fixture_last_context: { args: [], ret: ffi.i32 },
  fixture_ret_cstring: { args: [], ret: ffi.cstring },
});

test("alloc/free round-trip through the host", () => {
  const block = ffi.dlopen(path).call("fixture_alloc", [16], ffi.Ptr);
  assert(block instanceof ffi.Ptr, "expected a Ptr");
  ffi.dlopen(path).call("fixture_free", [block]);
});

test("a borrowed external buffer is zero-copy and readable", () => {
  const base = lib.symbols.fixture_alloc_buffer(16);
  const buffer = ffi.toArrayBuffer(base, 0, 16);
  const bytes = new Uint8Array(buffer);
  equal(bytes.length, 16);
  equal(bytes[0], 0);
  equal(bytes[15], 15);
  lib.symbols.fixture_free(base);
});

test("CString clones out of native memory", () => {
  equal(lib.symbols.fixture_ret_cstring(), "onde-ffi");
  const base = lib.symbols.fixture_alloc_buffer(8);
  const text = lib.call("fixture_ret_cstring");
  equal(text, "onde-ffi");
  lib.symbols.fixture_free(base);
});

test("one-shot reads cover every scalar width", () => {
  const view = new Uint8Array(16);
  const pointer = ffi.ptr(view);
  view[0] = 0xff;
  equal(ffi.read.u8(pointer, 0), 255);
  equal(ffi.read.i8(pointer, 0), -1);
  view[0] = 1;
  view[1] = 0;
  view[2] = 0;
  view[3] = 0;
  equal(ffi.read.u32(pointer, 0), 1);
  equal(ffi.read.i32(pointer, 0), 1);
  equal(typeof ffi.read.f64(pointer, 0), "number");
  // A pointer read decodes the address stored at the location, not the location itself.
  equal(ffi.read.ptr(pointer, 0).address, 1n);
});

test("a deallocator-backed buffer counts as a live reference for close()", () => {
  const sys = ffi.dlopen(LIBC, {
    dlopen: { args: [ffi.cstring, ffi.i32], ret: ffi.Ptr },
    dlsym: { args: [ffi.Ptr, ffi.cstring], ret: ffi.Ptr },
  });
  const handle = sys.symbols.dlopen(path, 2);
  const release = sys.call("dlsym", [handle, "fixture_release"], ffi.Ptr);
  assert(release !== null, "fixture_release was not found");
  const base = lib.symbols.fixture_alloc_buffer(8);
  const buffer = ffi.toArrayBuffer(base, 0, 8, release, 0x1234);
  equal(Array.from(new Uint8Array(buffer)).slice(0, 4).join(","), "0,1,2,3");
  throwsCode(() => lib.close(), "ERR_FFI_LIVE_REFERENCES");

  // Detaching runs the deallocator immediately, which is the deterministic release path.
  const moved = structuredClone(buffer, { transfer: [buffer] });
  equal(new Uint8Array(moved).length, 8);
  equal(buffer.byteLength, 0);

  const counter = ffi.dlopen(path, {
    fixture_release_count: { args: [], ret: ffi.i32 },
    fixture_last_context: { args: [], ret: ffi.i32 },
  });
  equal(counter.symbols.fixture_release_count(), 1);
  equal(counter.symbols.fixture_last_context(), 0x1234);
  lib.close();
});

test("callbacks and refs do not block close()", () => {
  const owner = ffi.dlopen(path, {
    fixture_call_cb_n: { args: [ffi.Callback.of([ffi.i32], ffi.i32), ffi.i32], ret: ffi.i32 },
  });
  class Pair extends ffi.Struct {
    static fields = [["a", ffi.i32], ["b", ffi.i32]];
  }
  const callback = new ffi.Callback((i) => i, { args: [ffi.i32], ret: ffi.i32 });
  const handle = ffi.ref(Pair);
  try {
    owner.close();
  } finally {
    callback.close();
    handle.free();
  }
});

test("ref(T) zero-fills and encodes on write", () => {
  class Pair extends ffi.Struct {
    static fields = [["a", ffi.i32], ["b", ffi.i32]];
  }
  const handle = ffi.ref(Pair);
  try {
    equal(handle.value.a, 0);
    equal(handle.value.b, 0);
    handle.value = { a: 3, b: 4 };
    equal(handle.value.a, 3);
    equal(handle.value.b, 4);
  } finally {
    handle.free();
    handle.free(); // idempotent
  }
});

run();
