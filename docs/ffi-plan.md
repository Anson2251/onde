# FFI (`onde:ffi`) — implementation plan

This is the working contract for `dlopen`-based FFI: where it lives, what the public surface is,
what the inference rules are, and what is deliberately left out. The decision record is
[ADR-0010](adr/0010-ffi-dlopen.md). [roadmap.md](roadmap.md) keeps N-API and native addons out of
1.0; this work is M10 (1.1), after the M9 permissions model, and does not sit on the M0–M8
critical path.

Status: **design, 2026-11-24. Not implemented. Target: M10.** No `ln-ffi` crate, module or CLI
flag exists yet. Where this document and the code disagree later, this document is the intent and
the code is the truth; update this file with the code in the same change.

## 1. What ships, in one table

| Area | Ships | Does not ship (documented) |
|---|---|---|
| Loading | `dlopen`, symbol binding for declared symbols, `call`/`fn` for the rest, `close` | N-API, `process.dlopen`, symbol versioning, C++ demangling, `linkSymbols` |
| Types | integers, floats, `bool`, `cstring`, `Ptr.of`, `CArray.of`, structs, callbacks | bitfields, flexible array members, unions (v1), `long double`, `__int128`, packed structs (v1) |
| Calls | declared signatures, inferred arguments, optional per-call return type (default `i32`), variadics, out-params via `ref` | async or nonblocking calls; cross-thread synchronous callbacks |
| Structs | class definitions, host layout, accessors, `bytes`/`align`/`offsets`/`offsetOf`/`fieldOf`, typed views, JSON | by-value unions, header parsing or bindgen, zero-copy instances |
| JSON | `$onde` envelopes, codec registry, `toJSON`/`toPlain`/`fromJSON`/`revive` | reviving a standalone struct without its class |
| Gates | build feature `ffi`, `Config::ffi`, `--allow-ffi` | a sandbox: FFI is unrestricted native code |
| Portability | macOS and Linux, x86_64 and aarch64 | Windows (v1), musl static (untested) |

## 2. Public surface

```js
const {
  dlopen, Struct, Ptr, CArray, Callback, ref, revive, errno,
  ptr, read, toArrayBuffer, CString, voidType,
  i8, i16, i32, i64, u8, u16, u32, u64, isize, usize, cLong,
  f32, f64, bool, cstring, buffer, buffer_length,
} = require("onde:ffi");
```

`voidType` rather than `void` because `void` is an operator, not an identifier.

### 2.1 `dlopen`

```js
const lib = dlopen("libsqlite3.dylib", {
  sqlite3_libversion: { args: [], ret: cstring },
  sqlite3_open_v2:    { args: [cstring, Ptr.of(Ptr), i32, cstring], ret: i32 },
});

const { sqlite3_libversion, sqlite3_open_v2 } = lib.symbols;
const db = ref(Ptr);                                  // sqlite3** out-param
sqlite3_open_v2(":memory:", db, 0x2 | 0x4, null);
```

The returned object is `{ path, symbols, call, fn, close }`.

| member | meaning |
|---|---|
| `path` | the path handed to `dlopen` |
| `symbols` | one function per declared symbol; absent for undeclared ones |
| `call(name, args, ret?, options?)` | one call to an arbitrary symbol; an omitted `ret` uses the declaration's, else `i32`; an explicit `ret` that is not ABI-compatible with a declared symbol throws `ERR_FFI_SIGNATURE_CONFLICT` (compatible refinements are allowed, §4.1) |
| `fn(name, ret?, options?)` | a reusable function; an omitted `ret` uses the declaration's, else `i32`; a declared symbol's arguments are used as declared, an undeclared one's are inferred per shape and cached; same conflict rule |
| `close()` | unloads and invalidates every symbol from this handle (later calls throw `ERR_FFI_CLOSED`); throws `ERR_FFI_LIVE_REFERENCES` while a deallocator-backed external buffer is live |

Declarations are optional and may be partial. `options` has one key, `{ varargs: n }` — the number of
fixed arguments, defaulting to `true` meaning one — needed only when a variadic symbol is called
without a declaration. `call`, `fn` and `close` are bound methods, so destructuring the returned
object is safe.

Bare `Ptr` means `void*`; `Ptr.of(Ptr)` means `void**`; `Ptr.of(SomeStruct)` means `SomeStruct*`.

An undeclared library is just the same call with no second argument, and an omitted `ret` reads an
`int`:

```js
const { call } = dlopen("libc.dylib");
call("getpid");                     // i32 by default
call("strlen", [buf], usize);       // 64-bit return, stated
```

## 3. Type system

A type is either a callable scalar, a `Ptr`/`CArray` descriptor, `cstring`, a `Callback` type, or a
struct class. Every type answers `bytes` and `align`; every scalar is also a boxer (`f64(2)`
produces a typed value, `f64.bytes` is 8, and `args: [f64]` uses the type itself).

