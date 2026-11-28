# `onde:ffi` test fixture

A plain C shared library that the `onde:ffi` tests `dlopen()` and call through libffi, plus a
layout oracle that prints the compiler's word for the struct layout the host has to reproduce.

**The ABI is the test contract.** The signatures in `fixture.h` are what the JS matrix declares;
changing a prototype or a struct field means changing the matrix under `test/ffi/` in the same
change. Everything here is C11, libc-only (no libm, no build system, no threads) so a single `cc`
command builds it on both targets.

## Build

Linux (`.so`):

```sh
cc -shared -fPIC -O2 -o /tmp/libffi-fixture.so test/ffi/fixture/fixture.c
```

macOS (`.dylib`):

```sh
cc -shared -fPIC -O2 -o /tmp/libffi-fixture.dylib test/ffi/fixture/fixture.c
```

Warnings check (what CI should use):

```sh
cc -std=c11 -Wall -Wextra -Werror -shared -fPIC -O2 -o /tmp/libffi-fixture.dylib \
   test/ffi/fixture/fixture.c
```

Every export is a plain non-static function or `fixture_global_counter`, so both platforms export
all 36 symbols (`nm -D` on Linux, `nm -gU` on macOS; macOS adds the leading underscore).

## Layout oracle

`test/ffi/layout.c` is a standalone program that links the fixture source and prints the real
compiler's `sizeof`/`_Alignof`/`offsetof`. It measures; it never assumes a value.

```sh
cc -o /tmp/layout test/ffi/layout.c test/ffi/fixture/fixture.c
/tmp/layout
```

Output, one record per line, `%zu` numbers, exit status 0:

```
<struct> <sizeof> <align>
<struct>.<field> <offset>
<char|short|int|long|longlong|float|double|pointer> <sizeof> <align>
```

Observed on macOS arm64 (clang, LP64); a Linux x86_64/aarch64 build is measured separately by the
same program rather than compared with these numbers:

```
FixturePair 8 4
FixtureMixed 32 8
FixtureNested 12 4
FixtureArray 12 4
FixtureBig 24 8
FixtureSockaddr 8 2
FixtureSockaddrIn 8 4
FixturePair.a 0
FixturePair.b 4
FixtureMixed.c 0
FixtureMixed.i 4
FixtureMixed.d 8
FixtureMixed.p 16
FixtureMixed.s 24
FixtureNested.pair 0
FixtureNested.tail 8
FixtureArray.bytes 0
FixtureArray.n 8
FixtureBig.d 0
FixtureBig.l 8
FixtureBig.u8 16
FixtureBig.s16 18
FixtureBig.f32 20
FixtureSockaddr.family 0
FixtureSockaddr.data 2
FixtureSockaddrIn.family 0
FixtureSockaddrIn.port 2
FixtureSockaddrIn.addr 4
char 1 1
short 2 2
int 4 4
long 8 8
longlong 8 8
float 4 4
double 8 8
pointer 8 8
```

## Exports

