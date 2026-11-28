"use strict";

// `Struct` (§5): layout against the compiled C oracle, by-value arguments and returns, views,
// definition-time validation and the reserved-name rule.

const { test, run, assert, equal, throwsCode } = require("./harness.js");
const ffi = require("onde:ffi");

const path = process.env.ONDE_FFI_FIXTURE;
const oraclePath = process.env.ONDE_FFI_ORACLE;
if (!path || !oraclePath) {
  throw new Error("ONDE_FFI_FIXTURE/ONDE_FFI_ORACLE are unset; run this through test/ffi/run.sh");
}

class Pair extends ffi.Struct {
  static fields = [["a", ffi.i32], ["b", ffi.i32]];
}
class Mixed extends ffi.Struct {
  static fields = [
    ["c", ffi.i8],
    ["i", ffi.i32],
    ["d", ffi.f64],
    ["p", ffi.Ptr],
    ["s", ffi.i16],
  ];
}
class Nested extends ffi.Struct {
  static fields = [["pair", Pair], ["tail", ffi.i32]];
}
class ArrayStruct extends ffi.Struct {
  static fields = [["bytes", ffi.u8, 8], ["n", ffi.i32]];
}
class Big extends ffi.Struct {
  static fields = [
    ["d", ffi.f64],
    ["l", ffi.i64],
    ["u8", ffi.u8],
    ["s16", ffi.i16],
    ["f32", ffi.f32],
  ];
}

const lib = ffi.dlopen(path, {
  fixture_pair_sum: { args: [Pair], ret: ffi.i32 },
  fixture_pair_make: { args: [ffi.i32, ffi.i32], ret: Pair },
  fixture_pair_out: { args: [ffi.i32, ffi.i32, ffi.Ptr.of(Pair)], ret: ffi.i32 },
  fixture_mixed_weight: { args: [Mixed], ret: ffi.f64 },
  fixture_array_sum: { args: [ArrayStruct], ret: ffi.i32 },
});

// --- layout against the compiler ------------------------------------------------------------

function readOracle() {
  const fs = require("fs");
  const text = fs.readFileSync(oraclePath, "utf8");
  const structs = new Map();
  const offsets = new Map();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3) {
      const [name, size, align] = parts;
      if (name.includes(".")) continue;
      structs.set(name, { size: Number(size), align: Number(align) });
    } else if (parts.length === 2 && parts[0].includes(".")) {
      offsets.set(parts[0], Number(parts[1]));
    }
  }
  return { structs, offsets };
}

const oracle = readOracle();

test("every struct's sizeof/_Alignof/offsets match the compiler", () => {
  const cases = [
    ["FixturePair", Pair],
    ["FixtureMixed", Mixed],
    ["FixtureNested", Nested],
    ["FixtureArray", ArrayStruct],
    ["FixtureBig", Big],
  ];
  for (const [name, cls] of cases) {
    const expected = oracle.structs.get(name);
    assert(expected !== undefined, `oracle has no entry for ${name}`);
    equal(cls.bytes, expected.size, `${name}.bytes`);
    equal(cls.align, expected.align, `${name}.align`);
    equal([...cls.offsets], cls.fields.map(([field]) => oracle.offsets.get(`${name}.${field}`)),
      `${name}.offsets`);
  }
});

// --- by value and out-params ----------------------------------------------------------------

test("a struct argument is passed by value", () => {
  equal(lib.symbols.fixture_pair_sum(new Pair({ a: 7, b: 35 })), 42);
  // An initializer object is accepted wherever an instance is.
  equal(lib.symbols.fixture_pair_sum({ a: 1, b: 2 }), 3);
});

test("a struct return is decoded into an instance", () => {
  const pair = lib.symbols.fixture_pair_make(11, 31);
  assert(pair instanceof Pair, "expected a Pair instance");
  equal(pair.a, 11);
  equal(pair.b, 31);
});

test("a struct out-param is written through ref(T)", () => {
  const out = ffi.ref(Pair);
  try {
    equal(lib.symbols.fixture_pair_out(5, 6, out), 0);
    equal(out.value.a, 5);
    equal(out.value.b, 6);
  } finally {
    out.free();
  }
});

test("every mixed field is marshalled at its computed offset", () => {
  const mixed = new Mixed({ c: 65, i: 10, d: 1.5, p: ffi.Ptr.from(1n), s: 3 });
  equal(lib.symbols.fixture_mixed_weight(mixed), 80.5);
  mixed.p = null;
  equal(lib.symbols.fixture_mixed_weight(mixed), 79.5);
});

// --- views -----------------------------------------------------------------------------------

test("a view reads and writes in place", () => {
  const storage = new Int32Array([9, 12]);
  const view = Pair.view(ffi.ptr(storage));
  equal(view.a, 9);
  equal(view.b, 12);
  view.a = 40;
  equal(storage[0], 40);
  equal(view.get("b"), 12);
  view.set("b", 2);
  equal(storage[1], 2);
  equal(JSON.stringify(view), '{"a":40,"b":2}');
});