| Type | C type | bytes | align | JS value | coercion on set / argument |
|---|---|---|---|---|---|
| `i8`, `i16`, `i32` | `int8_t` … `int32_t` | 1/2/4 | 1/2/4 | number | integer in range; BigInt accepted if in range |
| `u8`, `u16`, `u32` | `uint8_t` … `uint32_t` | 1/2/4 | 1/2/4 | number | integer in range |
| `i64` | `int64_t` | 8 | 8 | BigInt | BigInt, or a safe integer number |
| `u64` | `uint64_t` | 8 | 8 | BigInt | BigInt in `[0, 2^64)`, or a safe integer number |
| `isize`, `usize` | `intptr_t`, `uintptr_t` | 8 | 8 | BigInt | as `i64`/`u64` on the 64-bit targets |
| `cLong` | `long` | 8 | 8 | BigInt | alias of `i64`; LLP64 (Windows) needs its own 32-bit token |
| `f32` | `float` | 4 | 4 | number | number; `NaN`/`±Infinity`/`-0` are JSON-special |
| `f64` | `double` | 8 | 8 | number | number |
| `bool` | `bool` | 1 | 1 | boolean | boolean only |
| `cstring` | `char *` | 8 | 8 | string, `Ptr`, or `null` | string or `Ptr` or `null` |
| `Ptr.of(T)` | `T *` | 8 | 8 | `Ptr` or `null` | `Ptr` or `null` |
| `CArray.of(T, n)` | `T[n]` | `n * bytes(T)` | `align(T)` | `Uint8Array` for `u8`, else array | layout-only (struct fields); length must equal `n`; elements coerced |
| struct class | `struct S` | host-computed | host-computed | struct instance | instance, or an initializer object |
| `Callback` | function pointer | 8 | 8 | `Callback` | the callback object |
| `buffer` | `void *` | — | — | TypedArray or DataView | argument-only pseudo-type |
| `buffer_length` | `size_t` | — | — | the same view | argument-only; pairs with `buffer` |

`buffer` and `buffer_length` are not layout types. `buffer_length` is passed the same view as the
paired `buffer`, and the host reads pointer and length from that one object at call time, so a
resizable or transferred buffer cannot produce a torn pair (the same idea as Bun's
`FFIType.buffer_length`). `buffer_length` must immediately follow its `buffer` in a declaration; a
lone `buffer_length`, or one that follows anything else, throws at `dlopen`. It is never inferred.

`Callback` used as an argument type accepts any `Callback` instance and takes the signature from the
instance; `Callback.of(args, ret)` describes a raw function pointer obtained from C. A bare `Ptr`
in a declaration means `void*` and answers `bytes: 8`.

`Ptr.of(T).from(addressOrPtr)` re-types an address as `T*`. It is how a tag-based API is handled:
read `sa_family` through a `sockaddr` view, then cast the same address to `sockaddr_in` or
`sockaddr_in6`. It performs no validation — it is the same reinterpretation as a C cast, and the
caller owns the tag check.

`Ptr.address` is a BigInt, so a 64-bit pointer survives exactly, including arm64e's top-byte/PAC
tagged values. `Ptr.hex` is the string form and `.add(n)` returns a new `Ptr`; `Number(p.address)`
is a deliberate, lossy convenience for debugging only. Host operations accept a `Ptr`, a BigInt or a
Number address, but only the first two are exact.

## 4. Signature resolution and the inference rules

### 4.1 Resolution order

Arguments are resolved position by position, in this order. First match wins.

1. **The symbol has a declared signature.** The declared type is authoritative. The JS value is
   coerced by that type or throws `ERR_INVALID_ARG_TYPE`; inference is not consulted. Typed values
   must be compatible with the declared type (a `Ptr` where an `i64` is declared is rejected).
2. **The call supplies an explicit argument type.** `call`/`fn` accept typed values, which carry
   their own type; nothing is guessed.
3. **The value is unambiguous.** Infer from the table in §4.2.
4. **Otherwise throw.** `ERR_FFI_AMBIGUOUS_ARGUMENT` names the position and the reason.

The return type is never inferred. It comes from the declaration's `ret` when there is one, and from
the `ret` argument of `call`/`fn` when one is passed; `i32` is the default only for a symbol with no
declaration, and `voidType` says there is no return. An omitted `ret` therefore never conflicts:
`lib.call("free", [p])` on a declared-void symbol uses the declaration.

For a symbol that **is** declared, the declared `ret` is authoritative in ABI terms: the host has
already called it that way. A call-site `ret` is allowed only as a *refinement* — an interpretation
that is ABI-identical — and anything else throws `ERR_FFI_SIGNATURE_CONFLICT`.

| declared | call-site may say | why |
|---|---|---|
| any pointer (`Ptr`, `cstring`, `Ptr.of(T)`, `Callback.of(…)`) | any other pointer type | one 8-byte ABI class; only the JS reading changes |
| `i8`/`u8`/`bool` | any of them | one-byte integer, signedness is interpretation |
| `i16`/`u16` | either | |
| `i32`/`u32` | either | |
| `i64`/`u64`/`isize`/`usize`/`cLong` | any 8-byte integer | |
| `f32` | `f32` only | separate register class |
| `f64` | `f64` only | |
| struct class | itself only | by-value layout is not interchangeable |
| `voidType` | `voidType` only | no value was produced |

There is no dynamic return *ABI* to support: C fixes the return type at the call. What people mean
by "the type depends on the input" is a `void*` whose pointee the caller knows — `dlsym`, `malloc`,
`bsearch`, `tsearch`, a generic container. That is exactly a pointer refinement, and it is why the
rule is written in ABI terms rather than type identity:

```js
const dlsym = lib.call("dlsym", [handle, "sqlite3_libversion"], Callback.of([], cstring));
dlsym();   // the declaration said void*; the call site knows better
```

What is not possible is a symbol that returns an `int` for one argument and a struct for another:
the callee's return ABI cannot change at runtime, so such a wrapper must be a JS function that
dispatches to two symbols.

A declaration that omits `ret` still declares one — `i32` — so it can conflict too. For an
undeclared symbol the call-site `ret` is the only signature there is, so it is simply used.

Arguments are different: a declared argument type coerces the value (a boxed `i64` in an `i32`
slot is range-checked, not rejected) because the declared ABI is what will be used. A return value
cannot change ABI after the call has happened; it can only be reinterpreted within the ABI the call
used, which is exactly the refinement above and nothing more.

### 4.2 Inference table

