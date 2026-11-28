"use strict";

// JSON (§6): envelopes, `toJSON`/`toPlain`, schema-driven `fromJSON`, schemaless `revive`, the
// codec registry and the pointer rules.

const { test, run, assert, equal, throwsCode } = require("./harness.js");
const ffi = require("onde:ffi");

class Timespec extends ffi.Struct {
  static fields = [["tv_sec", ffi.cLong], ["tv_nsec", ffi.cLong]];
  toMillis() {
    return Number(this.tv_sec) * 1e3 + Number(this.tv_nsec) / 1e6;
  }
}

class Bytes extends ffi.Struct {
  static fields = [["data", ffi.u8, 4], ["count", ffi.i32]];
}

class Sockaddr extends ffi.Struct {
  static fields = [["family", ffi.u16], ["addr", ffi.Ptr]];
}

test("an i64 value is enveloped by type, not magnitude", () => {
  const spec = new Timespec({ tv_sec: 1n, tv_nsec: 2n });
  equal(JSON.parse(JSON.stringify(spec)), {
    tv_sec: { $onde: { t: "bigint", v: "1" } },
    tv_nsec: { $onde: { t: "bigint", v: "2" } },
  });
});

test("special doubles are enveloped; ordinary doubles are not", () => {
  class D extends ffi.Struct {
    static fields = [["a", ffi.f64], ["b", ffi.f64], ["c", ffi.f64], ["d", ffi.f64]];
  }
  const value = new D({ a: NaN, b: Infinity, c: -Infinity, d: 1.5 });
  equal(JSON.parse(JSON.stringify(value)), {
    a: { $onde: { t: "f64", v: "NaN" } },
    b: { $onde: { t: "f64", v: "Infinity" } },
    c: { $onde: { t: "f64", v: "-Infinity" } },
    d: 1.5,
  });
});

test("a u8 array is one envelope, and pointers are encode-only", () => {
  const value = new Bytes({ data: new Uint8Array([1, 2, 3, 4]), count: 4 });
  const json = value.toJSON();
  equal(json.data.$onde.t, "u8array");
  equal(json.data.$onde.v, "AQIDBA==");

  const withPointer = new Sockaddr({ family: 2, addr: ffi.Ptr.from(0x1234n) });
  equal(withPointer.toJSON().addr, { $onde: { t: "ptr", v: "0x1234" } });
});

test("toPlain is the human form", () => {
  const spec = new Timespec({ tv_sec: 1720000000n, tv_nsec: 500n });
  equal(spec.toPlain(), { tv_sec: 1720000000, tv_nsec: 500 });
  const huge = new Timespec({ tv_sec: 9223372036854775807n, tv_nsec: 0n });
  equal(huge.toPlain().tv_sec, "9223372036854775807");
  const value = new Bytes({ data: new Uint8Array([1, 2, 3, 4]), count: 4 });
  equal(value.toPlain().data, "AQIDBA==");
});

test("fromJSON is schema-driven and undoes every envelope", () => {
  const spec = Timespec.fromJSON({
    tv_sec: { $onde: { t: "bigint", v: "1720000000" } },
    tv_nsec: { $onde: { t: "bigint", v: "5" } },
  });
  assert(spec instanceof Timespec, "expected a Timespec");
  equal(spec.tv_sec, 1720000000n);
  equal(spec.tv_nsec, 5n);
  // The millisecond form is a double at ~1.7e12, where 5 microseconds is below the ulp; assert
  // the magnitude rather than a value floating point cannot carry.
  assert(Math.abs(spec.toMillis() - 1720000000000) < 1, "toMillis lost the seconds");

  const value = Bytes.fromJSON({
    data: { $onde: { t: "u8array", v: "AQIDBA==" } },
    count: 4,
  });
  equal([...value.data], [1, 2, 3, 4]);

  const special = ffi.Struct.define([["x", ffi.f64]], { name: "Special" });
  equal(Number.isNaN(special.fromJSON({ x: { $onde: { t: "f64", v: "NaN" } } }).x), true);
});

test("a struct field revives recursively", () => {
  class Outer extends ffi.Struct {
    static fields = [["inner", Timespec], ["tag", ffi.i32]];
  }
  const outer = Outer.fromJSON({
    inner: { tv_sec: { $onde: { t: "bigint", v: "3" } }, tv_nsec: 0n },
    tag: 7,
  });
  assert(outer.inner instanceof Timespec, "expected the nested class");
  equal(outer.inner.tv_sec, 3n);
  equal(outer.tag, 7);
});

test("revive walks arbitrary graphs and leaves everything else alone", () => {
  const value = ffi.revive({
    n: { $onde: { t: "bigint", v: "123" } },
    f: { $onde: { t: "f64", v: "-0" } },
    a: [1, { $onde: { t: "u8array", v: "AQIDBA==" } }],
    plain: { nested: true },
  });
  equal(value.n, 123n);
  equal(Object.is(value.f, -0), true);
  equal([...value.a[1]], [1, 2, 3, 4]);
  equal(value.plain, { nested: true });
});

test("a pointer envelope is never revived", () => {
  throwsCode(
    () => ffi.revive({ p: { $onde: { t: "ptr", v: "0x1" } } }),
    "ERR_FFI_NOT_REVIVABLE",
  );
  throwsCode(
    () => Sockaddr.fromJSON({ family: 2, addr: { $onde: { t: "ptr", v: "0x1" } } }),
    "ERR_FFI_NOT_REVIVABLE",
  );
});

test("an unknown codec is an error", () => {
  throwsCode(
    () => ffi.revive({ x: { $onde: { t: "decimal", v: "1" } } }),
    "ERR_FFI_UNKNOWN_CODEC",
  );
});

test("a registered codec is used by revive", () => {
  ffi.Struct.codec("decimal", {
    encode: (value) => String(value),
    decode: (value) => Number(value) / 10,
  });
  equal(ffi.revive({ x: { $onde: { t: "decimal", v: "15" } } }).x, 1.5);
  equal(ffi.Struct.codecs.get("decimal") !== undefined, true);
});

test("a standalone struct has no class tag and is not revived", () => {
  const spec = new Timespec({ tv_sec: 1n, tv_nsec: 2n });
  const json = JSON.parse(JSON.stringify(spec));
  const revived = ffi.revive(json);
  assert(!(revived instanceof Timespec), "toJSON must stay free of class tags");
  equal(revived.tv_sec, 1n);
});

run();