test("a nested struct field returns a sub-view", () => {
  const bytes = new Uint8Array(Nested.bytes);
  const view = Nested.view(ffi.ptr(bytes));
  const pair = view.pair;
  pair.a = 7;
  pair.b = 8;
  assert(pair.a === 7 && pair.b === 8, "nested view did not write in place");
  equal(view.get("tail"), 0);
});

test("an array field is an indexed view", () => {
  const storage = new Uint8Array(ArrayStruct.bytes);
  const view = ArrayStruct.view(ffi.ptr(storage));
  // `bytes` is a reserved protocol name, so the field is reached through get()/set().
  const data = view.get("bytes");
  data[0] = 5;
  data[7] = 9;
  equal(data[0], 5);
  equal(data[7], 9);
  equal(data.length, 8);
  equal(storage[0], 5);
  equal(storage[7], 9);
});

// --- definition and validation --------------------------------------------------------------

test("Struct.define creates an anonymous subclass with ffiName", () => {
  const Sockaddr = ffi.Struct.define(
    [["family", ffi.u16], ["path", ffi.u8, 108]],
    { name: "SockaddrUn", ffiName: "sockaddr_un" },
  );
  equal(Sockaddr.ffiName, "sockaddr_un");
  equal(Sockaddr.fieldCount, 2);
  equal(Sockaddr.offsetOf("path"), 2);
  const field = Sockaddr.fieldOf("path");
  equal(field.offset, 2);
  equal(field.bytes, 108);
  equal(field.align, 1);
  assert(Object.isFrozen(Sockaddr.offsets), "offsets must be frozen");
});

test("a field type string alias is accepted", () => {
  const Alias = ffi.Struct.define([["x", "i64"]], { name: "Alias" });
  equal(Alias.bytes, 8);
});

test("recursive by-value structs are refused", () => {
  class Loop extends ffi.Struct {
    static fields = [["next", Loop]];
  }
  throwsCode(() => Loop.bytes, "ERR_FFI_RECURSIVE_STRUCT");
});

test("a self-reference through a pointer is legal", () => {
  class Node extends ffi.Struct {
    static fields = [["value", ffi.i32], ["next", ffi.Ptr.of(Node)]];
  }
  equal(Node.bytes, 16);
  const node = new Node({ value: 1, next: null });
  equal(node.value, 1);
  equal(node.next, null);
});

test("field names and types are validated at definition time", () => {
  class BadName extends ffi.Struct {
    static fields = [["1nope", ffi.i32]];
  }
  throwsCode(() => BadName.bytes, "ERR_INVALID_ARG_VALUE");

  class Duplicate extends ffi.Struct {
    static fields = [["x", ffi.i32], ["x", ffi.i32]];
  }
  throwsCode(() => Duplicate.bytes, "ERR_INVALID_ARG_VALUE");

  class BadCount extends ffi.Struct {
    static fields = [["x", ffi.i32, 0]];
  }
  throwsCode(() => BadCount.bytes, "ERR_INVALID_ARG_VALUE");
});

test("a wrong value throws instead of truncating", () => {
  throwsCode(() => new Pair({ a: 2.5 }), "ERR_INVALID_ARG_VALUE");
  throwsCode(() => new Pair({ a: 2147483648 }), "ERR_INVALID_ARG_VALUE");
  throwsCode(() => new Pair({ nope: 1 }), "ERR_INVALID_ARG_VALUE");
});

test("reserved field names are reachable through get/set, not accessors", () => {
  class Reserved extends ffi.Struct {
    static fields = [["size", ffi.i32], ["address", ffi.i32], ["then", ffi.i32]];
  }
  const value = new Reserved({ size: 9, address: 8, then: 7 });
  // `size` is the Map protocol's field count, not the C field.
  equal(value.size, 3);
  equal(value.get("size"), 9);
  equal(value.get("address"), 8);
  equal(value.get("then"), 7);
  equal(value.address, undefined);
  value.set("size", 10);
  equal(value.get("size"), 10);
});

test("instance iteration is declaration-ordered", () => {
  const pair = new Pair({ a: 1, b: 2 });
  equal([...pair.keys()], ["a", "b"]);
  equal([...pair.values()], [1, 2]);
  equal([...pair.entries()], [["a", 1], ["b", 2]]);
  equal(pair instanceof Pair, true);
  equal(pair.bytes, 8);
  equal(pair.has("a"), true);
  equal(pair.has("nope"), false);
});

test("an array by value is refused with a pointer escape hatch", () => {
  // The struct itself is layout-only; passing it by value hits libffi's documented array
  // emulation limit and must be an error, not an ABI gamble.
  const arr = new ArrayStruct({ n: 4 });
  throwsCode(() => lib.symbols.fixture_array_sum(arr), "ERR_FFI_UNSUPPORTED_LAYOUT");

  const bytes = ffi.ref(ffi.CArray.of(ffi.u8, 8));
  try {
    // Writing through the array ref is the pointer escape hatch.
    equal(bytes.value.length, 8);
  } finally {
    bytes.free();
  }
});

run();