| JS value at argument position | Inferred as | Rule |
|---|---|---|
| `Ptr` instance | `ptr(T)` from the instance | its pointee is informational |
| `Callback` instance | its function-pointer type | the callback carries its own signature |
| typed value (`f64(2)`, `i64(1n)`, `u32(7)`, …) | that type | the boxer exists for exactly this case |
| TypedArray / DataView | `buffer` | pointer only; no length unless a declaration says `buffer_length` |
| string | `cstring` | transcoded to NUL-terminated UTF-8 for the call's duration |
| boolean | `bool` | |
| BigInt | `i64` | use `u64(…)` when unsigned |
| number, int-tagged | `i32` | literals and `Math.trunc`/`floor`/`ceil`/`round` results are int-tagged |
| number, float-tagged or out of int32 range | **throw** | a float-tagged number is refused; division's tag depends on the values (§4.3), so convert explicitly |
| `null` | null pointer | |
| `undefined` | **throw** `ERR_FFI_MISSING_ARGUMENT` | a missing argument is almost always a bug |
| `Struct` instance | **throw** | by-value and by-pointer are ambiguous; declare the parameter `Ptr.of(T)` or use `ref(T)` for an out-param |
| function | **throw** | wrap it in `new Callback(fn, { args, ret })` |
| anything else | **throw** | |

### 4.3 Why floats are never inferred

