"use strict";

// The acceptance example from docs/ffi-plan.md §2.1: open and close an in-memory SQLite database
// through `dlopen`. Skipped when the system library is absent, exactly as the plan allows.

const { test, run, assert, equal, throwsCode, LIBC } = require("./harness.js");
const ffi = require("onde:ffi");

function openSqlite() {
  const candidates =
    process.platform === "darwin"
      ? ["libsqlite3.dylib", "/usr/lib/libsqlite3.dylib"]
      : ["libsqlite3.so.0", "libsqlite3.so"];
  for (const candidate of candidates) {
    try {
      return { lib: ffi.dlopen(candidate), path: candidate };
    } catch (error) {
      if (error.code !== "ERR_FFI_DLOPEN") throw error;
    }
  }
  return null;
}

const found = openSqlite();

test("sqlite3 opens and closes through the §2.1 example", () => {
  if (found === null) {
    console.log("skipped: no system libsqlite3");
    return;
  }
  const lib = ffi.dlopen(found.path, {
    sqlite3_libversion: { args: [], ret: ffi.cstring },
    sqlite3_open_v2: { args: [ffi.cstring, ffi.Ptr.of(ffi.Ptr), ffi.i32, ffi.cstring], ret: ffi.i32 },
    sqlite3_close: { args: [ffi.Ptr], ret: ffi.i32 },
    sqlite3_errmsg: { args: [ffi.Ptr], ret: ffi.cstring },
  });
  equal(typeof lib.symbols.sqlite3_libversion(), "string");
  assert(/^\d+\.\d+/.test(lib.symbols.sqlite3_libversion()), "unexpected version string");

  const db = ffi.ref(ffi.Ptr);
  try {
    // SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
    const status = lib.symbols.sqlite3_open_v2(":memory:", db, 0x2 | 0x4, null);
    equal(status, 0, `sqlite3_open_v2 failed: ${status}`);
    assert(db.value !== null, "sqlite3** out-param was not written");
    equal(lib.symbols.sqlite3_close(db.value), 0);
  } finally {
    db.free();
  }
});

test("a bare handle still refuses close while an owned buffer is live", () => {
  if (found === null) {
    console.log("skipped: no system libsqlite3");
    return;
  }
  const bare = ffi.dlopen(found.path);
  const sys = ffi.dlopen(LIBC, {
    dlopen: { args: [ffi.cstring, ffi.i32], ret: ffi.Ptr },
    dlsym: { args: [ffi.Ptr, ffi.cstring], ret: ffi.Ptr },
  });
  const handle = sys.symbols.dlopen(found.path, 2);
  const allocate = sys.call(
    "dlsym",
    [handle, "sqlite3_malloc"],
    ffi.Callback.of([ffi.i32], ffi.Ptr),
  );
  const release = sys.call("dlsym", [handle, "sqlite3_free"], ffi.Ptr);
  const memory = allocate(32);
  assert(memory !== null, "sqlite3_malloc returned null");
  const buffer = ffi.toArrayBuffer(memory, 0, 32, release);
  try {
    throwsCode(() => bare.close(), "ERR_FFI_LIVE_REFERENCES");
  } finally {
    // Detaching releases the block and the live count.
    structuredClone(buffer, { transfer: [buffer] });
  }
  bare.close();
});

run();
