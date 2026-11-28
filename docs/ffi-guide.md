# FFI guide

`onde:ffi` loads a shared library and calls its C symbols at runtime. The module is part of the
default `onde` build and is gated at runtime by the `ffi.load` permission. The public surface lives
in [js/lib/ffi.js](../js/lib/ffi.js); the API contract, inference rules and recorded deviations are
in [ffi-plan.md](ffi-plan.md), and [ADR-0010](adr/0010-ffi-dlopen.md) explains the design.

## Enabling FFI

The permission model is off unless `--permission` is passed, so a normal `onde script.js` may load
libraries:

```sh
onde app.js
```

With a policy, grant the capability in the same way as the other capabilities:

```sh
onde --permission --allow-ffi app.js
```

`--allow-ffi` requires `--permission`. A policy file grants it with:

```json
{ "ffi": { "load": true } }
```

`--allow-ffi` is full trust, not a capability switch. A loaded library runs with the process's
authority: it can open files, spawn processes and use the network regardless of the other grants,
because native code is not mediated by the permission layer. Do not grant it to a script you do
not trust.

A denied load throws `ERR_ACCESS_DENIED` with `capability: "ffi.load"`. A binary built without the
`ffi` feature has no `onde:ffi` module at all, and `require("onde:ffi")` reports
`ERR_UNKNOWN_BUILTIN_MODULE`. The module is only reachable as `onde:ffi`; bare `ffi` and `node:ffi`
do not resolve, and `module.builtinModules` does not list it.

## Loading a library

```js
const { dlopen, libcName, i32, usize, cstring } = require("onde:ffi");

const lib = dlopen(libcName, {
  getpid: { args: [], ret: i32 },
  strlen: { args: [cstring], ret: usize },
});

console.log(lib.symbols.getpid());
console.log(lib.symbols.strlen("hello"));
lib.close();
```