QuickJS normalizes any integral double that fits int32 back into an `JS_TAG_INT` value when the
value is built through `js_number()`
([quickjs.c](../vendor/rquickjs-sys/quickjs/quickjs.c#L1640)): literals,
`Math.floor`/`ceil`/`round`/`trunc`/`abs`, and `Number("1")` all take that path. So does division:
`OP_div` calls `js_number` on every path
([quickjs.c](../vendor/rquickjs-sys/quickjs/quickjs.c#L20365)), so `w / 2` is int-tagged when the
quotient is exact and float-tagged when it is not. Addition, subtraction and multiplication of
mixed int/float operands go through `js_float64` instead and keep the float tag even when the result
is integral (`w * 0.5` is float-tagged for every `w`). The tag is therefore a *provenance* signal,
not an intent signal: it distinguishes `w * 0.5` from `Math.trunc(w * 0.5)`, but cannot distinguish
`1` from `1.0`, because the parser normalizes both. A `double` parameter therefore needs a
declaration or `f64(…)`; an `i64`/`u64` parameter outside int32 needs `i64(…)`/`u64(…)` or a
declaration; and a computed integer needs an explicit conversion (§4.7) when it may have come from
float arithmetic. This is a hard rule, not a heuristic that can be tuned later.

### 4.4 Width is declared, not widened

An inferred `i32` declares a 32-bit parameter. libffi extends it correctly — it sign-extends
`sint32` and zero-extends `uint32` into the register — so a negative value passed to a `long`
parameter arrives intact; the old worry about sign extension does not apply. The limit is range:
inference refuses a number outside int32, so a 64-bit parameter whose values can exceed 2^31 must be
declared `i64`/`u64`/`isize`/`usize`/`cLong`, or boxed. Sizes, offsets, file positions and
addresses must never be inferred as `i32`.

### 4.5 Shape cache

An inferred plan is keyed by symbol, argument shape (`"cstring,ptr,i32"`) and return type, not by
value. The cache lives in the host (`ln-ffi`): JavaScript computes the shape string, and the host
enforces the limit. Each symbol keeps up to four plans; a fifth throws `ERR_FFI_SHAPE_LIMIT` and
tells the caller to declare the signature. This makes "guess once" the normal path and turns a
program that calls one symbol with inconsistent argument kinds into an immediate error instead of a
silent wrong call.

### 4.6 Variadics

A declared variadic symbol uses `{ args: [...fixed], varargs: true }`; `args` covers only the fixed
parameters, and there must be at least one of them (C requires a named parameter before `...`, and
libffi requires `nfixedargs > 0`). An undeclared variadic call needs `{ varargs: n }`, the number of
fixed arguments (`true` means one), because neither the variadic-ness nor the fixed count can be
discovered. The host calls `ffi_prep_cif_var` with that count and applies C's default argument
promotions to the tail: `f32` becomes `f64`, and integer types narrower than 32 bits become `i32`.
Everything else is inferred per §4.2.

### 4.7 Computing an integer

The runtime never rounds and never truncates: a computed integer must be converted before it is
passed. `Math.trunc(x)` is the default when you mean "the integer part", because it matches C's
conversion toward zero; `Math.floor`/`Math.ceil`/`Math.round` when the domain means that (they
differ from truncation for negative values); `i32(x)`/`i64(x)` when the value may leave int32 or
when the type should be visible at the call site.

This is not only style. `w * 0.5` is float-tagged even when the product is integral (§4.3), and
inference refuses a float-tagged number. Division is the awkward case: `OP_div` normalizes through
`js_number`, so `w / 2` is accepted as `i32` when the quotient is exact and throws when it is not —
the same expression behaves differently depending on the values. `Math.trunc(w / 2)` makes the type
stable; `x | 0` also produces an int but wraps silently outside int32, so prefer the `Math`
functions or a box. A box is a type assertion, not a conversion: `i32(2.5)` throws, because the
value is not an integer.

```js
// both parameters are `int`
lib.call("set_extent", [w * 0.5, h * 0.5]);                            // throws: float-tagged
lib.call("set_extent", [w / 2, h / 2]);                                // i32 when even, throws when odd
lib.call("set_extent", [Math.trunc(w / 2), Math.trunc(h / 2)]);        // inferred: i32, always
lib.call("set_extent", [i32(Math.trunc(w / 2)), i32(Math.trunc(h / 2))]); // explicit type
```

## 5. `Struct` — object model and reference

### 5.1 Object model

| Where | Holds |
|---|---|
| class object | `fields` (static data), `ffiName`, generated `view`; every layout static is a getter over a per-class record |
| prototype | the protocol methods, plus one generated accessor per non-reserved field |
| instance | exactly one own property: the `VALUES` symbol, a null-prototype object of coerced values by field name |
| class record | `{ id, bytes, align, offsets, names, types, index }`, built once by `host.ffi.structType` and cached in a `WeakMap` |

Instances own no native memory. A native buffer exists only at a call boundary, inside `ref(T)`,
or behind a view.

### 5.2 Definition and validation

```js
class Timespec extends Struct {
  static fields = [["tv_sec", cLong], ["tv_nsec", cLong]];
  toMillis() { return Number(this.tv_sec) * 1e3 + Number(this.tv_nsec) / 1e6; }
}

const SockaddrUn = Struct.define([
  ["sun_family", u16],
  ["sun_path", u8, 108],            // third element: inline array count
], { name: "SockaddrUn", ffiName: "sockaddr_un" });
```

Validation happens at definition time (`define` eagerly, a subclass on first layout read):

* `fields` is a non-empty array of `[name, type]` or `[name, type, count]`.
* `name` matches `[A-Za-z_][A-Za-z0-9_]*`; duplicates are rejected.
* `type` is a type object, a known string alias (`"i64"`, `"cLong"`, …), or a struct class.
* `count` is a positive integer and implies `CArray.of(type, count)`.
* Protocol names are allowed as fields; they simply get no accessor (§5.5).

By-value self-reference is rejected with `ERR_FFI_RECURSIVE_STRUCT`; a self-reference through
`Ptr.of(Same)` is legal and common (`struct node { struct node *next; }`).

### 5.3 Statics

| Member | Kind | Meaning |
|---|---|---|
| `fields` | data | the declared field table, as written |
| `ffiName` | getter/data | host registry key and diagnostics name; defaults to `Class.name`; `define` sets it |
| `bytes` | getter | C `sizeof`, including tail padding |
| `align` | getter | C `_Alignof` |
| `offsets` | getter | frozen byte offsets, same index as `fields`; for debugging and manual access |
| `fieldCount` | getter | number of fields |
| `offsetOf(name)` | method | byte offset of one field; throws `ERR_INVALID_ARG_VALUE` if unknown |
| `fieldOf(name)` | method | `{ name, type, offset, bytes, align }` |
| `define(fields, options?)` | method | creates and registers an anonymous subclass |
| `fromJSON(json)` | method | schema-driven revive of a plain object |
| `codecs` | data | the per-isolate codec `Map` |
| `codec(name, codec)` | method | registers `{ encode, decode }` |
| `view(address)` | method | a generated in-place view (§5.8) |

There is deliberately **no `Class.size`**. `Class.bytes` is `sizeof`, `instance.size` is the Map
protocol's field count, and `Class.fieldCount` is the same count as a static.

### 5.4 Instance members

| Member | Kind | Meaning |
|---|---|---|
| `bytes` | getter | the type's `sizeof`; same as `constructor.bytes` |
| `size` | getter | field count (Map protocol) |
| `has(name)` | method | whether the field exists |
| `get(name)` | method | coerced value; works for protocol-named fields |
| `set(name, value)` | method | coerces and assigns; returns `this` |
| `keys()` | generator | field names, declaration order |
| `values()` | generator | values, declaration order |
| `entries()` | generator | `[name, value]` pairs, declaration order |
| `forEach(fn, thisArg?)` | method | Map-style iteration |
| `[Symbol.iterator]` | method | `entries()` |
| `toJSON()` | method | plain object; non-JSON scalars become envelopes (§6) |
| `toPlain()` | method | human/API form: BigInt as number when safe else decimal string, `Ptr` as `0x…` |
| field accessors | generated | `s.tv_sec`; absent for protocol names |

### 5.5 Accessors and reserved names

One accessor is generated per field at layout time, enumerable and configurable. Protocol names —
`get`, `set`, `has`, `size`, `bytes`, `keys`, `values`, `entries`, `forEach`, `toJSON`, `toPlain`,
`then`, `address`, `toString`, `constructor`, `__proto__` — are not generated, so a C field named
`size` is reachable through `get("size")`/`set("size", v)` and appears in `toJSON`, while `s.size`
remains the field count. `then` is reserved because a callable accessor for that field would make
instances thenable and `await` would try to assimilate them; `address` and `toString` are reserved
because views and diagnostics use them. This is a soft reservation: it never fails a definition.

### 5.6 Field coercion

`set`, the constructor's initializer object, `fromJSON`, and argument passing all run the same
coercion: integers range-check and accept in-range BigInt; `i64`/`u64` accept safe integers;
`cstring` accepts a string, `Ptr` or `null`; `Ptr` accepts a `Ptr` or `null`; structs accept an
instance or an initializer object; `CArray` checks length and coerces elements. A wrong value
throws `ERR_INVALID_ARG_TYPE` naming the field or position. Silent truncation never happens.

### 5.7 Layout algorithm

The host computes layout; the JavaScript side never does arithmetic on alignment.

1. Resolve each field type; recurse into by-value struct fields first.
2. Build the `ffi_type` tree bottom-up: scalars map to `ffi_type_*`, pointers to
   `ffi_type_pointer`, a struct to an `FFI_TYPE_STRUCT` whose `elements` list the field types, and
   an inline array to a struct type whose members repeat the element type `count` times (libffi's
   documented emulation; it has no array kind).
3. Ask libffi for the layout instead of recomputing it: after every nested struct type is complete,
   `ffi_get_struct_offsets(FFI_DEFAULT_ABI, type, offsets)` fills the member offsets and the type's
   `size`/`alignment`. The array is a nested `FFI_TYPE_STRUCT`, so the outer `offsets` array has one
   entry per field and stays index-aligned with `fields`. The host does not implement C's alignment
   rules — that would be a second ABI implementation, and the one thing guaranteed to drift from
   the call ABI is a hand-written `align_up`.
4. Return `{ id, bytes, align, offsets }`; the record is cached for the class's lifetime.

`bytes` and `offsets` are therefore libffi's answer for the target ABI, not a reimplementation. A
`packed` option cannot be expressed through `ffi_type` (libffi always applies the ABI's alignment);
supporting it would mean computing offsets ourselves and setting `size`/`alignment` explicitly,
which is why it is deferred rather than promised.

A struct containing an inline array can be sized and passed by pointer normally. Passing it **by
value** is rejected in v1 (`ERR_FFI_UNSUPPORTED_LAYOUT`): libffi's manual says some ABIs classify an
array member differently from an equivalent struct member, and the by-value case is not guaranteed
on every target, so the honest v1 answer is a pointer. For the same reason `CArray.of(T, n)` is a
layout-only type — a struct field, never a top-level parameter or return, since C has no
array-by-value passing and libffi's array emulation is documented for struct members.

libffi is not fully thread-safe: `ffi_prep_cif` writes `size`/`alignment` into the `ffi_type`
objects it is given. The host serializes plan preparation with a mutex and gives each isolate its own
`ffi_type` set, while a prepared plan is immutable and may be used from any thread.

### 5.8 Views

```js
const ts = Timespec.view(ptrOrAddress); // borrowed, no decode, no allocation
ts.tv_sec;                              // one host read at a known offset
ts.tv_nsec = 5n;                        // one host write, in place
```

A view class is generated per struct: `address`, `bytes`, the protocol methods, and accessors that
call `host.ffi.read`/`host.ffi.write` at the cached offset. Scalar, pointer and `cstring` fields
return values; by-value struct fields return sub-views; `CArray` fields return an indexed view.
Views are borrowed: nothing is owned and there is no `close`. They exist for the out-param pattern
(`stat`, `getaddrinfo`, `ioctl`) and for walking an array of structs by `base.add(i * T.bytes)`,
where decoding and re-encoding the whole struct per access would be the cost.

## 6. JSON

### 6.1 Envelope

Values JSON cannot represent use one reserved key:

```json
{ "tv_sec": { "$onde": { "t": "bigint", "v": "1720000000" } } }
```

One reserved key, nested; no sibling magic keys, because `value` is a common C field name.

| codec | emitted for | revives to |
|---|---|---|
| `bigint` | every `i64`/`u64`/`cLong` value, regardless of magnitude | `BigInt(v)` |
| `f64` | `NaN`, `Infinity`, `-Infinity`, `-0` only | the number |
| `u8array` | `CArray.of(u8, n)` | `Uint8Array` |
| `ptr` | any `Ptr` | throws: pointers are encode-only |

Tagging is by type, not by whether a value happens to need it, so `revive` is deterministic: a bare
JSON number is never a BigInt and a bare string is never a pointer. `f64` is the one value-level
exception, because enveloping every double would make ordinary numeric JSON unreadable.

### 6.2 `toJSON`, `toPlain`, `fromJSON`, `revive`

* `toJSON()` returns a plain object in field order with envelopes where needed. `JSON.stringify(ts)`
  uses it, so it works without throwing on BigInt.
* `toPlain()` returns the friendly form: BigInt as a number when it is a safe integer, else a
  decimal string; `Ptr` as `0x…`; byte arrays as base64.
* `Class.fromJSON(json)` is schema-driven: it walks the field table, accepts an envelope or a bare
  value per field, and returns an instance. This is how a `Timespec` comes back.
* `revive(json)` is schemaless: it walks an arbitrary JSON graph, decodes envelopes through the
  registry, and leaves everything else alone. It never resolves names against globals and never
  invokes an unregistered codec. A standalone struct in a graph is *not* revivable, because
  `toJSON` emits no class tag; this is deliberate, to keep `toJSON` clean for APIs and logs.

`Struct.codec(name, { encode, decode })` registers additional codecs. Names are flat (`bigint`,
`ptr`, `decimal`) and the registry is per isolate, so workers each have their own. Field names are C
identifiers, so `$onde` cannot be one and the envelope cannot collide with a struct by construction.
`revive` still reads any object carrying the key as an envelope, which is why it is meant for
values produced by `toJSON` rather than arbitrary user JSON.

## 7. Calls, returns, out-params

* `ret` is a type object, a struct class, or `voidType`. An omitted `ret` takes the declaration's
  when the symbol is declared, and `i32` otherwise; it is never inferred. Most C APIs return an
  `int` status, so the fallback covers the common case. The sharp edge is a pointer or 64-bit return
  read as `i32`: the value is truncated, and passing that number back as a pointer is a crash. A
  struct or `long double` return with the default is an ABI mismatch, not just a wrong value.
  Declare any return that is not an `int`. An explicit call-site `ret` on a declared symbol may only
  refine it where the ABI is identical (§4.1); any other change throws
  `ERR_FFI_SIGNATURE_CONFLICT`.
* A `Ptr.of(T)` return is a `Ptr`; `.deref()` decodes one `T` and `T.view(ptr)` gives the in-place
  form.
* A struct return by value is decoded into an instance (libffi writes it into host-provided
  memory; the `ffi_type` tree is the same one built for arguments).
* The `rvalue` buffer passed to `ffi_call` is at least `sizeof(ffi_arg)` — one register — and
  register-aligned, even when the declared return is `i8`/`i32`/`bool`: libffi widens narrow
  integral returns to `ffi_arg`. A tight 4-byte buffer is an overrun, and with `panic = "abort"` it
  is a process abort rather than a wrong value.
* `ref(T)` allocates `T.bytes`, zero-filled, and returns `{ address, value, free(), [Symbol.dispose] }`,
  where `address` is a BigInt. `value` decodes on read and encodes on write. It is how
  `sqlite3_open`-style `T**` out-params are read back; a finalizer frees it if `free()` is not
  called. Bare `Ptr` is the `void*` type, so
  `ref(Ptr)` is an 8-byte `void*` slot — the `sqlite3**` case — and a `ref` handle is accepted
  wherever a declared argument is a pointer type, with the marshaler passing its address.
* `close()` invalidates every symbol from the handle, so a later call throws `ERR_FFI_CLOSED`
  rather than jumping into an unloaded image. It refuses only while a deallocator-backed external
  buffer is live: the deallocator's code may live in the library, and GC will call it after
  `dlclose`. A symbol that merely exists, a `Callback` and a `ref` never block closing — the closure
  and the ref storage are host-owned, and `Callback.close()` is the user's separate responsibility;
  a ref's captured pointer simply becomes invalid.
* `errno()` returns and clears the last error number. The host reads it immediately after
  `ffi_call`, before any other host work, so it reflects the callee rather than the runtime. When
  Windows lands this becomes `GetLastError` with the same shape.

### 7.1 Error codes

| Code | Raised by | When |
|---|---|---|
| `ERR_FFI_NOT_ALLOWED` | host | `Config::ffi` is `Deny`; a build without the feature has no module at all |
| `ERR_FFI_DLOPEN` | host | `dlopen` failed; the message carries the loader's text |
| `ERR_FFI_SYMBOL_NOT_FOUND` | host | the symbol is absent from the library |
| `ERR_FFI_CLOSED` | host | a call through a handle or callback that was closed |
| `ERR_FFI_LIVE_REFERENCES` | host | `close()` while a deallocator-backed external buffer is live |
| `ERR_FFI_AMBIGUOUS_ARGUMENT` | JS | inference refused a value (§4.2) |
| `ERR_FFI_MISSING_ARGUMENT` | JS | an argument was `undefined` |
| `ERR_FFI_SIGNATURE_CONFLICT` | JS | an explicit `ret` is not ABI-compatible with the declaration |
| `ERR_FFI_SHAPE_LIMIT` | host | a symbol exceeded four inferred plans |
| `ERR_FFI_RECURSIVE_STRUCT` | host | a by-value struct contains itself |
| `ERR_FFI_UNSUPPORTED_LAYOUT` | host | a `CArray` used as a parameter or return, or a by-value struct containing one |
| `ERR_FFI_UNKNOWN_CODEC` | JS | `revive` met a `$onde.t` with no registered codec |
| `ERR_FFI_NOT_REVIVABLE` | JS | a pointer envelope reached a decoder |
| `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE` | JS | coercion failure, unknown field, bad definition |

## 8. Memory and lifetime

* `ptr(view)` returns a `Ptr` for a TypedArray/DataView; the view must stay alive for the call (and
  beyond, if C retains it — the caller's responsibility).
* `read.u8/i8/…/u64/i64/f32/f64/ptr(addressOrPtr, offset)` are one-shot field reads. There is no
  `write` namespace on `read`: in-place writes go through `Struct.view` accessors or
  `host.ffi.write`, because a bare write needs a type and an address and reads badly as a method.
* `toArrayBuffer(address, offset, length, deallocator?)` returns a zero-copy `ArrayBuffer` over
  external memory. With a deallocator — a `Ptr` to `void dealloc(void *ptr, void *context)` plus an
  optional context — the buffer owns the memory; the host adapts it to the engine's realloc-shaped
  hook and calls it once when the buffer is released, on the isolate thread (during a collection or
  at `JS_FreeRuntime`), never on another thread. It must not call into JavaScript. Detaching the
  buffer — for example by transferring it — calls the deallocator immediately, which is the
  deterministic release path; the borrowed form (no deallocator) leaves the caller to free the
  memory. Without a deallocator the buffer is borrowed and the caller keeps the memory alive.
* The engine's external-buffer hook is realloc-shaped (`JSReallocArrayBufferDataFunc`): freeing is
  "return `NULL` for size 0". The host implements that contract once; `JS_NewArrayBufferCopy` is the
  safe default when no ownership transfer is intended.
* `CString(ptr, offset?, length?)` returns a plain string cloned out of native memory; it is safe
  after the pointer is freed. Length omitted means NUL-terminated.
* FFI calls are synchronous and run on the isolate thread. A long C call blocks timers, I/O
  completions and `process.exit`; the checkpoint interrupt only runs at JS checkpoints, so no
  timeout can preempt C. This is documented, not worked around, in v1.

## 9. Callbacks and threads

```js
// qsort: { args: [Ptr, usize, usize, Callback], ret: voidType }
const cmp = new Callback((a, b) => read.i32(a, 0) - read.i32(b, 0), {
  args: [Ptr.of(i32), Ptr.of(i32)],
  ret: i32,
});
lib.qsort(base, count, size, cmp);
cmp.close();
```

* `Callback(fn, { args, ret, threadsafe? })` exposes `.ptr`, `.close()` and `[Symbol.dispose]`.
  Passing the `Callback` itself where a `function` argument is expected works; the marshaller uses
  its address.
* The closure is allocated with `ffi_closure_alloc` and bound with `ffi_prep_closure_loc`. That
  produces a writable mapping plus an executable alias — libffi may fall back to a file-backed
  mapping when anonymous executable memory is unavailable — so macOS hardened runtime needs the
  JIT/unsigned-executable-memory entitlement; without it the allocation fails and the constructor
  throws. GC never frees a closure: only `close()` does, so a dropped JS reference leaks the
  trampoline rather than letting C call freed memory, and freeing one while C may still call it is
  undefined, because neither libffi nor the runtime can know. A closure invoked on a foreign thread
  must not enter JavaScript; that is what `threadsafe: true` exists for.
* Invocation on the isolate thread runs inline. QuickJS re-enters safely there, and a callback may
  call back into FFI.
* If the JS callback throws, the exception is caught at the trampoline (`ctx.catch()`), the
  C-visible return is the zero value of `ret`, and the exception is rethrown after the outer FFI
  call returns. Leaving it pending would make every later `JS_Call` fail in the same C function.
* `threadsafe: true` defers the invocation to the isolate thread and requires `ret: voidType`: from
  C's point of view the call is asynchronous and there is no return value. Arguments are copied
  before deferral; the callback runs at an isolate turn, not inside the C call.
* The trampoline must not panic. The release profile is `panic = "abort"`
  ([Cargo.toml](../Cargo.toml#L28)), so `catch_unwind` is a no-op: no `unwrap`, no `try_borrow`
  failure path, no allocation that can abort. A debug/test profile with unwinding plus an ASAN job
  covers what release cannot.

## 10. Host boundary and file map

| Layer | Owns | Must not |
|---|---|---|
| `crates/ln-ffi` | `libloading` + `libffi`; handle and symbol registries; call plans; `ffi_type` trees; layout; callback trampolines; external buffers | know the engine, hold a `JSValue`, decide Node or JSON policy |
| `ln-runtime/src/host/ffi.rs` | JS value ↔ `ln_ffi::Value` conversion, exception parking, per-isolate codec and struct registries, the `host.ffi` object | implement layout or calling conventions |
| `js/lib/ffi.js` | public API, type objects, `Struct`, inference order, JSON codecs | call `libffi` directly |
| `ln-runtime/src/lib.rs` | `Config::ffi` and feature wiring | make per-call decisions |
| `ln-cli/src/main.rs` | `--allow-ffi` | contain FFI semantics |
| `ln-embed` | policy default (`Deny`) and the C ABI entry point's stance | assume FFI is enabled |

`host.ffi` is one more submodule of `__ln_host`; the invariant in
[host/mod.rs](../crates/ln-runtime/src/host/mod.rs#L1) — "if a capability is not here, JavaScript
cannot perform it" — gains exactly one reviewed capability, and the review surface is the single
file that installs it.

The host surface is deliberately small: `dlopen`, `dlsym`, `structType`, `call`, `read`, `write`,
`errno`, `alloc`, `free`, `toArrayBuffer`, `callback`, `close`. Everything else is JavaScript over
those.

Build feature: `ffi`, off by default everywhere through 1.0 and enabled in the M10 `lite` build; off
in `ln-embed` and compiled apps unless the embedder enables it. The dependency floor is libffi ≥ 3.3,
for `ffi_get_struct_offsets`; the Rust `libffi-sys` crate vendors a newer one. `Config::ffi` defaults
to `Deny`; `--allow-ffi` flips it for the CLI. A binary built without the feature has no `onde:ffi` module at all — resolution reports
`ERR_UNKNOWN_BUILTIN_MODULE`, like any other absent builtin — so it cannot be tricked into loading a
library. `ERR_FFI_NOT_ALLOWED` is only for a runtime whose policy is `Deny`.

Adding the module is not only a JS file. `ln-modules` resolves `node:`-prefixed and bare builtins
(`crates/ln-modules/src/builtin.rs`), and `ln-runtime` asserts that every `BUILTINS` entry has an
embedded source arm (`crates/ln-runtime/src/modules.rs`). The work is an `onde:` namespace kept
separate from `BUILTINS` (so bare `ffi` cannot resolve), a source arm, the ESM path, and a drift
test mirroring the existing one. `node:ffi` is not an option: it would claim a Node namespace we do
not implement.

`--allow-ffi` is the first deny-by-default `--allow-*` flag. The permissions model itself is
deferred (roadmap decision log, unnumbered row); when it lands, FFI should become one permission
rather than a standalone switch.

## 11. Testing

* **Fixture library**: `test/ffi/fixture/` is a `cdylib` with exports for every scalar round-trip,
  nine-argument calls, `f32`/`f64`, null pointers, `i64` minimum and `u64` maximum, a callback
  invoked N times, a callback that throws, reentrancy (a callback calling another FFI function),
  errno setting and reading, a pointer return, an allocation returned to JS, a struct by value, a
  struct out-param, and a variadic sum.
* **Layout oracle**: `test/ffi/layout.c` prints `sizeof` and `offsetof` for mixed structs
  (`char`/`short`/`int`/`long long`/`double`/pointer/array/nested). The test compares the host's
  layout with the compiler's on both target platforms. This is the only way to trust `bytes` and
  `offsetOf`; the compiler is needed in CI anyway for `libffi`.
* **Inference matrix**: one case per row of §4.2, including every throw, `ERR_FFI_SHAPE_LIMIT`, the
  shape-cache warning, `w * 0.5` refused where `Math.trunc(w * 0.5)` is accepted, exact `w / 2`
  accepted as `i32` while `w / 3` throws, and an omitted `ret` deferring to the declaration.
* **Signature refinements**: declared `Ptr` called with `Ptr.of(T)` or `Callback.of(…)` succeeds;
  declared `i64` with `u64` succeeds; `i32` with `i64` throws; a different struct class throws; a
  declaration that omitted `ret` still means `i32`, so an explicit incompatible `ret` conflicts;
  the `dlsym` example in §4.1 works.
* **Cast**: `Ptr.of(T).from(ptr)` and `.from(address)` yield the same address with a new pointee;
  the `sockaddr`/`sockaddr_in` tag path works; `Ptr.address` is a BigInt that survives a high-bit
  (arm64e-style) address, while `Number(address)` rounds it.
* **Arrays**: a top-level `CArray` parameter or return throws `ERR_FFI_UNSUPPORTED_LAYOUT`; a
  by-value struct containing an inline array throws; the same struct passed by pointer works.
* **JSON**: round-trip `toJSON`/`fromJSON` for every type, `toPlain` for humans, `revive` for
  envelopes, pointer-revive throws, unknown codec throws.
* **Lifetime**: `close()` invalidates symbols (a later call throws `ERR_FFI_CLOSED`) and refuses
  while a deallocator-backed external buffer is live; callbacks and refs do not block; detaching
  such a buffer releases it immediately. GC stress over external buffers and callbacks; the realloc
  contract (free exactly once).
* **ASAN**: a debug-profile job runs the fixture matrix with `-Zsanitizer=address`; release
  coverage cannot catch a use-after-free.
* **Mutation**: break the marshalling deliberately (wrong width, wrong signedness, off-by-one
  offset) and confirm the matrix fails, the way the buffer codecs were validated.

## 12. Work packages

| WP | Work | Exit criterion |
|---|---|---|
| WP0 | `ln-ffi` skeleton, `libloading` + `libffi` build, feature gate, fixture `cdylib`, `onde:` module registration (CJS + ESM + drift test), `dlopen`/`dlsym`/`call` for declared scalars, `cstring` and `usize` returns, `close` | `getpid`, `strlen` and a fixture `f64` symbol pass; a feature-off build has no module; the drift test sees `onde:ffi` |
| WP1 | inference, shape cache, boxed scalars, variadics, error codes | §4.2 matrix green; `ERR_FFI_SHAPE_LIMIT` test |
| WP2 | `Ptr`, `read`, `toArrayBuffer`, `buffer_length`, `ref`, `CString`, alloc/free | sqlite3-shaped `T**` out-param reads back; external buffer freed once |
| WP3 | `Struct`: layout, registration, accessors, statics, `define`, `fromJSON`/`toJSON`/`toPlain`, views | layout oracle equal on macOS and Linux; `struct stat` and an array of structs via `bytes` |
| WP4 | `Callback`: closure allocation and entitlement failure, same-thread invocation, exception parking, `threadsafe`, `close`; by-value struct arguments and returns | `qsort` comparator; thrown callback surfaces after the call; threadsafe requires `voidType` |
| WP5 | gates, docs, ASAN, performance, `compat.md` D67, architecture crate row, roadmap M10 entry | ADR accepted; `--allow-ffi` denial test; ASAN clean; size delta recorded |

## 13. Deliberate limits

* No N-API and no `process.dlopen`:
  [roadmap.md](roadmap.md#0-definition-of-v10) excludes addons from 1.0 and ADR-0010 keeps them out
  of 1.1.
* No Windows in v1. `cLong` is an `i64` alias because every supported target is LP64; LLP64 needs
  its own token, and `LoadLibrary` needs a `libloading` path that has not been exercised.
* No unions, bitfields, flexible array members, `long double`, `__int128`, or packed layouts in
  v1. Each is a known follow-up with a stated place in the type grammar.
* No array-by-value parameters or returns: `CArray` is a struct-field layout type only, and a
  by-value struct containing an inline array is rejected. Pass a pointer.
* No header parsing or bindgen. `Struct.define` is the target format for a generator; the generator
  is a separate project.
* No async or nonblocking calls. Sync only, with the blocking cost documented in §8.
* No cross-thread synchronous callbacks. `threadsafe: true` is deferred and void.
* No C++ ABI: C calling convention and C symbols only.

## 14. Open questions

* `--allow-ffi` default in the `lite` binary. Opt-in (Deno-style) is the least-privilege answer;
  Node-compatible ergonomics argue for on. Current proposal: deny everywhere, one flag.
* Module name: `onde:ffi` (proposal) versus `lite:ffi` given the binary's old name.
* Whether `linkSymbols`-style raw-pointer-to-callable is needed for interop, or `CFunction` covers
  it.

## 15. Acceptance

FFI is done when all of the following hold in CI on macOS arm64 and Linux x86_64:

1. The fixture matrix passes, including every inference throw and every lifetime test.
2. The layout oracle reports identical `sizeof`/`offsetof` values.
3. The sqlite3 example in §2.1 opens and closes, with the system library or a skipped test when it
   is absent.
4. `close()` invalidates symbols and refuses while a deallocator-backed buffer is still live.
5. The ASAN job is clean.
6. A feature-off build has no `onde:ffi` module (resolution error), and a `Deny` runtime throws
   `ERR_FFI_NOT_ALLOWED`.
7. `compat.md` records the module as an extension (D67, added with the implementation; D66 is the
   current last row), `architecture.md` lists `ln-ffi` in the crate graph, and the roadmap names FFI
   as M10.
8. Per-call overhead and binary-size delta are measured and written down here.

## 16. File map

```
crates/ln-ffi/                      handles, symbols, plans, layout, ffi_type trees, trampolines
crates/ln-runtime/src/host/ffi.rs   value conversion, exception parking, registries
crates/ln-modules/src/builtin.rs    `onde:` namespace and resolution
crates/ln-runtime/src/modules.rs    embedded source arm and drift test
crates/ln-error/src/lib.rs          `ERR_FFI_*` construction
js/lib/ffi.js                       public API, types, Struct, inference, JSON
test/ffi/fixture/                   cdylib exercising every type and callback rule
test/ffi/layout.c                   sizeof/offsetof oracle
test/ffi/*.test.js                  the matrix
```
