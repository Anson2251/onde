# qjsc / QuickJS bytecode mechanics — research notes

> **Design status (2026-11-20):** this is evidence for the bytecode step of `lite build`; the
> shipping design links a static library rather than using qjsc's C-driver shape verbatim. See
> [`../standalone-build.md`](../standalone-build.md).

Status: research for the `ln-engine` / build-time bytecode question. Nothing here is a
decision; it is evidence plus a few clearly-labelled inferences.

Environment used for the measurements in this document:

| Thing | Value |
| --- | --- |
| Host | macOS 27.2.1 arm64 (Apple M3), Apple clang 21.0.0, cmake 4.4.4 |
| Engine A (the repo's engine) | quickjs-ng as vendored by `rquickjs-sys 0.14.0` (`~/.cargo/registry/src/*/rquickjs-sys-0.14.0/quickjs`) — headers report **0.16.2**, `BC_VERSION` is **28** |
| Engine B (upstream tag) | quickjs-ng `v0.16.2` tarball — `BC_VERSION` **27** |
| Engine C (upstream tag) | quickjs-ng `v0.17.0` — `BC_VERSION` **28**; `v0.18.0` — **29** |
| Engine D (Bellard) | [quickjs-2026-06-04](https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz), latest at time of writing |
| Engine E (Bellard, older) | quickjs-2025-09-13, quickjs-2024-01-13, quickjs-2021-03-27 (for version-drift tests) |

> **Finding 0 (matters for everything below).** The quickjs-ng tree that rquickjs 0.14
> actually compiles is **not** the `v0.16.2` tag. `quickjs.h:1450-1452` says
> `0.16.2`, but `quickjs.c` has `#define BC_VERSION 28` (vendored `quickjs.c:38478`),
> while the `v0.16.2` tag has `BC_VERSION 27`. The vendored tree is a post-0.16.2
> snapshot whose bytecode format already matches `v0.17.0`. So "we are on 0.16.2" is
> not a usable statement about bytecode compatibility. The engine's *reported* version
> string and its *bytecode* version are independent.

Legend: **[verified]** = read in source or observed by running a binary built here.
**[measured]** = benchmark/number produced in this session. **[inference]** = reasoned
from code, not executed.

---

## 1. qjsc CLI: Bellard vs quickjs-ng

The two CLIs diverged a lot. Bellard's `qjsc` is a compiler *driver* (it can invoke the
C compiler for you); quickjs-ng's `qjsc` is a bytecode/C emitter only.

### 1.1 Bellard `qjsc` (2026-06-04)

Source: `qjsc.c` in the [2026-06-04 tarball](https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz),
help text at `qjsc.c:393-427`, option loop at `qjsc.c:588-730`.

| Flag | Meaning (verified from source + behaviour) |
| --- | --- |
| *(none)* | Default output type is `OUTPUT_EXECUTABLE` (`qjsc.c:591`): writes a temp `outNNNN.c`, then **forks the C compiler** to produce `a.out` (`output_executable()`, `qjsc.c:449-517`). |
| `-c` | `OUTPUT_C`: a `.c` file containing only the bytecode array(s), `#include <inttypes.h>`, **no `main()`** (`qjsc.c:770-777`; `main()` is only emitted inside `if (output_type != OUTPUT_C)` at `qjsc.c:794`). |
| `-e` | `OUTPUT_C_MAIN`: bytecode + `main()` + `JS_NewCustomContext()`; `#include "quickjs-libc.h"` (`qjsc.c:770-774`). |
| `-o file` | Output filename (default `a.out` for executable, `out.c` otherwise, `qjsc.c:732-740`). |
| `-N cname` | C name of the emitted data (default `qjsc_<basename>`, see `get_c_name()`). |
| `-p prefix` | Prefix for generated C identifiers (default `qjsc_`). |
| `-m` | Compile as ES module (default: autodetect via `.mjs`/`JS_DetectModule`). |
| `-D module` | Also compile a **dynamically loaded** module (import target known only at run time, e.g. `os.Worker`). |
| `-M module[,cname]` | Register an **external C module** (adds `extern js_init_module_*` calls to `main()`). |
| `-x` | "byte swapped output (only used for cross compilation)". **Now a no-op**: it sets `JS_WRITE_OBJ_BSWAP`, but that flag is never read by `quickjs.c` in 2026-06-04. `qjsc -c` and `qjsc -x -c` produced byte-identical files (`cmp` clean). |
| `-s` | `strip_flags = JS_STRIP_DEBUG` (`qjsc.c:713`) → strips source **and** debug info (default is source-only, `qjsc.c:597`). |
| `--keep-source` | `strip_flags = 0` (`qjsc.c:716`) — keeps source text in the bytecode (largest output). |
| `-S n` | `JS_SetMaxStackSize(rt, n)` in generated `main()`; suffix parsing (`get_suffixed_size`). |
| `-flto` | Only when `CONFIG_LTO` is compiled in; passes `-flto` to the link step and links `libquickjs.lto.a`. |
| `-fno-<feature>` | Drop intrinsics from generated `main()`; feature list at `qjsc.c:67-79`: `date, eval, string-normalize, regexp, json, proxy, map, typedarray, promise, module-loader, weakref`. Verified: `-fno-weakref` accepted, **`-fno-bigint` rejected** (`unsupported feature: no-bigint`) even though `doc/quickjs.texi` still lists it — docs lag code. |
| `-v` | Verbose: prints the compiler command line. |
| `-h`, `-?`, `--help` | Help, exit 1. |