The C library's name differs by platform. `onde:ffi` exports `libcName`, the name for the host that
built the binary: `libc.dylib` on macOS, `libc.so.6` on glibc and `libc.so` on musl. Use it instead
of a literal. The path is passed to the system loader, so a bare name uses the loader's search path
and an absolute path opens that file. The second argument carries the C signatures: `i32` names
`int32_t` and `cstring` names `char *`. The [Data types](#data-types) section covers the rest of the
vocabulary and why the width matters.

The SQLite example uses the macOS library name `libsqlite3.dylib`; on Linux it is
`libsqlite3.so.0`.

`dlopen` returns an object with these members:

| Member | Meaning |
|---|---|
| `path` | the path passed to `dlopen` |
| `symbols` | one function per declared symbol |
| `call(name, args, ret?, options?)` | one call, declared or not |
| `fn(name, ret?, options?)` | a reusable function for one symbol |
| `close()` | unloads the library and invalidates the handle |
| `closed` | whether `close()` has run |

`call`, `fn` and `close` are closures, so destructuring them is safe.

### Declarations

A declaration is `{ args, ret, varargs? }`; Deno's `parameters` and `result` are accepted when the
onde names are absent:

```js
const {
  dlopen, Ptr, cstring, i32, isize, voidType, buffer, buffer_length,
} = require("onde:ffi");

const lib = dlopen("libmylib.dylib", {
  mylib_open:  { args: [cstring, i32], ret: Ptr },
  mylib_read:  { args: [Ptr, buffer, buffer_length], ret: isize },
  mylib_close: { args: [Ptr], ret: voidType },
});
```

`args` lists the parameter types in order. `ret` is the return type and defaults to `i32` when the
declaration omits it. `varargs: true` marks a variadic function; `args` then lists only the fixed
parameters.

Declarations are optional and may cover only part of a library. A symbol that is not declared can
still be called with `call` or wrapped with `fn`.

The host checks declarations when `dlopen` runs. A malformed `buffer_length` position or an unknown
type fails there, before any call. By default a declared symbol that the library does not export is
found on the first call and throws `ERR_FFI_SYMBOL_NOT_FOUND` then. Pass `{ strict: true }` as the
third argument to `dlopen` to make declarations authoritative: every declared symbol resolves at
load time and `call`/`fn` refuse a symbol that has no declaration, so every pointer parameter has a
declared type to check against:

```js
const lib = dlopen("libmylib.dylib", declarations, { strict: true });
```

`lib.address(name)` resolves a symbol without calling it and returns a `Ptr`, which is what a
deallocator argument needs:

```js
const released = toArrayBuffer(block, 0, size, lib.address("mylib_free"));
```

### Calling and reusing

```js
// One call.
const pid = lib.call("getpid", [], i32);

// A reusable function. The plan for this shape is cached.
const strlen = lib.fn("strlen", usize);
strlen("one");
strlen("two");
```

For a declared symbol, `call` and `fn` use the declared argument types. An explicit `ret` may only
refine the declared return where the ABI is identical: any pointer type may stand in for another
pointer type, and an integer may stay in the same width. A different width, a different class, or a
different struct class throws `ERR_FFI_SIGNATURE_CONFLICT`.

```js
// `mylib_open` is declared to return Ptr. Reading that as a cstring is a pointer refinement,
// so it is allowed even though the JavaScript value changes shape.
const init = lib.call("mylib_open", ["cache", 0], cstring);

// If `mylib_count` were declared to return i64, this throws.
lib.call("mylib_count", [], i32);
```

A symbol with no declaration takes the per-call return type, and `i32` when the caller omits it:

```js
const { dlopen, libcName, usize } = require("onde:ffi");

const libc = dlopen(libcName);
libc.call("getpid");                   // i32 by default
libc.call("strlen", ["hello"], usize); // 64-bit return, stated
```

Declare any return that is not an `int`. Reading a pointer or a 64-bit value through the `i32`
default truncates it, and a struct return under an `int` signature is an ABI mismatch.

## Data types

C has no dynamic types. Every parameter and return has a width, a signedness and an ABI class
(integer, floating point, pointer or struct), and the calling convention places values according
to those facts. A wrong width does not produce a wrong number; it corrupts the call.

Those facts are target-specific. Struct classification, register assignment, alignment and
variadic handling differ between macOS arm64 and Linux x86_64, and `long` or `size_t` change width
on LLP64. A declaration or a typed value describes the C side once; libffi builds the frame for
the target in front of it. That is what lets the same script call the same function on both
supported platforms. The host reports the pointer and `long` widths, so `isize`, `usize`, `cLong`
and `buffer_length` follow the target rather than a constant.

The exported tokens describe those C types. `i32` means `int32_t`, `f64` means `double`, `cstring`
means `char *`, `Ptr.of(T)` means `T *`, and a `Struct` subclass describes a struct layout. Each
token answers `bytes` and `align`, and the host uses it to marshal arguments and decode returns.

A type reaches a call in one of three ways. A declaration is authoritative. A typed value carries
its own type. Inference resolves the type from an unambiguous value, and throws when the value does
not settle the question. The rest of this section covers the tokens and the boxers; inference has
its own subsection below.

| Export | C type | JavaScript value | Notes |
|---|---|---|---|
| `i8`, `i16`, `i32` | `int8_t`, `int16_t`, `int32_t` | number | range checked; a BigInt is accepted if in range |
| `u8`, `u16`, `u32` | `uint8_t`, `uint16_t`, `uint32_t` | number | range checked |
| `i64`, `u64` | `int64_t`, `uint64_t` | BigInt | a safe integer number is also accepted |
| `isize`, `usize` | `intptr_t`, `uintptr_t` | BigInt, number at 32 bits | pointer width; 8 bytes on the supported 64-bit targets |
| `cLong` | `long` | BigInt, number at 32 bits | `sizeof(long)`; 8 on LP64, 4 on LLP64 |
| `f32`, `f64` | `float`, `double` | number | |
| `bool` | `bool` | boolean | |
| `cstring` | `char *` | string, `Ptr` or `null` | copied to NUL-terminated UTF-8 for the call |
| `Ptr` | `void *` | `Ptr` or `null` | bare `Ptr` as a parameter type |
| `Ptr.of(T)` | `T *` | `Ptr` or `null` | `.deref()` decodes one `T` |
| `CArray.of(T, n)` | `T[n]` | array or `Uint8Array` | layout only: struct fields |
| a `Struct` subclass | `struct S` | instance or initializer | by value |
| `Callback` | function pointer | `Callback` | |
| `Callback.of(args, ret)` | function pointer | `Callback` or callable | describes a C function pointer |
| `voidType` | `void` | undefined | return only |
| `buffer` | `void *` | TypedArray, DataView, `Ptr`, `ref` or null | argument only |
| `buffer_length` | `size_t` | the same view, or a number when `buffer` is a `Ptr` | argument only; pointer width, follows `buffer` |

`buffer` and `buffer_length` are not layout types. The common form passes the same view for both
positions and the host reads pointer and length from that object at call time, so a buffer that is
resized or transferred cannot produce a torn pair. A pointer that is already resolved passes the
length explicitly:

```js
lib.symbols.write(2, ptr(view), view.byteLength);
```

`buffer_length` must immediately follow its `buffer` in a declaration. A lone `buffer_length`, or
one after a different type, throws at `dlopen`.

### Type tokens and boxers

A scalar token has two roles. In a declaration, `args: [i32]` uses it as the descriptor. Called as
a function, `i32(value)` is a boxer that returns a value carrying the type:

```js
const { i32 } = require("onde:ffi");

i32(2);        // typed value 2
i32(2 * 0.5);  // typed value 1; the product is integral
i32(2.5);      // throws: not an integer
i32(2 ** 40);  // throws: outside int32

i32.bytes;     // 4
i32.align;     // 4
```

A box is an assertion about a value that already has the right shape, not a conversion. It checks
the mathematical value and the declared range; it does not round, truncate or wrap. That is why
`i32(2.5)` throws and `i32(2 ** 40)` throws.

The boxers exist for the types inference cannot name without guessing: `u64` against `i64`, `f32`
against `f64`, `usize` against `u64`, and a struct field whose JavaScript value does not reveal its
C type. A declaration states the same facts once for a symbol: every call uses the declared types,
including the return type, and a variadic declaration carries the fixed count, which argument values
do not encode.

### Truncation is a separate decision

`i32(h * 0.5)` does not round, so it fails when the product is fractional: `i32(601 * 0.5)`
throws on 300.5. The conversion and the type assertion are two steps, and either step can be
written explicitly:

```js
Math.trunc(601 * 0.5);       // 300, a number
i32(Math.trunc(601 * 0.5));  // 300, typed i32
```

`Math.trunc` converts toward zero, which is what C does when a floating-point value is converted
to an integer type. `Math.floor` differs for negative values (`Math.floor(-2.5)` is -3, while C's
conversion gives -2), and `x | 0` wraps outside int32, so avoid it for sizes and offsets.

The `set_extent` example shows the four forms in context:

```js
const { dlopen, i32 } = require("onde:ffi");

// The library exports `void set_extent(int w, int h)`, and the handle is undeclared.
const lib = dlopen("libui.dylib");
const w = 800;
const h = 600;

lib.call("set_extent", [w * 0.5, h * 0.5]);                                     // throws: float-tagged
lib.call("set_extent", [i32(w * 0.5), i32(h * 0.5)]);                           // both products are integral
lib.call("set_extent", [i32(w * 0.5), i32((h+1) * 0.5)]);                       // throws: 300.5 is not an integer
lib.call("set_extent", [Math.trunc(w * 0.5), Math.trunc(h * 0.5)]);             // inferred i32
lib.call("set_extent", [i32(Math.trunc(w * 0.5)), i32(Math.trunc(h * 0.5))]);   // explicit type
```

For 800x600 the boxed call is valid because both products are whole numbers. With `h = 601`,
`i32(h * 0.5)` throws on 300.5, and only the truncating forms run. The box states the C type; the
`Math` call states the rounding rule. For a size known to be even, `i32(h * 0.5)` is enough.

### Inference

When a symbol has no declaration, each argument type is resolved in this order:

1. A typed value supplies its own type.
2. A `Ptr`, `Callback`, string, boolean or BigInt supplies its natural type.
3. A number supplies `i32` only when QuickJS holds it as an int.
4. Anything else throws `ERR_FFI_AMBIGUOUS_ARGUMENT` with the argument position.

The inference table is:

| Value | Inferred type |
|---|---|
| `Ptr` instance | its pointer type |
| `Callback` instance | its function pointer type |
| typed value | the type on the box |
| TypedArray or DataView | `buffer` |
| string | `cstring` |
| boolean | `bool` |
| BigInt | `i64` |
| int-tagged number inside int32 | `i32` |
| float-tagged number | error |
| `null` | null pointer |
| `undefined` | `ERR_FFI_MISSING_ARGUMENT` |
| struct instance | error |
| function | error |
| anything else | error |

Float-tagged numbers are refused because the tag records how the value was computed. QuickJS
normalizes integral doubles built through `js_number` into ints, so `1` and `1.0` share the int
tag, while `w * 0.5` keeps the float tag even when the product is integral. Division is worse:
`w / 2` is accepted when the quotient is exact and refused when it is not.

A box is the explicit type statement. `i32(w * 0.5)` is accepted when the product is integral
because the caller has named the type, while `w * 0.5` unboxed is refused. The box still refuses a
fractional product, so `i32(601 * 0.5)` throws. When a conversion is intended, use `Math.trunc`
first, as shown above.

`undefined` is a missing argument rather than a null pointer. Pass `null` for a null pointer.

The host keeps at most four plans per symbol, keyed by argument shape and return type. A fifth
distinct plan throws `ERR_FFI_SHAPE_LIMIT` and asks for a declaration. This turns a program that
calls one symbol with inconsistent argument kinds into an error instead of a silent wrong call.

### Pointers

`Ptr.address` is a BigInt, so a 64-bit address survives exactly. `Number(ptr.address)` is lossy and
meant for debugging.

```js
const { Ptr, i32, read, ptr } = require("onde:ffi");

const ints = new Int32Array([7, 9]);
const base = Ptr.of(i32).from(ptr(ints));
base.hex;                 // "0x..."
base.add(4).deref();      // 9, as a number
read.i32(base);           // 7
```

Use `Ptr.of(T).from(addressOrPtr)` to reinterpret an address, as a C cast would. For a tagged
structure such as `sockaddr`, read `sa_family` through one view and then cast the same address to
`sockaddr_in` or `sockaddr_in6`.

## Structs

A struct is a class with a static `fields` table. Fields are `[name, type]` or
`[name, type, count]`, where `count` makes an inline array.

```js
const { Struct, cLong, i32, u16, u8 } = require("onde:ffi");

class Timespec extends Struct {
  static fields = [["tv_sec", cLong], ["tv_nsec", cLong]];

  toMillis() {
    return Number(this.tv_sec) * 1e3 + Number(this.tv_nsec) / 1e6;
  }
}

const SockaddrUn = Struct.define(
  [["sun_family", u16], ["sun_path", u8, 108]],
  { name: "SockaddrUn", ffiName: "sockaddr_un" },
);
```

`Struct.define(fields, options)` creates an anonymous subclass. `options.name` sets the class name
and `options.ffiName` sets the diagnostics name.

Validation runs when the layout is first read. Field names must be C identifiers and unique, a
count must be a positive integer, and a field type must resolve. A by-value reference to the struct
itself throws `ERR_FFI_RECURSIVE_STRUCT`; a reference through a pointer is legal.

### Instances

An instance is a JavaScript object of coerced values. It owns no native memory.

```js
const stamp = new Timespec({ tv_sec: 1720000000n, tv_nsec: 5n });
stamp.tv_sec;             // 1720000000n
stamp.set("tv_nsec", 10n);
stamp.has("tv_sec");      // true
[...stamp.entries()];     // [["tv_sec", 1720000000n], ["tv_nsec", 10n]]
stamp.size;               // 2, the field count
stamp.bytes;              // 16
```

Values are coerced on assignment and in the constructor. An integer outside its type's range
throws; a `cstring` field accepts a string, a `Ptr` or `null`; a struct field accepts an instance or
an initializer object.

The class statics are:

| Member | Meaning |
|---|---|
| `fields` | the declared field table |
| `ffiName` | diagnostics name, defaulting to the class name |
| `bytes` | C `sizeof` |
| `align` | C `_Alignof` |
| `offsets` | frozen byte offsets, same order as `fields` |
| `fieldCount` | number of fields |
| `offsetOf(name)` | one field's offset |
| `fieldOf(name)` | `{ name, type, offset, bytes, align }` |
| `define(fields, options?)` | creates a subclass |
| `fromJSON(json)` | schema-driven revive |
| `codec(name, codec)` | registers a JSON codec |
| `codecs` | the per-isolate codec map |
| `view(address)` | an in-place accessor |

Instance members are the Map protocol (`get`, `set`, `has`, `size`, `keys`, `values`, `entries`,
`forEach`, iterator), `bytes`, `toJSON`, `toPlain`, and one generated accessor per field that is
not a reserved name.

Reserved names are `get`, `set`, `has`, `size`, `bytes`, `keys`, `values`, `entries`, `forEach`,
`toJSON`, `toPlain`, `then`, `address`, `toString`, `constructor` and `__proto__`. A C field with
one of those names is reachable through `get`/`set` and appears in `toJSON`, while the accessor
keeps its protocol meaning. The reservation never fails a definition.

### Layout

The host computes layout with libffi and caches it per class. `bytes`, `align` and `offsets` are
libffi's answer for the target ABI.

```js
Timespec.bytes;         // 16 on the supported LP64 targets
Timespec.align;         // 8
Timespec.offsets;       // [0, 8]
Timespec.fieldOf("tv_nsec"); // { name: "tv_nsec", type: cLong, offset: 8, bytes: 8, align: 8 }
```

A struct field that is an inline array is sized and accessed normally. Passing such a struct by
value throws `ERR_FFI_UNSUPPORTED_LAYOUT`; pass a pointer instead. `CArray.of(T, n)` is a
struct-field layout type and is not accepted as a top-level parameter or return.

### Views

A view reads and writes an existing buffer through the cached offsets. It allocates no native
memory and owns none.

```js
const { Struct, i32, ptr } = require("onde:ffi");

class Pair extends Struct {
  static fields = [["a", i32], ["b", i32]];
}

const storage = new Int32Array([7, 9]);
const pair = Pair.view(ptr(storage));

pair.a;        // 7
pair.b;        // 9
pair.a = 11;
storage[0];    // 11
```

A scalar, pointer or `cstring` field returns a value. A by-value struct field returns a sub-view. An
inline array field returns an indexed view with `length`, `get(i)`, `set(i, value)` and numeric
index access. `toJSON()` on a view reads every field.

Views are for out-parameters and for walking an array of structs without decoding and re-encoding
the whole struct on each access. A `cstring` field cannot be written through a view, because the
string bytes would have no owner.

## Returns

`ret` is a type object, a struct class, or `voidType`. When it is omitted, the declaration's return
type is used, or `i32` for an undeclared symbol. It is never inferred.

A `Ptr` return is a `Ptr`. A return address of 0 becomes `null`. A struct return is decoded into an
instance. A `Callback.of(args, ret)` return is a callable function with `address` and `ptr`
properties.

```js
const { dlopen, libcName, cstring, i32, Ptr, Callback } = require("onde:ffi");

const libc = dlopen(libcName, {
  dlopen: { args: [cstring, i32], ret: Ptr },
  dlsym:  { args: [Ptr, cstring], ret: Ptr },
});

const handle = libc.symbols.dlopen(null, 2);
const version = libc.call("dlsym", [handle, "getpid"], Callback.of([], i32));
version(); // calls the pointer
```

`libc.symbols.dlopen(null, 2)` opens the main program. On macOS `RTLD_NOW` is 2; the flag values
are platform-specific.

## Memory

### ref

`ref(T)` allocates `T.bytes` of zero-filled memory and returns a handle for one value:

```js
const { ref, Ptr, i32 } = require("onde:ffi");

const db = ref(Ptr);      // an 8-byte void* slot, for a T** out-parameter
const count = ref(i32);   // a 4-byte int slot

count.value = 41;
count.value;              // 41
count.address;            // BigInt
count.free();
```

A handle is accepted wherever a declared argument is a pointer, with its address passed to C. It
also has `[Symbol.dispose]`, so `using` inside a function frees it at scope exit:

```js
function readCount() {
  using count = ref(i32);
  lib.symbols.get_count(count);
  return count.value;
}
```

A finalizer frees an unreleased handle when the engine supports finalization, but call `free()`
when the lifetime matters.

Bare `Ptr` is `void*`, so `ref(Ptr)` is the `sqlite3**` pattern: the C function writes a pointer,
and `handle.value` reads it back as a `Ptr` or `null`.

### read

`read` decodes one value at an address. The byte offset is optional and defaults to 0, so the
short form is enough when the address already points at the value.

```js
read.i8(address);
read.u32(address, 4);     // five bytes in
read.i64(address);        // BigInt
read.f64(address);
read.ptr(address);        // Ptr or null
read.cstring(address);    // string or null
```

Here `address` is a `Ptr`, a BigInt or a number, and the optional second argument is a byte offset.

The available readers are `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `isize`, `usize`,
`cLong`, `f32`, `f64`, `ptr` and `cstring`. There is no `write` namespace; use a view or
`ref(T).value`.

### toArrayBuffer

`toArrayBuffer(address, offset, length, deallocator?, context?)` returns an `ArrayBuffer` over
native memory.

```js
const { toArrayBuffer } = require("onde:ffi");

const buffer = toArrayBuffer(base, 0, 16);
const bytes = new Uint8Array(buffer);
```

Without a deallocator the buffer is borrowed: the caller keeps the memory alive and frees it. With
a deallocator, a pointer to `void dealloc(void *ptr, void *context)`, the buffer owns the memory.
The host calls the deallocator once when the buffer is collected or immediately when it is detached,
including when it is transferred:

```js
const { toArrayBuffer } = require("onde:ffi");

const owned = toArrayBuffer(base, 0, size, release, context);
const moved = structuredClone(owned, { transfer: [owned] }); // release() runs now
```

The deallocator must not call into JavaScript. `close()` refuses with `ERR_FFI_LIVE_REFERENCES`
while a deallocator-backed buffer whose deallocator resolves into that library is live. A borrowed
buffer does not block a close.

Detaching a borrowed buffer does not free anything, and the caller still owns the memory.

### CString and ptr

`CString(address, offset?, length?)` copies a string out of native memory. Both optional arguments
can be omitted: the offset defaults to 0, and a missing length reads to a NUL terminator.

```js
const { CString } = require("onde:ffi");

const name = CString(pointer);          // NUL-terminated
const rest = CString(pointer, 8);       // from the ninth byte
const head = CString(pointer, 0, 8);    // at most eight bytes
```

The copy is safe after the pointer is freed.

`ptr(view)` returns a `Ptr` for a TypedArray or DataView. The view must stay alive for the call and
for as long as C may use the memory.

```js
const { ptr } = require("onde:ffi");

const data = new Uint8Array([1, 2, 3]);
const address = ptr(data); // keep `data` alive while C uses this
```

## Callbacks

A `Callback` turns a JavaScript function into a C function pointer:

```js
const { Callback, Ptr, i32, read } = require("onde:ffi");

const compare = new Callback(
  (a, b) => read.i32(a) - read.i32(b),
  { args: [Ptr.of(i32), Ptr.of(i32)], ret: i32 },
);

// Keep `compare` alive while C may call it. The qsort worked example below shows the call and
// the close.
```

`Callback.of(args, ret)` is the type form, for a function pointer that C passes to you or returns.
A `Callback` instance works where that type is declared, and its signature is taken from the
instance.

A callback runs on the isolate thread inside the C call, so it may call back into FFI. If the
JavaScript function throws, the host catches the exception, returns the zero value for the declared
return type, and rethrows the original error after the outer call returns. Other JavaScript work
continues normally afterward.

Only `close()` frees a closure. Garbage collection does not, so a dropped `Callback` leaks its
trampoline rather than letting C call freed memory. Passing a closed `Callback` as an argument
throws `ERR_FFI_CLOSED`; its `.ptr` property still holds the old address, so do not keep that
pointer and hand it to C. Closing a callback while its trampoline is on the
stack, or while any FFI call is in flight, throws `ERR_FFI_LIVE_REFERENCES`. Freeing a
closure that C may still call is undefined; keep the object alive for as long as C holds the
pointer.

`threadsafe: true` is refused with `ERR_FFI_UNSUPPORTED_THREADSAFE`. If C calls the pointer from a
foreign thread anyway, the trampoline returns a zeroed value without entering the engine; the
isolate is left untouched.

## Variadic functions

A declared variadic function marks the fixed prefix:

```js
const { dlopen, libcName, cstring, i32 } = require("onde:ffi");

const libc = dlopen(libcName, {
  printf: { args: [cstring], ret: i32, varargs: true },
});

libc.symbols.printf("%s has %d items\n", "cart", 3);
```

The declaration needs at least one fixed argument, because C requires a named parameter before
`...` and libffi requires a non-zero fixed count.

An undeclared variadic call states the fixed count per call:

```js
const { dlopen, libcName, i32 } = require("onde:ffi");

const libc = dlopen(libcName);
libc.call("printf", ["%d\n", 42], i32, { varargs: 1 });
```

The host applies C's default promotions to the arguments after the fixed ones: `f32` becomes `f64`,
and integer types narrower than 32 bits become `i32`. The fixed prefix is passed as declared and is
never promoted.

## JSON

`toJSON()` returns a plain object in field order and uses one reserved envelope for values JSON
cannot carry:

```js
const stamp = new Timespec({ tv_sec: 1720000000n, tv_nsec: 5n });
JSON.stringify(stamp);
// {"tv_sec":{"$onde":{"t":"bigint","v":"1720000000"}},
//  "tv_nsec":{"$onde":{"t":"bigint","v":"5"}}}
```

| Codec | Emitted for | Revives to |
|---|---|---|
| `bigint` | every 64-bit integer, whatever its magnitude | BigInt |
| `f64` | `NaN`, `Infinity`, `-Infinity`, `-0` | the number |
| `u8array` | a `u8` inline array | Uint8Array |
| `ptr` | any pointer | throws; pointers are encode-only |

`toPlain()` returns the form meant for people and APIs: a BigInt becomes a number when it is safe
and a decimal string otherwise, a pointer becomes `"0x..."`, and a byte array becomes base64.

`Class.fromJSON(json)` walks the class's field table, accepts an envelope or a bare value per field,
and returns an instance. `revive(value)` is schemaless: it walks an arbitrary JSON graph, decodes
envelopes through the registry, and leaves everything else alone. A standalone struct has no class
tag in its JSON, so `revive` cannot rebuild it; use the class's `fromJSON`.

Register additional codecs with `Struct.codec(name, { encode, decode })`. The registry is per
isolate. `revive` throws `ERR_FFI_UNKNOWN_CODEC` for an unregistered tag and `ERR_FFI_NOT_REVIVABLE`
for a pointer envelope.

## Errors

| Code | Raised when |
|---|---|
| `ERR_ACCESS_DENIED` | `ffi.load` is not granted; the error carries `capability: "ffi.load"` |
| `ERR_FFI_DLOPEN` | the loader could not open the path |
| `ERR_FFI_SYMBOL_NOT_FOUND` | the symbol is absent from the library |
| `ERR_FFI_UNDECLARED` | a strict library was asked to call a symbol with no declaration |
| `ERR_FFI_CLOSED` | a call through a closed handle or callback |
| `ERR_FFI_LIVE_REFERENCES` | `close()` while a deallocator-backed buffer or a call is live |
| `ERR_FFI_AMBIGUOUS_ARGUMENT` | inference refused a value |
| `ERR_FFI_MISSING_ARGUMENT` | an argument was `undefined`, or a declaration's arity did not match |
| `ERR_FFI_SIGNATURE_CONFLICT` | an explicit return type is not ABI-compatible with the declaration |
| `ERR_FFI_SHAPE_LIMIT` | a symbol exceeded four cached plans (argument shape and return type) |
| `ERR_FFI_RECURSIVE_STRUCT` | a by-value struct contains itself |
| `ERR_FFI_UNSUPPORTED_LAYOUT` | an array by value, a by-value struct with an inline array, or a bad `buffer_length` |
| `ERR_FFI_UNSUPPORTED_THREADSAFE` | a callback asked for `threadsafe: true` |
| `ERR_FFI_CALLBACK_ALLOC` | libffi could not allocate an executable closure |
| `ERR_FFI_INVALID_ADDRESS` | a null address where one is required |
| `ERR_FFI_UNKNOWN_CODEC` | `revive` met an unregistered `$onde.t` |
| `ERR_FFI_NOT_REVIVABLE` | a pointer envelope reached a decoder |
| `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE` | coercion failure or an invalid definition |

`errno()` returns the error number observed immediately after the last call and clears the stored
value. Call it before any other FFI call if the number matters.

```js
const { dlopen, libcName, errno } = require("onde:ffi");

const libc = dlopen(libcName);
libc.call("open", ["/no/such/file", 0]);
const number = errno(); // the C errno from that call
```

## Debugging a crash

A segmentation fault inside native code is not a JavaScript exception. The process dies at the
faulting instruction: there is no `catch`, no engine stack, and the shell prints only
`Segmentation fault: 11`. The runtime cannot recover, because the faulting C frames may hold
allocator or library locks and the engine's state is no longer trustworthy.

What it can do is record the call that was in flight. `--trace-ffi` writes one line per boundary
event to stderr with `write(2)`, before control enters C, so the last line survives:

```console
$ onde --trace-ffi decode.js
[ffi] open /usr/local/lib/libcodec.dylib
[ffi] declare /usr/local/lib/libcodec.dylib decode(ptr, i64) -> ptr
[ffi] image /usr/local/lib/libcodec.dylib base=0x100a2c000
[ffi] call /usr/local/lib/libcodec.dylib decode(ptr=0x16f0a3c00, i64=1048576) at /tmp/decode.js:12:18
Segmentation fault: 11
```

The last line names the library, the symbol, the coerced arguments and the JavaScript call site.
`image` is printed once per library; its base is what a crash report's program counter needs. On
macOS, symbolicate the fault with that base:

```console
$ atos -o /usr/local/lib/libcodec.dylib -l 0x100a2c000 0x100a2c4d0
decode (in libcodec.dylib) + 40
```

On Linux the equivalent is `addr2line -e libcodec.so -f -C 0x4d0`, with the address relative to
the same base. Write the trace to a file for a chatty program (`2> ffi.log`, then `tail`); the
last line is the one that matters.

`--trace-ffi=full` adds argument contents and every `Struct` layout when it is first defined:

```console
[ffi] struct TracePoint bytes=16 align=8 x:i32@0, y:f64@8
```

Compare that against `offsetof` in the C header. A declaration that disagrees with the header is
the one bug no sanitizer reports, because the write still lands inside the allocation.

Compiled apps have no command line, so the same switch is an environment variable:
`ONDE_FFI_TRACE=1` or `ONDE_FFI_TRACE=full`. The flag wins when both are present.

When the trace is not enough, attach a debugger:

```console
$ lldb -- ./onde --allow-ffi decode.js
(lldb) run
(lldb) bt
```

Release builds keep symbols, so `onde` frames are named; the fault is usually the library frame
just above `ffi_call`. On Linux, `gdb`, `valgrind` or an ASAN build tell you why the memory was
invalid, which is a different question from where the process stopped.

The common causes, in the order they appear:

* a declaration that disagrees with the header (`i64` where C takes `double`, a missing
  `buffer_length`, a `Struct` field out of order), which makes libffi pass the wrong registers;
* an integer passed where C expects a pointer in an **undeclared** call. Inference types the
  number as `i32`, and the call has no signature to contradict it, so `lib.call("greet", [5])`
  still crashes even though a declared `cstring` parameter rejects a number. Declare the symbol,
  use `{ strict: true }` so undeclared calls are refused, or pass an explicit `Ptr`;
* an explicit `BigInt` or `Ptr` address that is not a valid pointer. That is the documented
  escape hatch and the runtime does not second-guess it;
* a `ref` read after `free()`, or a `Ptr` from `ptr(view)` used after the buffer was detached;
* a callback whose declared signature differs from the C function pointer type it fills.

## Worked example: sqlite3

```js
const {
  dlopen, ref, Ptr, cstring, i32,
} = require("onde:ffi");

const lib = dlopen("libsqlite3.dylib", {
  sqlite3_libversion: { args: [], ret: cstring },
  sqlite3_open_v2: { args: [cstring, Ptr.of(Ptr), i32, cstring], ret: i32 },
  sqlite3_close: { args: [Ptr], ret: i32 },
  sqlite3_errmsg: { args: [Ptr], ret: cstring },
});

console.log(lib.symbols.sqlite3_libversion());

const db = ref(Ptr);
try {
  // SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
  const status = lib.symbols.sqlite3_open_v2(":memory:", db, 0x2 | 0x4, null);
  if (status !== 0) throw new Error(`open failed: ${status}`);

  // db.value is the sqlite3* the C function wrote into the slot.
  console.log("handle", db.value.hex);

  const rc = lib.symbols.sqlite3_close(db.value);
  if (rc !== 0) throw new Error(`close failed: ${lib.symbols.sqlite3_errmsg(db.value)}`);
} finally {
  db.free();
  lib.close();
}
```

On Linux the library is `libsqlite3.so.0`, and on Debian or Ubuntu it comes from
`libsqlite3-0`.

## Worked example: qsort

```js
const {
  dlopen, libcName, Callback, Ptr, i32, usize, buffer, read, voidType,
} = require("onde:ffi");

const libc = dlopen(libcName, {
  qsort: {
    args: [buffer, usize, usize, Callback.of([Ptr.of(i32), Ptr.of(i32)], i32)],
    ret: voidType,
  },
});

const data = new Int32Array([5, 1, 4, 2, 3]);
const compare = new Callback(
  (a, b) => read.i32(a) - read.i32(b),
  { args: [Ptr.of(i32), Ptr.of(i32)], ret: i32 },
);

libc.symbols.qsort(data, data.length, Int32Array.BYTES_PER_ELEMENT, compare);
compare.close();
libc.close();

console.log(Array.from(data)); // [1, 2, 3, 4, 5]
```

## Limits

Calls are synchronous and run on the isolate thread. A long C call blocks timers, I/O completions
and `process.exit`, and no timeout can preempt it.

The supported targets are macOS and Linux on x86_64 and aarch64. Windows is not supported in this
version; `cLong` follows the host's `sizeof(long)`, so an LLP64 target would use 4 bytes, but the
loader path has not been exercised there.

These layouts are not supported: unions, bitfields, flexible array members, `long double`,
`__int128`, packed structs, arrays passed by value, and by-value structs that contain an inline
array.

There is no N-API support and no `process.dlopen`, so npm packages with native addons do not work.
C++ names are not demangled; use C symbols with C linkage.

The build links the system libffi, so the platform package must be present: the macOS SDK, or
`libffi-dev` on Linux.

FFI is not a sandbox. The gates decide whether a process may load native code. Once a library is
loaded, it runs with the process's permissions and can do anything the process can do.

## Where to read more

- [ffi-plan.md](ffi-plan.md) is the API contract, inference rules, error model and recorded
  deviations.
- [ADR-0010](adr/0010-ffi-dlopen.md) explains the libffi design and the gate.
- [compat.md](compat.md) records the extension as D81.
- `test/ffi/` contains the C fixture, the layout oracle and the matrix that exercises every path
  listed here.
