"use strict";

// `Callback` (§9): same-thread invocation, pointer arguments, exception parking and the v1
// threadsafe refusal.

const { test, run, assert, equal, throwsCode } = require("./harness.js");
const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
if (!path) throw new Error("ONDE_FFI_FIXTURE is not set; run this through test/ffi/run.sh");

const lib = ffi.dlopen(path, {
    fixture_call_cb: {
        args: [ffi.Callback.of([ffi.i32, ffi.i32], ffi.i32), ffi.i32, ffi.i32],
        ret: ffi.i32,
    },
    fixture_call_cb_n: { args: [ffi.Callback.of([ffi.i32], ffi.i32), ffi.i32], ret: ffi.i32 },
    fixture_call_cb_ptrs: {
        args: [
            ffi.Callback.of([ffi.Ptr.of(ffi.i32), ffi.Ptr.of(ffi.i32)], ffi.i32),
            ffi.i32,
            ffi.i32,
        ],
        ret: ffi.i32,
    },
    fixture_call_cb_thread: { args: [ffi.Callback.of([ffi.i32], ffi.i32), ffi.i32], ret: ffi.i32 },
    fixture_add_i32: { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
});

test("a comparator runs inline", () => {
    const compare = new ffi.Callback((a, b) => a - b, {
        args: [ffi.i32, ffi.i32],
        ret: ffi.i32,
    });
    try {
        equal(lib.symbols.fixture_call_cb(compare, 20, 22), -2);
        assert(compare.ptr instanceof ffi.Ptr, "Callback.ptr must be a Ptr");
    } finally {
        compare.close();
    }
});

test("the callback is invoked exactly N times", () => {
    let calls = 0;
    const accumulate = new ffi.Callback(
        (i) => {
            calls += 1;
            return i * 2;
        },
        { args: [ffi.i32], ret: ffi.i32 },
    );
    try {
        equal(lib.symbols.fixture_call_cb_n(accumulate, 5), 20);
        equal(calls, 5);
        equal(lib.symbols.fixture_call_cb_n(accumulate, 0), 0);
        equal(calls, 5);
    } finally {
        accumulate.close();
    }
});

test("pointer arguments are readable in the callback", () => {
    const multiply = new ffi.Callback((a, b) => ffi.read.i32(a, 0) * ffi.read.i32(b, 0), {
        args: [ffi.Ptr.of(ffi.i32), ffi.Ptr.of(ffi.i32)],
        ret: ffi.i32,
    });
    try {
        equal(lib.symbols.fixture_call_cb_ptrs(multiply, 6, 7), 42);
    } finally {
        multiply.close();
    }
});

test("a callback can re-enter FFI", () => {
    const reentrant = new ffi.Callback((a) => lib.symbols.fixture_add_i32(a, 1), {
        args: [ffi.i32],
        ret: ffi.i32,
    });
    try {
        equal(lib.symbols.fixture_call_cb_n(reentrant, 4), 10);
    } finally {
        reentrant.close();
    }
});

test("a thrown callback exception surfaces after the outer call", () => {
    const bad = new ffi.Callback(
        () => {
            throw new Error("boom from callback");
        },
        { args: [ffi.i32, ffi.i32], ret: ffi.i32 },
    );
    try {
        let caught = null;
        try {
            lib.symbols.fixture_call_cb(bad, 1, 2);
        } catch (error) {
            caught = error;
        }
        assert(caught !== null, "the callback exception did not surface");
        equal(caught.message, "boom from callback");
        // The engine is still healthy after the parked exception.
        equal(lib.symbols.fixture_add_i32(2, 3), 5);
    } finally {
        bad.close();
    }
});

test("the callback return type is coerced", () => {
    const truthy = new ffi.Callback(() => true, { args: [ffi.i32], ret: ffi.bool });
    try {
        // fixture_call_cb_n sums an int; a bool return is read as 1.
        equal(lib.symbols.fixture_call_cb_n(truthy, 3), 3);
    } finally {
        truthy.close();
    }
});

test("closing the library from inside a call is refused", () => {
    const owner = ffi.dlopen(path, {
        fixture_call_cb_n: { args: [ffi.Callback.of([ffi.i32], ffi.i32), ffi.i32], ret: ffi.i32 },
    });
    let closeCode = null;
    const inside = new ffi.Callback(
        (i) => {
            try {
                owner.close();
            } catch (error) {
                closeCode = error.code;
            }
            return i;
        },
        { args: [ffi.i32], ret: ffi.i32 },
    );
    try {
        owner.symbols.fixture_call_cb_n(inside, 1);
        equal(closeCode, "ERR_FFI_LIVE_REFERENCES");
        // The image is still loaded, so the handle works after the call.
        equal(owner.symbols.fixture_call_cb_n(inside, 2), 1);
    } finally {
        inside.close();
        owner.close();
    }
});

test("closing a callback from inside itself is refused", () => {
    const holder = { callback: null };
    let closeCode = null;
    holder.callback = new ffi.Callback(
        (i) => {
            try {
                holder.callback.close();
            } catch (error) {
                closeCode = error.code;
            }
            return i;
        },
        { args: [ffi.i32], ret: ffi.i32 },
    );
    try {
        equal(lib.symbols.fixture_call_cb_n(holder.callback, 2), 1);
        equal(closeCode, "ERR_FFI_LIVE_REFERENCES");
    } finally {
        holder.callback.close();
    }
});

test("a callback invoked from a foreign thread does not enter the engine", () => {
    let entered = false;
    const foreign = new ffi.Callback(
        (value) => {
            entered = true;
            return value + 1;
        },
        { args: [ffi.i32], ret: ffi.i32 },
    );
    try {
        // The trampoline refuses to enter QuickJS off the isolate thread and zeroes the return.
        equal(lib.symbols.fixture_call_cb_thread(foreign, 41), 0);
        equal(entered, false);
        // The isolate is still healthy.
        equal(lib.symbols.fixture_add_i32(2, 3), 5);
    } finally {
        foreign.close();
    }
});

test("a closed callback cannot be passed as an argument", () => {
    const closed = new ffi.Callback(() => 1, { args: [ffi.i32, ffi.i32], ret: ffi.i32 });
    closed.close();
    throwsCode(() => lib.symbols.fixture_call_cb(closed, 1, 2), "ERR_FFI_CLOSED");
});

test("threadsafe callbacks are refused in v1", () => {
    throwsCode(
        () => new ffi.Callback(() => {}, { args: [], ret: ffi.voidType, threadsafe: true }),
        "ERR_FFI_UNSUPPORTED_THREADSAFE",
    );
});

test("a callback can be disposed with using", () => {
    const disposed = new ffi.Callback(() => 1, { args: [], ret: ffi.i32 });
    disposed[Symbol.dispose]();
    disposed.close(); // idempotent
});

run();