Note the doc/help mismatch: `doc/quickjs.texi:145-178` documents `-c -e -o -N -m -D -M -x
-flto -fno-*` but **not** `-s`/`--keep-source` (added 2025-04-26 per `Changelog`).

### 1.2 quickjs-ng `qjsc` (vendored snapshot / 0.16.x / 0.17.x)

Source: `qjsc.c` in the crate snapshot (`help()` at `qjsc.c:334-355`, option loop at
`qjsc.c:396-548`), man page `qjsc.man`; upstream docs
[docs/docs/cli.md](https://github.com/quickjs-ng/quickjs/blob/master/docs/docs/cli.md).

| Flag | Meaning (verified) |
| --- | --- |
| *(none)* | Default output type is `OUTPUT_C` (`qjsc.c:412`): a C file with the bytecode array, `#include <inttypes.h>`, **no `main()`**; default filename `out.c` (`qjsc.c:557-558`). It never invokes a C compiler. |
| `-e` | Bytecode **+ `main()`** in one C file (`OUTPUT_C_MAIN`), includes `quickjs-libc.h`, emits `JS_NewCustomContext`, `js_std_add_helpers`, `js_std_eval_binary`, `js_std_loop` (`qjsc.c:309-332`, `qjsc.c:585-660`). |
| `-b` | Raw bytecode to a file (`OUTPUT_RAW`, `qjsc.c:467-469`, write at `qjsc.c:176-178`). Bellard has no equivalent (Bellard deliberately refuses to write bytecode to a plain file — see §4). |
| `-o file` | Output filename. |
| `-n name` | Script name used in stack traces (passed as the `JS_Eval` filename, `qjsc.c:298`). **Bellard has no `-n`.** |
| `-N cname` | C name of the data. |
| `-C` | Force classic script (Bellard has no `-C`; it always autodetects). Not listed in `qjsc.man` or `cli.md` — code-only. |
| `-m` | Force ES module. |
| `-D`, `-M` | Same idea as Bellard (`-M module[,cname]`). |
| `-p prefix` | C identifier prefix (default `qjsc_`). |
| `-P` | Do **not** add the default system modules (`qjs:std`, `qjs:os`, `qjs:bjson`, `std`, `os`, `bjson`) (`qjsc.c:529-542`). Code-only, not in the man page. |
| `-s` | Strip source; **`-s -s`** (or `-ss`) also strips debug info (`qjsc.c:521-524`, `output_object_code()` `qjsc.c:154-190`). |
| `-S n` | Max stack size, with `k/m/g` suffixes and a stricter parser than Bellard (`parse_limit()`, `qjsc.c:357-384`). |
| `-h/--help` | Help, exit 1. |

Verified rejections (they print help and exit 1): `qjsc -c`, `qjsc --keep-source`,
`qjsc -x`. There is **no** `-flto` and **no** `-fno-*` in quickjs-ng.

### 1.3 `-s`/`--keep-source` semantics are *not* the same

| | default | strip source only | strip source+debug | keep source |
| --- | --- | --- | --- | --- |
| Bellard | source stripped (`JS_STRIP_SOURCE`) | — (default) | `-s` | `--keep-source` |
| quickjs-ng | **nothing stripped** | `-s` | `-ss` | — (default) |

Bellard strips via runtime flag `JS_SetStripInfo(rt, flags)` (`qjsc.c:761`,
`quickjs.h:930-932`); quickjs-ng removed `JS_SetStripInfo` entirely and uses the
serializer flags `JS_WRITE_OBJ_STRIP_SOURCE` / `JS_WRITE_OBJ_STRIP_DEBUG`
(`quickjs.h:1257-1258`). Consequence: Bellard's `-s` is roughly quickjs-ng's `-ss`
in effect, and quickjs-ng's default C output is *larger* than Bellard's default.

---

## 2. What the generated C file looks like

### 2.1 Bellard, `-c` (no main) — real output for a 6-line script

```c
/* File generated automatically by the QuickJS compiler. */

#include <inttypes.h>

const uint32_t qjsc_throw_size = 185;

const uint8_t qjsc_throw[185] = {
 0x05, 0x05, 0x0a, 0x69, 0x6e, 0x6e, 0x65, 0x72,
 0x0a, 0x6f, 0x75, 0x74, 0x65, 0x72, 0x10, 0x74,
 ...
};
```

Header bytes decode as: `0x05` = `BC_VERSION`, `0x05` = atom count (leb128), then the
atom table (`0x0a` = len 5, "inner"; "outer"; "throw.js"; "x"; "boom"), then the serialized
function. There is **no checksum and no engine-version field**.

### 2.2 Bellard, `-e` — tail of the real file

```c
static JSContext *JS_NewCustomContext(JSRuntime *rt)
{
  JSContext *ctx = JS_NewContextRaw(rt);
  if (!ctx)
    return NULL;
  JS_AddIntrinsicBaseObjects(ctx);
  JS_AddIntrinsicDate(ctx);
  JS_AddIntrinsicEval(ctx);
  /* ... one call per enabled feature (the -fno-* bitmap) ... */
  JS_AddIntrinsicWeakRef(ctx);
  return ctx;
}

int main(int argc, char **argv)
{
  JSRuntime *rt;
  JSContext *ctx;
  rt = JS_NewRuntime();
  js_std_set_worker_new_context_func(JS_NewCustomContext);
  js_std_init_handlers(rt);
  JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);
  ctx = JS_NewCustomContext(rt);
  js_std_add_helpers(ctx, argc, argv);
  js_std_eval_binary(ctx, qjsc_throw, qjsc_throw_size, 0);
  js_std_loop(ctx);
  js_std_free_handlers(rt);
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return 0;
}
```

### 2.3 quickjs-ng, default (no main) and `-e`

Default (this is `qjsc file.js` with no flags — note `#include <inttypes.h>`, no `main`):

```c
/* File generated automatically by the QuickJS-ng compiler. */

#include <inttypes.h>

const uint32_t qjsc_hello_size = 93;

const uint8_t qjsc_hello[93] = {
 0x1c, 0x43, 0xac, 0x60, 0xe8, 0x88, 0x02, 0x01,
 ...
};
```

`0x1c` = 28 (`BC_VERSION`), next 4 bytes = checksum (`bc_csum`), then leb128 atom count.

`-e` differs from Bellard's `-e` in that it uses `JS_NewContext` (not
`JS_NewContextRaw` + `JS_AddIntrinsic*`) and always installs the module loader:

```c
int main(int argc, char **argv)
{
  int r;
  JSRuntime *rt;
  JSContext *ctx;
  r = 0;
  rt = JS_NewRuntime();
  js_std_set_worker_new_context_func(JS_NewCustomContext);
  js_std_init_handlers(rt);
  JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);
  ctx = JS_NewCustomContext(rt);
  js_std_add_helpers(ctx, argc, argv);
  js_std_eval_binary(ctx, qjsc_bootstrap, qjsc_bootstrap_size, 0);
  r = js_std_loop(ctx);
  if (r) {
    js_std_dump_error(ctx);
  }
  js_std_free_handlers(rt);
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return r;
}
```

`js_std_eval_binary()` is thin: `JS_ReadObject(ctx, buf, len, JS_READ_OBJ_BYTECODE)`, and
for a module `JS_ResolveModule` + `JS_EvalFunction`; on error it calls
`js_std_dump_error(ctx); exit(1);` (`quickjs-libc.c:4950-4991` in the snapshot;
Bellard `quickjs-libc.c:4353-4385` is the same shape, including `js_std_dump_error`
+ `exit(1)` on failure). There is no `JS_ReadObject`-then-`JS_Call` "call the default export"
magic — it is a plain evaluate.

### 2.4 Exact compile + link commands

**Bellard** — generated by `qjsc` itself (captured with `qjsc -v`; `output_executable()`,
`qjsc.c:449-517`):

```console
$ ./qjsc -v hello.js
clang -O2 -D _GNU_SOURCE -I /tmp/bellard -o a.out /tmp/out6691.c /tmp/bellard/libquickjs.a -lm -ldl -lpthread
```

i.e. `$(CC) -O2 [-flto] -D_GNU_SOURCE -I<includedir> -o <out> <tmp>.c <libdir>/libquickjs[.lto].a -lm -ldl -lpthread`
(with `-rdynamic` added if a `.so` module was referenced). Include/lib dirs are
`<dir-of-qjsc-binary>` if `quickjs.h` sits next to it, else `$(PREFIX)/include/quickjs`
and `$(PREFIX)/lib/quickjs` (`qjsc.c:469-474`). Note: `-ldl` on macOS is harmless.

**Bellard** — from the Makefile, the documented "static JS compilation" pattern
(`Makefile:394-401`):

```make
hello.c: $(QJSC) $(HELLO_SRCS)
	$(QJSC) -e $(HELLO_OPTS) -o $@ $(HELLO_SRCS)
examples/hello: $(OBJDIR)/hello.o $(QJS_LIB_OBJS)
	$(CC) $(LDFLAGS) -o $@ $^ $(LIBS)     # LIBS = -lm -lpthread [-ldl]
```