| Export                    | C signature                                                                 | What the test asserts                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture_global_counter`  | `int32_t`                                                                   | Data symbol via `dlsym`: starts at 7, reads as `i32` and writes back.                                                                                      |
| `fixture_add_i32`         | `int32_t (int32_t, int32_t)`                                                | Two `i32` args and an `i32` return: 2+3 = 5; two's-complement wrap at the boundary.                                                                        |
| `fixture_add_i64`         | `int64_t (int64_t, int64_t)`                                                | 64-bit args/return beyond 2^32: 2^40+5 = 2^40+5.                                                                                                           |
| `fixture_add_u64`         | `uint64_t (uint64_t, uint64_t)`                                             | Unsigned 64-bit does not flip sign above 2^63; UINT64_MAX+1 wraps to 0.                                                                                    |
| `fixture_i64_ident`       | `int64_t (int64_t)`                                                         | Negative `i64` survives the round trip unchanged.                                                                                                          |
| `fixture_u64_ident`       | `uint64_t (uint64_t)`                                                       | Value above 2^63 survives as the exact BigInt.                                                                                                             |
| `fixture_neg_i8`          | `int32_t (int8_t)`                                                          | An `i8` argument sign-extends to the `i32` return: -INT8_MIN = 128.                                                                                        |
| `fixture_u32_ident`       | `uint32_t (uint32_t)`                                                       | 0xFFFFFFFF reads as 4294967295, not -1.                                                                                                                    |
| `fixture_sum9`            | `int32_t (int32_t ×9)`                                                      | Nine integer arguments cross the register/stack boundary (SysV): 1..9 = 45.                                                                                |
| `fixture_mul_f64`         | `double (double, double)`                                                   | `double` args/return: 2.5 × 4 = 10.                                                                                                                        |
| `fixture_mul_f32`         | `float (float, float)`                                                      | `float` is a separate ABI class: 1.5 × 2 = 3.                                                                                                              |
| `fixture_not_bool`        | `_Bool (_Bool)`                                                             | `bool` round-trips true→false and false→true.                                                                                                              |
| `fixture_cstrlen`         | `size_t (const char *)`                                                     | A JS string becomes a `char *` and its length is returned; NULL → 0.                                                                                       |
| `fixture_is_null`         | `int32_t (const void *)`                                                    | A null pointer is address 0: NULL → 1, non-NULL → 0.                                                                                                       |
| `fixture_ident_ptr`       | `void *(void *)`                                                            | A pointer argument is returned unchanged (same address, not copied).                                                                                       |
| `fixture_ret_cstring`     | `const char *(void)`                                                        | A returned `char *` decodes to the JS string `"onde-ffi"`.                                                                                                 |
| `fixture_ret_i64_min`     | `int64_t (void)`                                                            | INT64_MIN is exact through BigInt.                                                                                                                         |
| `fixture_ret_u64_max`     | `uint64_t (void)`                                                           | UINT64_MAX is exact through BigInt.                                                                                                                        |
| `fixture_pair_sum`        | `int32_t (struct FixturePair)`                                              | A struct passed **by value** (two `i32`): fields read at the measured offsets; 2+3 = 5.                                                                    |
| `fixture_pair_make`       | `struct FixturePair (int32_t, int32_t)`                                     | A struct **returned by value**; both fields survive the register/`sret` path.                                                                              |
| `fixture_pair_out`        | `int32_t (int32_t, int32_t, struct FixturePair *)`                          | An out-param (`ref(Ptr.of(FixturePair))`) receives the fields and the call returns 0 (NULL out → -1).                                                      |
| `fixture_mixed_weight`    | `double (struct FixtureMixed)`                                              | A mixed struct by value (char, i32, double, pointer, short, with padding): returns `c + i + d + (p != NULL) + s`.                                          |
| `fixture_array_sum`       | `int32_t (struct FixtureArray)`                                             | A struct containing an inline `uint8_t[8]` by value: sum of the bytes plus `n` (1..8, n=4 → 40).                                                           |
| `fixture_call_cb`         | `int32_t (int32_t (*)(int32_t, int32_t), int32_t, int32_t)`                 | A JS `Callback` is invoked inline with the two `i32`s and its result is returned: 6×7 → 42.                                                                |
| `fixture_call_cb_n`       | `int32_t (int32_t (*)(int32_t), int32_t)`                                   | The callback runs **exactly n times**, `i = 0..n-1`; identity sums to 10 for n=5, n=0 → 0, NULL → 0.                                                       |
| `fixture_call_cb_ptrs`    | `int32_t (int32_t (*)(const int32_t *, const int32_t *), int32_t, int32_t)` | The callback receives pointers to the two arguments and reads them: 20+22 → 42.                                                                            |
| `fixture_variadic_sum`    | `int32_t (int32_t, ...)`                                                    | Declared `{ args: [i32], varargs: true }`: 3,10,20,12 → 42; the fixed argument count must be 1.                                                            |
| `fixture_set_errno`       | `void (int32_t)`                                                            | Sets `errno`; read back by `fixture_get_errno` and by the host's `errno()`.                                                                                |
| `fixture_get_errno`       | `int32_t (void)`                                                            | Returns the current `errno` (0x1234 after the setter).                                                                                                     |
| `fixture_alloc`           | `void *(size_t)`                                                            | `malloc` for the host; NULL only on failure. Returned to JS as a `Ptr`/external buffer.                                                                    |
| `fixture_free`            | `void (void *)`                                                             | Releases a pointer from `fixture_alloc`; NULL is a no-op.                                                                                                  |
| `fixture_alloc_buffer`    | `void *(size_t)`                                                            | Allocated memory is filled with `0,1,…,255,0,1,…`; a `Uint8Array`/`toArrayBuffer` view reads that pattern.                                                 |
| `fixture_release`         | `void (void *, void *)`                                                     | A deallocator: frees the pointer, increments the release counter, records the context pointer.                                                             |
| `fixture_release_count`   | `int32_t (void)`                                                            | Number of `fixture_release` calls so far.                                                                                                                  |
| `fixture_last_context`    | `int32_t (void)`                                                            | Low 32 bits of the last context pointer (0x1234 → 4660).                                                                                                   |
| `fixture_sockaddr_family` | `int32_t (const void *)`                                                    | Reads the `uint16_t` family at offset 0 (via `FixtureSockaddr`), then the same address is cast to `FixtureSockaddrIn` and re-read; AF_INET = 2, NULL → -1. |

## Fixed semantics worth knowing

- `fixture_call_cb_n(cb, n)` calls `cb(0) … cb(n-1)`, i.e. exactly `n` times; `n <= 0` or a NULL
  callback returns 0 without calling.
- Sums that could overflow (`add_i32`, `add_i64`, `sum9`, `pair_sum`, `array_sum`,
  `variadic_sum`) wrap modulo 2^32/2^64 (two's complement) and are computed in unsigned
  arithmetic, so they are free of signed-overflow UB.
- NULL is accepted by every pointer/receiver argument: `pair_out`, `call_cb`, `call_cb_n`,
  `call_cb_ptrs` and `sockaddr_family` return a documented error/zero, `free`/`release` are
  no-ops, `cstrlen(NULL)` is 0.
- `fixture_mixed_weight` deliberately gives the pointer field a fixed contribution (1.0 non-NULL,
  0.0 NULL) instead of its numeric address, so the expected value is exact and address-independent.
- `fixture_global_counter` and the release counter/context are process-wide state; tests that
  mutate them must not assume a fresh library load.