**quickjs-ng** — `qjsc` never links. The documented command
([cli.md:118](https://github.com/quickjs-ng/quickjs/blob/master/docs/docs/cli.md#L118))
compiles the engine sources in one go:

```console
$ cc hello.c dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c -I. -o hello
```

For embedding against a prebuilt library (what a Rust host does):

```console
$ cc -O2 -I<quickjs-src> -o app out.c -L<build> -lqjs -lm -lpthread
```

(verified: `cc -O1 -I<src> -o t out.c -L/tmp/ngbuild/b -lqjs -lm -lpthread` links and runs,
where `libqjs.a` was built with `-DQJS_BUILD_LIBC=ON`; without libc in the library you must
also compile `quickjs-libc.c`). quickjs-ng has no `cutils.c` at all (header-only
`cutils.h`), which is why the one-liner above omits it.

---

## 3. libquickjs.a and libquickjs-libc

### 3.1 Bellard

`Makefile:250-256, 309-317`:

```make
QJS_LIB_OBJS=$(OBJDIR)/quickjs.o $(OBJDIR)/dtoa.o $(OBJDIR)/libregexp.o $(OBJDIR)/libunicode.o $(OBJDIR)/cutils.o $(OBJDIR)/quickjs-libc.o
libquickjs$(LTOEXT).a: $(QJS_LIB_OBJS)
	$(AR) rcs $@ $^
```

`install` puts `libquickjs.a` (+ `libquickjs.lto.a` if `CONFIG_LTO`) in
`$(PREFIX)/lib/quickjs` and headers in `$(PREFIX)/include/quickjs` (`Makefile:377-390`).
The **documented link line** is what `qjsc` emits (above) and what the Makefile uses:
`-lm -lpthread -ldl` (`Makefile:256-261`); `HOST_LIBS=-lm -ldl -lpthread` for host tools.
macOS: same line works (`-ldl` is a no-op stub). `libquickjs.a` already contains
`quickjs-libc.o`, so `js_std_*` and the `std`/`os` modules come with it.

### 3.2 quickjs-ng

CMake is the build system. Targets (`CMakeLists.txt`):

* `qjs` — the library (`add_library(qjs ${qjs_sources})`, line 304), static or shared
  per `BUILD_SHARED_LIBS`; installs a CMake package `qjsConfig` (lines 566-570) and
  `quickjs.h` (line 556).
* `qjs-libc` — a **separate** static lib, built when `QJS_BUILD_LIBC` is OFF
  (lines 338-343), which is the option's **default** (`xoption(... OFF)`, line 257).
  Every executable links it via `add_qjs_libc_if_needed()` (lines 258-262). Passing
  `-DQJS_BUILD_LIBC=ON` instead compiles `quickjs-libc.c` into `libqjs.a`
  (lines 279-283).
* `qjs_exe`, `qjsc` — executables; **`qjsc` is installed** by `cmake --install`
  (`install(TARGETS qjsc RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})`, line 562),
  together with `qjsc.1`/`qjs.1` man pages (lines 563-564).
* There is no `libquickjs.a` name; the archive is `libqjs.a` (verified in a local build).
  A `Makefile` wrapper exists (`make`, `make codegen`) but CMake does the work.

`qjs --std` is just `js_std_add_helpers` + importing the three modules and hanging them
on the global object (`qjs.c:487-495` in Bellard, `qjs.c:646-654` in ng):

```js
import * as bjson from 'qjs:bjson';
import * as std from 'qjs:std';
import * as os from 'qjs:os';
globalThis.bjson = bjson; globalThis.std = std; globalThis.os = os;
```

`quickjs-libc` provides (`quickjs-libc.h:41-81`): `js_init_module_std/os/bjson`,
`js_std_add_helpers`, `js_std_loop[_once]`, `js_std_poll_io`, `js_std_init_handlers`,
`js_std_free_handlers`, `js_std_dump_error`, `js_std_eval_binary`,
`js_std_promise_rejection_tracker`, worker hooks. Bellard's `std` module also has
`std.evalScript`, `std.loadFile`, `std.open`, `std.parseExtJSON`, etc.

> **Practical consequence for lite-node:** `rquickjs-sys` compiles only
> `quickjs.c, dtoa.c, libregexp.c, libunicode.c` (`build.rs:143`) — **not**
> `quickjs-libc.c` and **not** `qjsc.c`. So (a) the repo's `libquickjs.a` has no
> `js_std_eval_binary`, no `std`/`os`/`bjson` modules; (b) there is no `qjsc` binary
> anywhere in the dependency graph. Any build-time bytecode step has to compile `qjsc`
> from the *same* vendored tree itself, and any embedding has to go through
> `JS_ReadObject` (rquickjs exposes the pair as `Module::write(WriteOptions)` and
> `unsafe Module::load(ctx, bytes)` in `rquickjs-core-0.14.0/src/value/module.rs:469`
> and `:338-345`; the latter passes `JS_READ_OBJ_BYTECODE | JS_READ_OBJ_ROM_DATA`).

---

## 4. Bytecode format facts

### 4.1 Versions

| Engine | `BC_VERSION` | Where |
| --- | --- | --- |
| Bellard 2026-06-04 | **5** | `quickjs.c:37388` |
| Bellard 2025-09-13 | 5 | `quickjs.c` (`grep '#define BC_VERSION'`) |
| Bellard 2024-01-13 / 2021-03-27 | `BC_BASE_VERSION \| BC_BE_VERSION` where base = **2 if `CONFIG_BIGNUM` else 1**, BE bit **0x40** | 2024-01-13 `quickjs.c:34551-34559`, `35374` |
| quickjs-ng v0.10.1 / v0.12.1 / v0.14.0 / v0.15.0 | 20 / 23 / 25 / 26 | tag sources |
| quickjs-ng v0.16.0, v0.16.2 | **27** | tag source |
| quickjs-ng v0.17.0 | **28** | tag source |
| quickjs-ng v0.18.0 | **29** | tag source |
| quickjs-ng as vendored by rquickjs-sys 0.14.0 | **28** (headers say 0.16.2) | vendored `quickjs.c:38478` |

So: Bellard counts `5`; quickjs-ng counts `29` and has bumped 20→29 across the releases
0.10 → 0.18 (one bump per minor release since 0.14). The two formats are unrelated.

### 4.2 What `JS_WriteObject` / `JS_ReadObject` actually check

Layout (both engines): `[BC_VERSION u8][atom table][serialized object graph]`;
quickjs-ng inserts a u32 checksum right after the version.

* **Version.** Bellard: `if (v8 != BC_VERSION) → "invalid version (%d expected=%d)"`
  (`quickjs.c:39313-39321`). quickjs-ng: same check plus checksum
  (`quickjs.c:40474-40500` in the snapshot).
* **Checksum.** quickjs-ng only: `bc_csum()` over the payload
  (`quickjs.c:38628-38655`), verified at read time; mismatch →
  `SyntaxError: checksum error`. `UINT32_MAX` is an escape hatch used by
  `tests/test_bjson.js` (comment in `JS_ReadObjectAtoms`: "allow UINT32_MAX as an
  escape hatch, otherwise updating the test corpus in tests/test_bjson.js gets too
  tedious"). **Bellard has no checksum at all.**
* **Trust.** quickjs-ng `quickjs.h:1263-1265`: "WARNING: only enable
  `JS_READ_OBJ_BYTECODE` on input from a trusted writer. The bytecode format is not
  designed to resist a hostile producer; loading adversarial bytecode can lead to
  memory corruption." Bellard `doc/quickjs.texi:858-862`: "the bytecode format is
  linked to a given QuickJS version. Moreover, no security check is done before its
  execution… That's why there is no option to output the bytecode to a binary file in
  `qjsc`." (quickjs-ng added `-b` anyway.)
* **Structural.** There is no bytecode verifier on the read path. `compute_stack_size()`
  — the pass that would notice invalid opcodes — runs at *compile* time only
  (`js_create_function`, ng `quickjs.c:37027`), not in `JS_ReadObject`. A foreign blob
  therefore surfaces as a runtime failure (`invalid opcode: pc=%u opcode=0x%02x`,
  ng `quickjs.c:20889`, Bellard `quickjs.c:20540`) after partially executing, or as
  memory corruption.

### 4.3 Portability matrix

| Axis | Bellard 2026-06-04 | quickjs-ng (28/29) |
| --- | --- | --- |
| Across engine versions | **No.** Same `BC_VERSION 5` on 2025-09-13 and 2026-06-04, yet bytecode is *not* compatible — see the experiment below. | **No** in general. `v0.16.2` (27) → 28: rejected cleanly. `v0.17.0` (28) → vendored 28: byte-identical for a toy file and loads/evals fine — same number usually means compatible, but it is not a contract (see Bellard counter-example). |
| Endianness | **Yes**, canonical little-endian on disk: `bc_put_u16/u32/u64` swap on `is_be()` (`quickjs.c:37448-37482`) and `bc_get_*` swap back (`bc_get_u16` at `38318`, `JS_ReadString` at `38470-38482`). `-x` is vestigial. Older Bellard (≤2024) instead encoded endianness in bit `0x40` of the version byte (`2024-01-13 quickjs.c:34551-34559`) and `-x` flipped it. | **No.** The snapshot writes native-endian (`bc_put_u16` is a plain `dbuf_put_u16`, `quickjs.c:38542`) and reads native-endian with no marker; `JS_WRITE_OBJ_BSWAP` is defined as `0` "obsolete, handled transparently" (`quickjs.h:1254`). Upstream docs say so explicitly: "When compiling for a big endian target the bundled bytecode must be regenerated. The generated bytecode is endian dependent and the currently shipped source builds have little endian bytecode" ([building.md:29-35](https://github.com/quickjs-ng/quickjs/blob/master/docs/docs/building.md)). |
| 32-bit vs 64-bit | No upstream statement either way. Code evidence: all integers are fixed-width (`u32`, `u64`, leb128); `JSValue` constants are re-tagged (`BC_TAG_INT32`, `BC_TAG_FLOAT64`, `BC_TAG_BIG_INT`…), never memcpy'd; no `sizeof(void*)`-dependent field in the writer. → **[inference]** plain function bytecode is probably pointer-size independent, but it is untested and unsupported. | Same reasoning, same caveat. One real exception: **SharedArrayBuffer** in a blob carries a literal host pointer — `quickjs.h:1268-1270`: "serialized SharedArrayBuffers carry a literal host pointer in the blob; only enable `JS_READ_OBJ_SAB` on input produced by a trusted writer in the same process". That is not portable across processes at all. |
| Build config (`CONFIG_BIGNUM`) | Removed. `Changelog` 2025-04-26: "removed the bignum extensions and qjscalc"; `CONFIG_BIGNUM` no longer appears in 2025-09-13/2026-06-04. Before that, bignum vs non-bignum builds used `BC_BASE_VERSION` 2 vs 1 → incompatible. | No `CONFIG_BIGNUM` in the tree at all. |
| Build config (`CONFIG_ATOMICS`) | Hard-coded `#define CONFIG_ATOMICS` (`quickjs.c:72`) — not a build knob any more; only affects SAB serialization, not the opcode stream. | Same: hard-coded (`quickjs.c:77`). |
| `SHORT_OPCODES` | Only affects the C dispatch table, not the on-disk opcode numbering → not a compatibility axis. | Same. |

### 4.4 Experiment: same `BC_VERSION`, incompatible bytecode (Bellard)

Both binaries built here from upstream tarballs; reader is a 20-line C program calling
`JS_ReadObject(ctx, buf, len, JS_READ_OBJ_BYTECODE)`.

```console
$ ./qjsc-2025-09-13 -c -o th25.c throw.js   # qjsc_throw_size = 194
$ ./qjsc-2026-06-04  -c -o th26.c throw.js  # qjsc_throw_size = 185
# both files start: 05 05 0a 69 6e 6e 65 72   (BC_VERSION 5)

readblob(2026) th25.bin  -> READ FAILED: SyntaxError: read after the end of the buffer
readblob(2025) th26.bin  -> READ FAILED: SyntaxError: invalid atom index (pos=95)
readblob(2026) th26.bin  -> READ OK, then EVAL FAILED: Error: boom   (script throws, as expected)
```

**Takeaway:** a version mismatch is *not* the only failure mode, and `BC_VERSION` is
*not* sufficient to detect incompatibility. When the version matches but the layout
changed, you get a generic structural error (`read after the end of the buffer`,
`invalid atom index`) that says nothing about "wrong engine version".

### 4.5 quickjs-ng mismatch messages (verified)

```console
$ qjs --std -e "bjson.read(bytes_of_v0_16_2_blob, 0, len, 1)"
SyntaxError: invalid version (27 expected=28)

$ qjs --std -e "bjson.read(bytes_with_one_flipped_byte, 0, len, 1)"
SyntaxError: checksum error
```

### 4.6 Detecting mismatch other than the error message

There is **no public API to query `BC_VERSION`**: it is a private `#define` in
`quickjs.c`, and `JS_GetVersion()` returns the human version string (`0.16.2`), which
— as Finding 0 shows — can disagree with the bytecode version. What you can do:

1. **Peek the blob.** Byte 0 is `BC_VERSION` (both engines). A host can hard-code the
   expected value and `assert!(blob[0] == EXPECTED_BC_VERSION)` before calling
   `JS_ReadObject`; quickjs-ng blobs additionally carry a 4-byte checksum at offset 1
   that the host can recompute with the same algorithm (`bc_csum`) to catch truncation
   and corruption without the engine's help.
2. **Fail fast with a probe.** At build time, compile a one-line probe with `qjsc` and
   embed it; at startup `JS_ReadObject` the probe and treat failure as "engine/bytecode
   skew" before touching the real payload. That converts a late `read after the end of
   the buffer` into a clear startup error.
3. **Put your own envelope around it.** LLRT does exactly this: magic `"lrt01"`, a
   `c`/`u` flag, optional u32 LE uncompressed size, then (optionally zstd-compressed)
   QuickJS bytecode (`llrt_core/src/bytecode.rs`). Note their magic encodes *LLRT's*
   container version, **not** `BC_VERSION` — so it does not solve engine skew, it only
   makes the container self-describing. A host that wants real safety must add the
   engine identity itself (e.g. the crate version + a hash of `quickjs.c` + the
   `BC_VERSION` constant extracted at build time).
4. **Strongest practical answer:** don't ship bytecode that can outlive its engine.
   Generate bytecode from the exact vendored tree at build time (or on first run into a
   cache keyed by engine build id + `BC_VERSION`) and treat any cross-version blob as
   invalid.

---

## 5. Bytecode vs source: size and startup cost

### 5.1 Published claims

I could not find any official *numeric* benchmark of qjsc bytecode in Bellard's docs or
quickjs-ng's docs/README. What exists is qualitative:

* Bellard `doc/quickjs.texi:852-856`: "The advantage is that no compilation is needed so
  it is faster and smaller because the compiler can be removed from the executable if
  no `eval` is required."
* quickjs-ng `docs/docs/developer-guide/intro.md:56-60`: identical wording.
* quickjs-ng maintainer (saghul), [discussion #1140](https://github.com/quickjs-ng/quickjs/discussions/1140):
  "For my JS engine I don't quite have 3k files but a good amount, and I bundle them with
  esbuild and pre compile them. Works well!" — practice, no numbers.
* [LLRT #110](https://github.com/awslabs/llrt/issues/110) has Hermes-vs-qjs numbers for
  *source* execution only (e.g. `./qjs v8-crypto.js` 717 ms vs `./hermes` 586 ms), not
  bytecode.

### 5.2 Measured here (quickjs-ng snapshot, macOS arm64, fresh CLI process)

Sizes (bytecode emitted with `qjsc -b`; this engine's `BC_VERSION 28`):

| Input | Source bytes | bytecode (source kept) | `-s` (source stripped) | `-ss` (+debug stripped) |
| --- | --- | --- | --- | --- |
| `hello.js` (one `console.log`) | 21 | 93 | 93 | 85 |
| `classic.js` (200 trivial functions) | 7,402 | 18,779 (2.5×) | 11,599 (1.57×) | 9,510 (1.28×) |
| repo `js/bootstrap.js` (24.7 KB classic script) | 24,723 | 54,787 (2.2×) | **14,048 (0.57×)** | 11,936 (0.48×) |
| quickjs-ng `repl.js` | 62,853 | 164,335 (2.6×) | **29,551 (0.47×)** | 24,215 (0.39×) |

Two things follow. (a) Keeping source in bytecode is a *loss* for any minified bundle —
the blob is ~2.2-2.6× the source. (b) With source stripped, bytecode is ~0.4-0.6× the
minified source, i.e. the size win only exists if you already minify/bundle. The C array
form costs ~6.1× the blob (`0x%02x,` text: 54,787 B → 336,470 B of C for
`bootstrap.js`; `-ss` → 74,007 B).

Startup, 263,606-byte script with 4,000 functions, 25 runs, min/median:

| Path | min | median |
| --- | --- | --- |
| `qjs heavy.js` (parse + compile + run) | 40.20 ms | 41.71 ms |
| standalone bytecode executable (`qjs -c heavy.js -o app --exe qjs`) | **4.38 ms** | 5.09 ms |
| `qjs -q` (interpreter floor, no script) | 2.46 ms | 2.97 ms |

So compile ≈ 36 ms, bytecode load ≈ 1.9 ms → ~11× cheaper for the compile phase,
~9× end-to-end for this file. For small scripts the win is a fraction of process
startup and is not worth chasing. (Single machine, warm page cache; treat as
order-of-magnitude, not a benchmark.)

### 5.3 What stripping costs

Stack traces (`throw.js` throwing inside nested functions), quickjs-ng:

```text
keep source : at inner (throw.js:2:24) / at outer (throw.js:4:20) / at <anonymous> (throw.js:5:1)
-s          : at inner (throw.js:2:24) / ...            <- identical! line/col come from debug info
-ss         : at inner (<null>:0:1) / at outer (<null>:0:1) / at <anonymous> (<null>:0:1)
```

Bellard:

```text
default (JS_STRIP_SOURCE) and --keep-source : at inner (throw.js:2:29) ... full file:line:col
-s (JS_STRIP_DEBUG)                          : at inner / at outer / at <eval>   <- no file, no line
```

So `JS_WRITE_OBJ_STRIP_SOURCE` alone does **not** hurt stack traces; losing *debug* info
does. Bellard's `-s` is the destructive one; quickjs-ng requires `-ss` for the same
effect. C-file sizes for the same script: Bellard 1,295 (default) / 982 (`-s`) / 1,840
(`--keep-source`); quickjs-ng 2,521 (keep) / 1,976 (`-s`) / 1,792 (`-ss`).

Source text also powers `Function.prototype.toString()` (verified):

```text
keep source : function inner(x) { return x + 1; }
-s / -ss    : function inner() {\n    [native code]\n}
```

And a standalone built with `qjs -c` (which forces `JS_WRITE_OBJ_STRIP_SOURCE`,
`standalone.js`) loses the *filename* too, because it evaluates through
`std.evalScript`: `at inner (<evalScript>:2:24)`. For a Node-compatible runtime that
means: keep debug info, and pass a stable script name (`qjsc -n`) if you go through
bytecode.

---

## 6. Does quickjs-ng do more than Bellard's qjsc?

Yes, three things:

1. **Raw bytecode output**: `qjsc -b` (Bellard refuses by design, see §4.2).
2. **`qjs -c/--compile` → standalone executables** ([cli.md:58-72](https://github.com/quickjs-ng/quickjs/blob/master/docs/docs/cli.md#L58)):
   ```console
   $ qjs -c app.js -o app --exe qjs
   ```
   This is *not* a C compile. At run time `standalone.js` compiles the file with
   `std.evalScript(js, {compile_only: true, compile_module: true})`, serializes with
   `bjson.write(code, WRITE_OBJ_BYTECODE | WRITE_OBJ_REFERENCE | WRITE_OBJ_STRIP_SOURCE)`,
   appends it to a **copy of the qjs binary**, then appends a 12-byte trailer:
   `"quickjs2"` + u32 LE bytecode length (`qjs.c:56-80`, `standalone.js`). At startup
   `qjs` detects the trailer (`is_standalone()`), reads the blob and evaluates it.
   Verified: `heavy_bc` = qjs (1,177,584) + bytecode (321,590) + 12; trailer bytes
   `71 75 69 63 6b 6a 73 32 | 36 e8 04 00`.
   Consequences: the executable is per-arch and per-engine (it *is* that qjs build), the
   trailer length is little-endian, and modules are not resolved (docs: "No JavaScript
   bundling is performed, the specified JS file cannot depend on other files").
3. **CMake install of `qjsc`** (`CMakeLists.txt:562`) plus `make codegen`
   (`Makefile:76-80`) which regenerates the checked-in `gen/*.c` via
   `qjsc -ss -o gen/repl.c -m repl.js` etc.

**Cross-compilation of bytecode:** effectively no.

* Bellard *had* real cross-compilation (`-x` flipping the 0x40 endian bit) up to the
  2024 format; in 2026-06-04 the writer is canonical LE and `-x` is a no-op, so the
  output is endian-neutral but there is nothing to cross-compile *for* any more —
  **[inference]** the same blob should load on LE and BE hosts.
* quickjs-ng: no `-x`, native-endian blobs, and the docs tell you to regenerate for BE
  targets. `qjs -c --exe other-platform-qjs` can *wrap* another platform's binary (the
  docs suggest it), but the bytecode is produced by the host qjs, so host and target
  must agree on `BC_VERSION` and endianness. For a BE target that is not the case.
  **[inference]** For 32-bit ARM/x86 targets from a 64-bit host the blob is probably
  fine (see §4.3), but nobody upstream guarantees it and nobody tests it.

---

## 7. Prior art: who embeds QuickJS bytecode, and how they keep it in sync

| Project | Bytecode at build time? | Sync mechanism | Evidence |
| --- | --- | --- | --- |
| **quickjs-ng itself** | Yes for its own JS: `gen/repl.c`, `gen/standalone.c`, `gen/hello.c` are checked-in C arrays generated by `qjsc`; `make codegen` regenerates them manually. Runtime bytecode round-trip is covered by `api-test.c` `module_serde()` (`JS_WriteObject` → `JS_ReadObject` → `JS_EvalFunction`) and `tests/test_bjson.js`. | Generated files live in the same commit as the engine; regeneration is a manual `make codegen`. No version stamp. | `Makefile:76-80`, `CMakeLists.txt:366-380`, `api-test.c:391-420` |
| **`qjs --std`** | No — it is the stdlib surface (`std`, `os`, `bjson`), not a compilation mode. `bjson.write/read` expose `JS_WriteObject`/`JS_ReadObject` with the flags (`READ_OBJ_BYTECODE`, `WRITE_OBJ_STRIP_*`). | n/a | `qjs.c:646-654`, `docs/docs/stdlib.md:37-60` |
| **Javy** (Shopify → Bytecode Alliance) | Yes, at `javy build` time. `javy-codegen` instantiates the **plugin wasm** (QuickJS compiled to wasm) with wasmtime, copies the JS source into its memory, calls its `compile-src` export and copies the resulting **QuickJS bytecode** back out (`crates/codegen/src/bytecode.rs`). The same bytecode is embedded in the output Wasm module. | Synced by construction: the compiler *is* the runtime plugin build that ships (wasm32-wasip1/wasip2). No version stamp needed. | [javy repo](https://github.com/bytecodealliance/javy), `crates/codegen/src/bytecode.rs`, `docs-contributing-architecture.md` |
| **AWS LLRT** | Yes: `llrt compile file.js` → `rquickjs` `Module::declare` + `module.write(WriteOptions::default())`, zstd-compressed with a dictionary, wrapped in `"lrt01"` + `c`/`u` + optional u32 LE size; can also produce a self-contained executable (marker `lrtx`). | Same engine: `compiler_common.rs` is "Shared with build.rs and compiler.rs", so build-time and run-time bytecode come from the same rquickjs/quickjs-ng build. Container magic versions LLRT's envelope, not `BC_VERSION`. | [llrt repo](https://github.com/awslabs/llrt), `llrt_core/src/compiler.rs`, `llrt_core/src/bytecode.rs`, `tests/unit/compile.test.ts` |
| **txiki.js** | Yes, two ways: its own JS runtime bundles are checked-in C arrays under `src/bundles/c/**` built with its patched compiler target `tjsc` (`CMakeLists.txt:237-239`, from `src/qjsc.c`); and `tjs compile bundle.js` produces a standalone executable at tool time (`tjs app compile` for `.tpk` packages). | Bundles are generated in-tree by `tjsc`; `tjs compile` uses the running binary's own engine. | [txiki.js](https://github.com/saghul/txiki.js), [CLI docs](https://txikijs.org/docs/cli/#tjs-compile), `README.md:34`, `tests/test-compile.js` |
| **quickjs-emscripten** | No build-time pipeline exposed. Maintainer on [issue #193](https://github.com/justjake/quickjs-emscripten/issues/193): "We already have a few routines that can load and store 'bjson' values, which calls down to `JS_ReadObject` and `JS_WriteObject` … but they aren't setting the flag that allows storing executable code." | Version sync is package-level: one npm variant = one wasm build; bytecode is not a supported artifact. | issue #193; [repo](https://github.com/justjake/quickjs-emscripten) |
| **rquickjs (this repo's binding)** | Partially: `Module::write(WriteOptions)` and `unsafe Module::load()` (`src/value/module.rs:469`, `:338-345`), and a `loader::Compile` wrapper that collects bytecode *in memory* while loading (`src/loader/compile.rs:203-215`). `WriteOptions` even exposes `Endianness::{Native,Little,Big,Swap}` — note `Swap`/`Big` are meaningless against quickjs-ng, whose `JS_WRITE_OBJ_BSWAP` is `0`. | None. Bytecode produced by `Compile` is not persisted and carries no engine id. | `rquickjs-core-0.14.0` sources |

Pattern across all of them: **whoever ships bytecode generates it with the exact engine
build that consumes it** (Javy: the plugin wasm; LLRT: shared `compiler_common`; txiki:
`tjsc` in-tree; quickjs-ng: `make codegen` in-tree). Nobody relies on a version string,
and nobody ships a blob produced by a different build. LLRT is the only one with a
container header, and even that header does not record `BC_VERSION`.

---

## 8. Implications for lite-node (opinion, not verified fact)

1. There is no `qjsc` in the dependency graph; a build step would have to compile
   `qjsc.c` against the vendored `quickjs/` tree (same flags, same snapshot, including
   rquickjs's patches — if rquickjs ever patches the serializer, an upstream `qjsc`
   would produce blobs the patched runtime may not read). Pin the engine by the
   *crate* version, not by "0.16.2".
2. Your engine reports 0.16.2 but speaks `BC_VERSION 28`. Any check based on
   `JS_GetVersion()` is wrong here. Use byte 0 of the blob or a build-time constant.
3. `-s` (strip source, keep debug) is the only strip level that preserves
   `file:line:col` in stack traces while roughly halving a minified bundle. `-ss` is
   not acceptable for a Node-compatible runtime (traces become `<null>:0:1`), and
   `qjs -c`-style standalone loses the filename (`<evalScript>`) as well.
4. Bytecode is a *startup* optimisation for large bundles, not a size optimisation:
   for small scripts it is bigger than source, and C arrays are ~6× the blob. Embed as
   binary (`include_bytes!`) rather than generated C unless you need `no_std`.
5. Keep a self-describing envelope (magic + `BC_VERSION` + engine build id + length)
   even though quickjs-ng has a checksum: the checksum catches corruption, not
   wrong-engine, and the Bellard experiment shows a wrong-engine blob can surface as
   "read after the end of the buffer" rather than "version mismatch".

---

## 9. Reproduction

```bash
# Bellard
curl -O https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz && tar xf ...
make -j8 qjsc qjs libquickjs.a
./qjsc -v hello.js            # prints and runs the cc line
./qjsc -c -o out.c hello.js   # C array, no main
./qjsc -e -o out.c hello.js   # C array + main
./qjsc --keep-source -c -o ks.c hello.js ; ./qjsc -s -c -o s.c hello.js

# quickjs-ng (any tag, or the rquickjs-sys vendored tree)
cmake -B build -DCMAKE_BUILD_TYPE=Release -DQJS_BUILD_LIBC=ON . && cmake --build build -j8
build/qjsc hello.js                 # out.c, no main
build/qjsc -e -o hello.c hello.js   # + main
build/qjsc -b -ss -o hello.bin hello.js
cc -O2 -I. -o hello hello.c -Lbuild -lqjs -lm -lpthread   # libqjs.a built with -DQJS_BUILD_LIBC=ON
build/qjs -c hello.js -o hello --exe build/qjs   # standalone w/ 12-byte trailer
```

No files outside `/tmp` and this document were modified. `/tmp` artifacts:
`bellard/`, `b-2025-09-13/`, `b-2024-01-13/`, `b-2021-03-27/`, `ng162/`, `ng170/`,
`ngbuild/`, `ng162b/`, `ng170b/`, `exp/` (generated C, blobs, `readblob*.c`).
