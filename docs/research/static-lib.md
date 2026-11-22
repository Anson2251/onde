# Shipping onde as a static library and as a bytecode-linked executable

> **Design status (2026-11-20):** the linking path described here is the one being adopted; the
> driver around it is a JavaScript tool. See [`../standalone-build.md`](../standalone-build.md) for
> the current design (sections 3–6).

Research note for turning this workspace (`tokio` + `rustls`/`ring` + vendored quickjs-ng) into
(a) `libonde.a` that a C/C++/Rust program links, and (b) a single executable built by compiling a
generated C file that carries a QuickJS bytecode blob.

Everything below was measured on this machine unless marked **[inferred]**. The experiment log in
§9 gives the exact commands; the scratch tree is `target/scratch/` (repo sources untouched).

Environment: macOS 27.2.1, arm64, rustc 1.100.0, clang 23.1.2, `x86_64-unknown-linux-gnu` std
installed but no Linux C toolchain.

---

## 0. TL;DR

- `crate-type = ["staticlib"]` produces one `libonde.a` that already contains **all** Rust crates,
  `std`, and the C objects built by `cc` (quickjs's four `.o` files are in there). It does **not**
  contain libc/crt/frameworks, and rustc tells you exactly what is missing:
  `--print native-static-libs`.
- On this dep set the printed list is tiny — **macOS: `-liconv -lSystem -lc -lm`**, **Linux:
  `-lgcc_s -lutil -lrt -lpthread -lm -ldl -lc`** — because `getrandom` 0.2 uses `getentropy(2)` on
  Apple instead of `Security.framework`, and `ring` builds its C/asm into a *static* archive.
  No `Security`, `CoreFoundation` or `SystemConfiguration` is needed unless you add
  `security-framework` / `core-foundation` crates.
- Entry point: `#[no_mangle] pub extern "C" fn onde_main(argc, argv) -> c_int` works, and the
  library *can* even supply `main` itself (crt1.o's undefined `_main` pulls the archive member in).
  With the repo's `panic = "abort"` a `catch_unwind` is a no-op (process aborts) — that is the
  correct, boring behaviour for a C host; keep `panic = "abort"`.
- The real hazards are (1) never link two Rust staticlibs together (`-force_load` on two of them
  produced **2,283 duplicate symbols**), (2) whole-archive is only needed if symbols are
  unreferenced, and (3) the bytecode blob is version- and *atom-table*-locked: with `BC_VERSION`
  unchanged but the builtin atom table shifted by one entry, `a.push(7)` bytecode failed at run
  time. Same binary, same flags, or nothing.
- Sizes: unstripped archive 32.5 MB (no LTO) → 7.8–12.2 MB (`lto="fat"`, `opt-level="z"`,
  `panic="abort"`, `codegen-units=1`); an `onde_main` executable came out **4.45 MB →
  2.89 MB stripped → 2.87 MB with `-dead_strip` + `strip`** (eval-only driver, see §5), versus the
  repo's 5.32 MB `lite` binary (4.62 MB stripped).
- For the payload, `-Wl,-sectcreate` (macOS), `.incbin`/`ld -r -b binary` (ELF), C23 `#embed`, or a
  Rust `include_bytes!` static all beat a generated `unsigned char blob[] = {...}` by 10x at
  compile time: 10 MB blob = 3.7 s and 61 MB of C source with `xxd -i`, 0.20 s with `#embed`.

---

## 1. What `crate-type = ["staticlib"]` actually emits

### Output name and contents

| platform | file | notes |
|---|---|---|
| macOS / Linux / MinGW | `libonde.a` (`lib<lib.name>.a`) | plain `ar` archive |
| MSVC | `onde.lib` | COFF archive |

*Verified* (`target/scratch/onde-staticlib`, `[lib] name = "onde"`, depends on `ln-runtime`):

```
libonde.a  32,498,352 bytes  627 members   (default release profile: no LTO, panic=unwind)
```

Those 627 entries are 626 object files plus the `__.SYMDEF` index: **459 `*.rcgu.o`** (one per
codegen unit of every crate, including `std`, `core`, `alloc`, `compiler_builtins`), **4 quickjs
objects**, **20 aarch64 `lse_cas*` atomics objects**, and **143 other asm/`compiler_builtins`
objects**:

```
574d5a55758aae73-quickjs.o      574d5a55758aae73-libregexp.o
574d5a55758aae73-libunicode.o   574d5a55758aae73-dtoa.o
14bbc1edf8d2bd56-lse_cas{1,2,4,8,16}_*.o   (20 objects)
```

Those four `-quickjs/-libregexp/-libunicode/-dtoa` objects are exactly `rquickjs-sys`'s
`source_files` compiled by `cc` into `libquickjs.a` (`~/.cargo/registry/src/.../rquickjs-sys-0.14.0/build.rs`).
**So yes: C dependencies compiled by a `cc` build script are bundled**, because rustc's default for
native static libs is `+bundle` — "the native static library will be packed into the rlib or
staticlib archive, and then retrieved from there during linking of the final binary"
([rustc book, linking modifiers](https://doc.rust-lang.org/rustc/command-line-arguments.html#linking-modifiers-bundle)).
Setting `-l static:-bundle=quickjs` is the escape hatch that leaves it out.

`nm -g libonde.a | grep _JS_NewRuntime` → `T _JS_NewRuntime`, `T _JS_ReadObject`: the engine is
really in the archive, callable from C if you include `quickjs.h`.

### What it does *not* bundle

- libc, `crt1.o`, `libSystem`, `libgcc_s`, `libm`, `libdl`, `libpthread`, `iconv`, Windows import
  libs — anything the platform linker supplies.
- Native **dynamic** dependencies: "it is impossible to link in native dynamic dependencies to a
  static library, and in this case warnings will be printed" ([Rust Reference, linkage](https://doc.rust-lang.org/reference/linkage.html)).
- Anything linked with `-bundle` (see above), and anything a `-sys` crate expects to find at
  runtime (`Security.framework`, `libssl.so`, …).
- Any rlib *metadata*: "the compiler will never attempt to link to `staticlib` outputs"
  ([Rust Reference](https://doc.rust-lang.org/reference/linkage.html)) — a Rust consumer links it
  as a foreign library, not as a crate.

### Discovering the system libraries

```bash
cargo rustc -p <crate> --release --crate-type staticlib -- --print native-static-libs
# or, for a package that already declares staticlib:
cargo rustc -p onde --release -- --print native-static-libs
```

`--print native-static-libs` "may be used when creating a `staticlib` crate type … include[s] a
diagnostic note that indicates the linker flags", starting with `native-static-libs:`
([rustc book, print options](https://doc.rust-lang.org/rustc/command-line-arguments/print-options.html#native-static-libs)).
It is a **note on stderr**, not stdout ([rust-lang/rust#125304](https://github.com/rust-lang/rust/issues/125304)) —
relevant if you script it.

*Verified output, macOS arm64, this dependency tree:*

```
note: native-static-libs: -liconv -lSystem -lc -lm
```

*Verified output, `x86_64-unknown-linux-gnu`, pure-Rust subset cross-built from macOS:*

```
note: native-static-libs: -lgcc_s -lutil -lrt -lpthread -lm -ldl -lc
```

That is the whole story on both platforms for this tree: no `Security`, no `CoreFoundation`, no
`SystemConfiguration`. Two reasons, both checked in the vendored sources:

- `getrandom` 0.2.17 on `*-apple-darwin` uses `getentropy(2)` from libSystem; the crate explicitly
  documents preferring libSystem over `Security.framework` ("This makes it a more lightweight
  choice compared to `Security.framework`", `getrandom-0.2.17/src/apple-other.rs`).
- `ring` 0.17.14's `build.rs` emits only `cargo:rustc-link-lib=static=<ring_core_…>` — its C and
  perlasm output are bundled, no framework and no extra `-l`.

You would only add `-framework Security -framework CoreFoundation` by pulling in
`security-framework`/`core-foundation` (i.e. `rustls-native-certs`, `rustls-platform-verifier`, or
a proxy-detection crate such as `system-configuration`). `ln-io` deliberately uses `webpki-roots`,
so today's answer stays framework-free; the day `ONDE_USE_SYSTEM_CA` grows a `security-framework`
dependency, `--print native-static-libs` starts printing frameworks and the note must be repeated
in the docs.

**[inferred]** The Linux list is identical for the full tree (with `ring`/`rustls`): those crates
add no `-l` flags, only bundled static archives, and `getrandom` on Linux uses the `getrandom(2)`
syscall. I could not compile the full tree for Linux here because quickjs needs a target C
compiler (§4).

### Recommended link line

macOS:

```bash
clang++ -std=c++17 app.cpp libonde.a -o app          # driver supplies -lSystem -lc -lm
# explicit form if you drive ld directly:
clang++ app.cpp libonde.a -liconv -lSystem -lc -lm -o app
```

Linux:

```bash
cc app.c libonde.a -lgcc_s -lutil -lrt -lpthread -lm -ldl -lc -o app
# and, if the archive is pulled in wholesale: -Wl,--gc-sections
```

`pkg-config`-style: ship a `onde.pc` with `Libs: ${libdir}/libonde.a -lpthread -ldl -lm` so
consumers do not have to read this document.

---

## 2. Entry point design

### The shape that works

```rust
// crates/ln-staticlib/src/lib.rs  (proposed)
use std::os::raw::{c_char, c_int};

#[no_mangle]
pub extern "C" fn onde_main(argc: c_int, argv: *const *const c_char) -> c_int { /* ... */ }
```

*Verified end to end*: a C `main` calling `onde_main` that builds `ln_runtime::Config::new(argv)` +
`Isolate::new(..)` + `isolate.run("console.log(...)", "[embed]")` prints
`hello from onde inside a C host: 2` and returns 0. So the existing
`Config`/`Isolate`/`RunOutcome::exit_code` API is already the right internal seam; `ln-cli`'s
`real_main()` is the only thing that needs splitting into a library-shaped function.

- `#[no_mangle] pub extern "C"` is required, and `extern "C"` is also the **safety** mechanism:
  "Rust functions that are expected to be called from foreign code … should be defined using
  `extern "C"`, which ensures that if the Rust code panics, it is automatically caught and the
  process is aborted" ([`std::panic::catch_unwind`](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html)).
- **C++ needs `extern "C"` on the declaration**, or the mangled names do not match. *Verified*:
  `clang++` without it produced `"onde_version()", referenced from: _main … declaration possibly
  missing 'extern "C'"`; with `extern "C" { … }` it linked and ran. Ship a header with
  `#ifdef __cplusplus extern "C" { #endif`.
- `argc`/`argv` translation is mechanical, but decide the `argv[0]` convention: Node/`lite` expose
  `process.argv[0]` as the executable and `argv[1]` as the script. For an embedded host there is no
  script path — the natural mapping is `argv[0] = program name`, `argv[1..]` = user args, and
  `process.argv[1]` pointing at `process.execPath`-equivalent. Worth an ADR; `__filename` for the
  embedded module has the same question Node SEA answers with `process.execPath`.

### `catch_unwind` vs `panic = "abort"`

The repo already sets `panic = "abort"` in `[profile.release]` (`Cargo.toml`). *Verified* both ways
with a `#[no_mangle] extern "C"` symbol that panics inside `catch_unwind`:

| build | `catch_unwind(|| panic!())` | panic escaping `extern "C"` |
|---|---|---|
| `panic = "abort"` | **process aborts**, exit 134 | aborts, exit 134 |
| `panic = "unwind"` (default) | catches, returns `Err`, process continues | aborts: `panic in a function that cannot unwind … thread caused non-unwinding panic. aborting.` |

So under `panic = "abort"` a `catch_unwind` is dead code, and that is fine: `catch_unwind` "only
catches unwinding panics, not those that abort the process"
([docs](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html)). Aborting on a runtime bug is the
right contract for a C host — unwinding through C frames is undefined and would corrupt the host.

Keep `panic = "abort"` for the staticlib, and make the **`extern "C"` boundary total**: convert
every `Failure` into a status code inside `onde_main`, never let a `Result` escape. The
`ffi_unwind_calls` lint is the belt-and-braces check
([Rust Reference](https://doc.rust-lang.org/reference/linkage.html)).

If you ever want in-process recovery (a plugin host that must survive a bad script), then
`panic = "unwind"` everywhere **and** every entry point wrapped in `catch_unwind` + a
`std::panic::set_hook` that routes the message through onde's own error reporter instead of the
default stderr dump. Do not mix strategies: "If a Rust artifact is potentially unwinding, then all
its crates must be built with the `unwind` panic strategy. Otherwise, unwinding can cause undefined
behavior", and if you are not linking with rustc "you must take care to ensure that unwinding is
handled consistently" ([Rust Reference](https://doc.rust-lang.org/reference/linkage.html)).

### `std::process::exit` and destructors

- The repo already exits explicitly: `process::exit(real_main())` (`crates/ln-cli/src/main.rs:79`).
  That is the right shape for `onde_main` too — Node semantics say the process ends when the loop
  drains.
- **`std::process::exit` runs `atexit`/libc handlers but skips Rust destructors on the stack.**
  *Verified*: a `Drop` impl printing on drop never printed; exit code was 3 as requested. In the
  staticlib this matters more than in `lite`, because the host may have registered `atexit`
  handlers, open `FILE*`s and its own thread-local state; `exit()` from inside the library will run
  *its* handlers and may surprise the host.
- Better contract for an embedder: `onde_main` returns the exit code and lets the host decide, and
  `onde_main` performs an explicit, ordered shutdown (drop the `Isolate`, join the tokio runtime,
  flush stdio) before returning. Node's SEA has the same split: the embedded script does not own
  process exit. Note that `ln-io` builds a multi-threaded tokio runtime
  (`crates/ln-io/src/lib.rs:440`), whose worker threads are *not* joined by `process::exit`.
- Don't use `std::process::abort`/`exit` inside library code paths that a host may want to survive
  (e.g. from `process.exit()` called by the script) — return a status and let `onde_main` decide.

### `setlocale`, signals, and other process-wide state

- **No `setlocale` anywhere in the repo** (grep: no hits). Consequences: (a) a C host that calls
  `setlocale(LC_ALL, "")` before `onde_main` changes `strtod`/`printf`/`isalpha` behaviour under the
  library's feet; QuickJS has its own `dtoa` and does not consult the locale, so JS-visible
  behaviour should be stable **[inferred from the absence of locale calls + quickjs's own dtoa]**, but
  any C-side formatting the host does will shift. (b) If you want Node-like determinism, call
  `setlocale(LC_ALL, "C")` (or `"C.UTF-8"`) once inside `onde_main` — and document that you did,
  because it is process-global. `libc::setlocale` is already a dependency (`libc` is in the tree).
- **Signal handlers are process-global.** `crates/ln-io/src/signal.rs` installs handlers with
  `libc::signal(...)` for `process.on('SIGINT')`-style listeners and restores `SIG_DFL`
  (`signal.rs:124,223,244`). In `lite` that is fine; in an embedded app it can silently replace the
  host's handler (e.g. a GUI toolkit's SIGINT/SIGTERM handling, or a debugger's). Recommendation:
  make signal installation opt-in via `Config` (`signals: false` by default when `ONDE_EMBEDDED=1`
  or when `onde_main` is called with a flag), and never install a handler for `SIGPIPE` behind the
  host's back.
- `SIGSEGV`/`SIGBUS` guards, `atexit`, `umask`, `chdir`, `setrlimit`, `prctl`, and the tokio
  runtime's threads are the same category: process-wide. A library that changes them needs the
  host's consent.

### Can the library provide `main`?

**Yes.** *Verified*: a staticlib exporting `#[no_mangle] pub extern "C" fn main(argc: c_int, argv:
*const *const c_char) -> c_int` links and runs from a C object that has no `main` of its own —
`ld` resolves `_main` from `crt1.o`'s undefined reference, which pulls the archive member, which
prints and returns 7 (`argv` arrives correctly: `["./tm", "a", "b"]`).

Caveats:
- It only works when *nothing else* defines `main`, and only when the archive is searched after
  `crt1.o` (normal). With `-Wl,--whole-archive` you get a duplicate `main` if the host has one.
- `main` from Rust gets no `argc`/`argv` mangling guarantees beyond the C ABI, and on Windows
  `main` vs `wmain` vs `WinMain` differ (`#[no_mangle] fn wmain` needs `-municode`).
- `#[no_mangle] extern "C" fn main` is only usable in a staticlib/cdylib build; if the same crate
  is ever built as a `bin`, rustc rejects two `main`s.
- *Recommendation*: export `onde_main` and let the host own `main`. Generating one is a one-liner
  anyway (§7), and a host that cannot define `main` is rare.

---

## 3. Symbols, duplicates, whole-archive, visibility, debug info

### Duplicate symbols: the real constraint

The Rust Reference is explicit: the staticlib "contains the code of all the dependencies, including
the standard library, and also exports all public symbols of them", and "Multiple Rust `staticlib`
files are likely to conflict" ([linkage](https://doc.rust-lang.org/reference/linkage.html)).

*Verified*: linking a program against two Rust staticlibs (`libonde.a` + a trivial `libother.a`)
succeeds lazily — only referenced members are pulled — but `-Wl,-force_load` on both produced
**2,283 duplicate symbols** (mangled `std`, `alloc`, `compiler_builtins` symbols with identical
hashes, since both were built by the same rustc). So:

- Linking `libonde.a` into an app that also links *another* copy of std/tokio/quickjs is safe only
  as long as the duplicate members are never both pulled in. With identical symbol names, one copy
  wins per symbol, but which one is arbitrary and per-symbol — you can end up with
  `std::io::stdout`'s statics from one copy and the allocator hooks from another. That is
  unsupported behaviour, not a supported merge.
- A **Rust host** linking `libonde.a` is the same hazard: the host's own `std` and the archive's
  `std` have the same mangled names. It "works" in the lazy case (my `onde_main` test was driven
  from C; a Rust host would resolve `std` symbols to whichever object the linker saw first). Treat
  it as unsupported; if a Rust host must embed onde, depend on `ln-runtime` as a crate, not on the
  `.a`.
- Two different quickjs copies in one process is worse than a link error: two `JSRuntime`s with
  different global class IDs / atoms in the same address space, plus `JS_NewRuntime` twice. If the
  host already embeds quickjs, do not link onde's copy — build onde against the host's quickjs with
  an rquickjs-sys patch, or run onde out of process.

### Whole-archive: when you need it and what it costs

macOS `ld` only pulls archive members "if needed to resolve some symbol reference" and searches the
archive repeatedly ([ld(1)](https://keith.github.io/xcode-man-pages/ld.1.html)). Consequences:

- An entry point that is *only* reachable from C is referenced by the host, so it is pulled: no
  flag needed.
- Anything reachable only via registration/`#[used]`/linker-section tricks needs
  `-Wl,--whole-archive libonde.a -Wl,--no-whole-archive` (ELF) or `-Wl,-force_load,libonde.a`
  (macOS). rustc spells these `-l static:+whole-archive=…`, which "translates to `--whole-archive`
  for `ld`-like linkers, to `/WHOLEARCHIVE` for `link.exe`, and to `-force_load` for `ld64`"
  ([rustc book](https://doc.rust-lang.org/rustc/command-line-arguments.html#linking-modifiers-whole-archive)).
- Cost: *verified* — force-loading the 7.8 MB LTO archive took the tiny test program from 1.47 MB
  to 1.69 MB without `-dead_strip`; with `-dead_strip` the unreachable code goes away again
  (334 KB). So `--whole-archive` is only acceptable together with `--gc-sections`/`-dead_strip`.
- `.a` self-registration is the anti-pattern to avoid: prefer one explicit `onde_main` plus
  explicit `onde_register_*` calls.

### Visibility

A static archive has no notion of visibility — every global symbol is fair game, and `-fvisibility`
on the C side does not apply to Rust objects. Options:

- **Final link**: `-Wl,-exported_symbols_list,onde.exp` (macOS) or a version script /
  `-Wl,--dynamic-list` (ELF) — these restrict the *output* binary's exports, which matters when the
  output is a dylib/`.so` with plugins; entry binaries do not export by default anyway.
- **Treat the archive's symbols as hidden**: macOS `ld -hidden-l` / `-load_hidden` "treats all
  global symbols from the static library as if they are visibility hidden"
  ([ld(1)](https://keith.github.io/xcode-man-pages/ld.1.html)) — useful when `libonde.a` ends up
  inside *your* dylib. ELF equivalents: `-Wl,--exclude-libs,ALL`.
- **Build-time**: `-C default-hidden-visibility` does not exist; `#[link_section]`/`pub(crate)` do
  not change symbol binding. If symbol bloat matters, the lever is `-C lto=fat` +
  `--gc-sections`/`-dead_strip`, not visibility.
- `strip -x` keeps global symbols and drops locals (4.79 MB vs 4.62 MB for full `strip` on `lite`),
  useful when you want crash-symbolication names but no local noise.

### Debug info, LTO, panic=abort interactions

- The repo's release profile has no `debug` setting, so `debug = 0` (no DWARF). *Verified* on
  `target/release/lite`: `otool -l | grep __DWARF` → 0. The 5.3 MB is text + a full symbol table;
  `strip` removes 696 KB of it (→ 4,621,248), `strip -x` 523 KB (→ 4,794,328).
- If you build the staticlib with `debug = 2` to get usable backtraces, expect the archive to grow
  several-fold and to leak absolute paths (use `--remap-path-prefix`). Better: `debug = 1`
  (line tables only) or a split `dsymutil` step for release.
- **`lto = "fat"` with `staticlib` is usable from any system linker**, but the members are not
  bitcode-free. *Verified* on the fat-LTO archive: 420 objects, of which 252 carry a
  `__LLVM,__bitcode` (+ `__LLVM,__cmdline`) section — and they *also* carry real native code
  (`__text` size `0xd20`, genuine aarch64 instructions) plus `__debug_*` sections inherited from
  the precompiled `std`/`compiler_builtins` rlibs. clang linked the archive and the resulting
  program ran (including executing JS), so no `-C linker-plugin-lto` is needed; Apple's `ld` may
  additionally re-run LTO over the embedded bitcode, which is harmless. The practically important
  part: **verify with the real consumer toolchain once** — a linker without LTO support falls back
  to the native code that is present, and that is what my link test exercised.
  (This also explains why the "no LTO" archive is 32.5 MB: precompiled `compiler_builtins` objects
  ship with debug info regardless of your `debug = 0`.)
- `panic = "abort"` + `lto = "fat"` is the size win (§5) and removes the unwinder tables; but any
  C++ code in the same process still needs its own unwinder, which libSystem/libgcc provides.
- MSVC: Rust's `x86_64-pc-windows-msvc` links the **dynamic** CRT by default; `+crt-static`
  switches to `/MT` and "code on MSVC needs to be compiled differently (e.g. with `/MT` or `/MD`)"
  ([Rust Reference](https://doc.rust-lang.org/reference/linkage.html)). A `/MD` Rust staticlib and
  a `/MT` C++ host in one binary means two CRTs, two heaps, and `free()` on a pointer from the
  other side — the classic Windows static-library bug. Pick one: `RUSTFLAGS='-C
  target-feature=+crt-static'` for a `/MT` world, and make the C host match. **[inferred]** I could
  not test MSVC on this machine; the rule is documented, the failure mode is standard Windows lore.

---

## 4. Cross-compilation reality

### Staticlib for another OS/arch: no linker needed, but `cc` is

`staticlib` output is produced by rustc itself (it writes the archive); a foreign linker is not
invoked. *Verified*: `cargo rustc --release --target x86_64-unknown-linux-gnu --crate-type
staticlib` on macOS produced a real `current ar archive` of 23.6 MB for Linux, from a pure-Rust
crate, with no Linux toolchain present, and printed the Linux `native-static-libs` list.

As soon as a `cc`-built dependency is in the tree, you need the **target C compiler**:

```
error occurred in cc-rs: failed to find tool "x86_64-linux-gnu-gcc": No such file or directory (os error 2)
```

*Verified* trying to build the full onde staticlib for `x86_64-unknown-linux-gnu` on macOS: it dies
in `rquickjs-sys`'s `cc` invocation, before any Rust linking. So cross-building onde requires a C
cross-toolchain for quickjs (and a perlasm-capable assembler for `ring`), not just a Rust target.
Ways out, in order of practicality:

1. **Build on the target** (CI matrix: `macos-latest` arm64 + `x86_64` cross, `ubuntu-latest`
   x86_64 + arm64 via `cross`/docker, `windows-latest`). This is what ships today's `lite`
   binary; keep doing it.
2. **`cargo-zigbuild`** — drives `zig cc` as the C cross-compiler and linker
   ([repo](https://github.com/rust-cross/cargo-zigbuild)), which handles quickjs's C and glibc/musl
   sysroots. Needs `zig` on the build host; the clang version zig ships must accept the flags
   `cc`/`rquickjs-sys` pass (they are vanilla: `-D_GNU_SOURCE`, warnings suppressions).
   **[inferred]** not tested here (no `zig` installed, and installing is out of scope for this
   session).
3. **Cross C toolchains** (`x86_64-linux-gnu-gcc` from Homebrew's `messense/macos-cross-toolchains`
   or `musl-cross`): set `CC_x86_64_unknown_linux_gnu`, `AR_…`, `CARGO_TARGET_…_LINKER`. Works, but
   you now own a sysroot.

### glibc static vs musl static

- `x86_64-unknown-linux-musl` is static-CRT by default ("targets … linked statically by default …
  `x86_64-unknown-linux-musl`", [Rust Reference](https://doc.rust-lang.org/reference/linkage.html)),
  so `cargo build --target x86_64-unknown-linux-musl` gives a `libonde.a` whose future consumers
  must also be musl-static, and a musl-static `lite` with no runtime deps. musl's resolver
  differences are documented: parallel nameserver queries, no NSS module loading, `search` handling
  that differs from glibc, no IDN ([musl wiki](https://wiki.musl-libc.org/functional-differences-from-glibc.html)).
- glibc **fully static** is the one to avoid: "all kinds of features in the libc (locale (through
  iconv), NSS, IDN, …) require dynamic linking to load the appropriate external code. We have very
  limited support for doing this in statically linked code" — and the NSS modules must come from
  the same glibc version
  ([Drepper, *Static Linking Considered Harmful*](https://www.akkadia.org/drepper/no_static_linking.html)).
  Practical meaning for onde: `getaddrinfo("example.com")` can fail or silently ignore
  `/etc/nsswitch.conf` in a `-static` glibc binary, and `dlopen` does not work at all — which also
  kills the `cdylib` alternative (§7) on such builds.
- For **onde's own networking**, the TLS side is fine either way: `rustls` + `ring` + `webpki-roots`
  need no OpenSSL, no `/etc/ssl/certs` scan, and no `dlopen`; `getrandom` uses `getrandom(2)` on
  Linux and `getentropy(2)` on Apple, both syscalls/libSystem and thus static-friendly.
  The DNS side is still libc's `getaddrinfo` through tokio's resolver, so musl-vs-glibc resolver
  behaviour is user-visible — worth a compat note alongside `docs/compat.md`.
- Static + `getrandom`: no caveat on these targets. It would only matter on platforms where
  `getrandom` must lazily load something (not macOS/Linux).

### Universal macOS binaries: lipo does work on `.a`

*Verified*:

```
lipo -create arm64.a x86_64.a -output fat.a
Architectures in the fat file: fat.a are: x86_64 arm64
fat.a: Mach-O universal binary with 2 architectures:
       [x86_64:current ar archive random library] [arm64:current ar archive random library]
clang -arch x86_64 m86.c fat.a -o m86   # links, picks the x86_64 slice, runs
lipo -create arm64.a arm64.a …          # lipo: same architectures (arm64) found → error
```

So: build `libonde.a` twice (`rustup target add x86_64-apple-darwin`, `cargo build --target
aarch64-apple-darwin` and `--target x86_64-apple-darwin`), then `lipo -create` the two archives.
`ld` accepts universal inputs and emits a thin output per `-arch`; the clang driver runs `ld` twice
and lipos the results ([ld(1)](https://keith.github.io/xcode-man-pages/ld.1.html)).

Limitations, all consequences of "one lipo input per architecture":
- Every slice must be built by the **same rustc** and the same crate versions, or you have two
  Rust runtimes with different hashes and no duplicate-symbol safety net.
- `lipo` refuses duplicate architectures and cannot merge two *fat* archives with overlapping
  slices; extract first (`lipo -thin`).
- The archive's per-slice member names are identical, so `-force_load` + `-dead_strip` behaves the
  same on both slices; symbol-level diffing between slices needs `lipo -thin` first.
- Apple silicon consumers of an x86_64-only slice still work under Rosetta, but a universal binary
  doubles the on-disk `.a`; ship thin per-arch archives and lipo at the *app* link step if size
  matters.
- Do not lipo `.a` built with different `-C target-cpu` or different `panic` strategies.

### Windows/MSVC

- Output is `onde.lib`; the host links it like any other static lib. Naming/ABI: `extern "C"`,
  `__cdecl`, and `#[no_mangle]` gives `onde_main` without the leading underscore at x64.
- CRT consistency is the whole game (`/MT` vs `/MD`, §3). Also: Rust's `std` on MSVC pulls
  `kernel32`, `advapi32`, `ntdll`, `userenv`, `ws2_32`, `bcrypt`… — take the list from
  `--print native-static-libs` on Windows rather than guessing. **[untested here]**
- MSVC's linker has no `-dead_strip`; the equivalent is `/OPT:REF /OPT:ICF` (default in release)
  plus `/Gy` (function-level linking, which rustc already does).
- MinGW targets produce a `.a` linkable by gcc/clang on Windows.

---

## 5. Sizes

Measured on this tree (arm64 macOS, `lto`/`opt-level`/`panic` as noted; all with `debug = 0`):

| artifact | bytes |
|---|---|
| `libonde.a`, default release profile (no LTO, `panic=unwind`, cgu=16), 3 tiny exports | 32,498,352 |
| `libonde.a`, `lto="fat"`, `opt-level="z"`, `cgu=1`, `panic="abort"`, 3 tiny exports | 7,822,672 |
| `libonde.a`, same profile, real `onde_main` (drives an isolate) | 12,248,984 |
| `.exe` from that archive + C `main` | 4,445,224 |
| …`strip` | 2,889,096 |
| …`-Wl,-dead_strip` + `strip` | 2,870,424 |
| reference: `target/release/lite` (`lto="thin"`, `opt-level=3`, `cgu=1`, `panic="abort"`) | 5,317,472 |
| …`strip` / `strip -x` | 4,621,248 / 4,794,328 |
| toy exe (3 tiny exports, no LTO archive) / `-dead_strip` / `+strip` | 1,470,256 / 467,376 / 342,064 |

Readings:

- **Archive size is not executable size.** 12.2 MB of `.a` becomes 4.4 MB of executable because the
  linker only pulls referenced members. `opt-level="z"` + fat LTO + `cgu=1` + `panic="abort"` cut
  the *archive* ~4x (32.5 → 7.8 MB with the same three toy exports). The executable comparison is
  confounded: 4.4 MB (my `onde_main`, which only evaluates a `console.log`, so most of `ln-io` is
  unreachable) versus 5.3 MB (`lite`, which parses argv, reads files, and keeps the whole net /
  process / worker surface reachable). Do not read the 5.3 → 4.4 difference as a pure flag win.
- Expect a real embedded onde app at **4–6 MB unstripped, ~2.9–4.6 MB stripped** depending on how
  much of `ln-io`/`ln-runtime` is reachable (net + process + worker + signal code is a lot of
  reachable code if the JS calls it; my `onde_main` only evaluated a `console.log`, so
  `-dead_strip` had a field day).
- The payload adds its own bytes, uncompressed, page-aligned (§7): a 1 MB blob costs ~1.05 MB of
  executable; 10 MB costs ~10 MB. Compress (`--embed` a deflate-compressed blob and inflate at
  startup with `ln-zlib`, already in the tree) if that matters.

Flags that actually reduce output, in order of leverage:

1. `[profile.release] lto = "fat"`, `codegen-units = 1`, `opt-level = "z"`, `panic = "abort"`.
   (`opt-level = "s"` is usually within 1–2% of `"z"`; `"z"` costs speed.)
2. `-C strip = "symbols"` in the profile, so you do not need a post-link `strip` (saves ~1.5 MB on
   the 4.4 MB exe: the symbol table is huge because it describes 627 archive members).
3. `-Wl,-dead_strip` (macOS) / `-Wl,--gc-sections -ffunction-sections` (ELF). Note `-dead_strip`
   only helps if the section data is separable, which rustc gives you by default (`-C
   function-sections=yes`, the default outside debug builds); on the real onde executable the saving was 18,672 bytes (2,889,096 → 2,870,424), on the
   toy program ~1 MB (467,376 → 342,064 after strip).
4. `debug = 0` (default) or `debug = 1`; never `debug = 2` for a shipped `.a`.
5. Do **not** use `-Wl,--whole-archive` unless required; it forces step 3 to clean up after you.
6. `-Os`/`-Oz` at the *linker* (`-Wl,-O1` on ld64) is not a size lever.

---

## 6. The bytecode blob is a build-time ABI: what must match

### What is actually in the blob

`qjsc` mode (what an onde `lite compile` would mirror): evaluate the source with
`JS_EVAL_FLAG_COMPILE_ONLY` (+ `JS_EVAL_TYPE_MODULE` for ESM), then `JS_WriteObject(ctx, &len, obj,
JS_WRITE_OBJ_BYTECODE)`. *Verified* by reimplementing exactly that against the vendored quickjs-ng
and round-tripping a script and a module:

```
sizeof(JSValue)=16 blob=142 hdr[0]=28 hdr[1..4]=f9844c19
READ OK result=5            (script)      READ OK (module bytecode)
```

Header: byte 0 = `BC_VERSION`, then a 4-byte checksum, then LEB128 atom count and the atom table
(`quickjs.c: JS_WriteObjectAtoms`). `JS_ReadObject` validates version then checksum.

### The compatibility contract

| must match | why | verified? |
|---|---|---|
| **`BC_VERSION`** — 28 in quickjs-ng 0.16.2 (what `rquickjs-sys 0.14.0` vendors) | first byte of the blob; a mismatch is rejected with `SyntaxError: invalid version (28 expected=29)` | ✅ built a BC=29 tree and read a BC=28 blob |
| **builtin atom table order** (`quickjs-atom.h`) | const atoms are stored as *indices* (`bc_put_u8(s, 0x80 | atom)`), so a shifted table renames code silently | ✅ inserted one atom, kept `BC_VERSION` 28: `a.push(7)` and `s.toUpperCase()` bytecode failed with `CALL FAILED`; `add(2,3)` and `a.length` still "worked" |
| **endianness** | `bc_put_u64` writes raw host bytes (float64 payloads, and SharedArrayBuffer host pointers) | code read (`dbuf_put(&v, 8)`) |
| **32- vs 64-bit** | the SAB path writes `(uintptr_t)abuf->data`; pointer width is baked in | code read (`quickjs.c:39019`) |
| **`CONFIG_ATOMICS`** (SharedArrayBuffer) | changes whether SAB tags exist at all; onde's worker messages *do* serialize SABs | **inferred** from the tag table + `JS_WriteSharedArrayBuffer` |
| **`CONFIG_*` / patches that change codegen or atoms** | e.g. the planned host-owned job queue patch (`docs/engine-patch.md`) adds atoms and a new `JS_JobEntry` path; it must bump `BC_VERSION` and be applied to the compiler build too | **inferred** |
| `QJS_DISABLE_PARSER` | if the *runtime* build drops the parser it still reads bytecode — a real size lever, but then `eval`/`Function`/`new Function` must be unavailable, so it is a product decision, not a flag | **inferred** |
| `JS_READ_OBJ_BYTECODE` flag at read time | without it, bytecode is rejected as an invalid tag | header comment |

Also from `quickjs.h`, worth quoting in the ADR: *"only enable `JS_READ_OBJ_BYTECODE` on input from
a trusted writer. The bytecode format is not designed to resist a hostile producer; loading
adversarial bytecode can lead to memory corruption."* Code signing the final executable is the
mitigation; do not accept blobs from the network.

### Repo status (context for the plan)

- No bytecode path exists yet: `lite` has no `compile`/`--emit` mode, and `docs/architecture.md:73`
  + `docs/roadmap.md:44,479` schedule "bootstrap + stdlib compiled to bytecode at build time" for
  **M7**. `crates/ln-runtime/src/lib.rs:61` embeds the minified `bootstrap.js` with
  `include_str!(concat!(env!("OUT_DIR"), "/js/bootstrap.js"))` — the existing precedent for
  embedding a payload, and the natural first conversion.
- Version pinning hazard worth flagging now: `docs/engine-patch.md` says "Target: quickjs-ng
  **0.17.x**", but `ln-engine` pins `rquickjs = "0.14"`, whose `rquickjs-sys 0.14.0` vendors
  quickjs-ng **0.16.2** with `BC_VERSION 28`. Whoever writes the bytecode step must read the
  version out of the *vendored source tree*, not out of a doc.
- The ADR for worker messages already knows this: "The wire format for worker messages is quickjs
  bytecode, so a worker message is version-locked to…" (`docs/adr/0008-processes-and-threads.md:241`).
  The on-disk blob inherits the same constraint, plus the atom-table one.

### Precedent: "the compile step must use the same runtime"

- **Node SEA** — the same binary produces and hosts the blob: "The version of the Node.js binary
  used to produce the blob must be the same as the one to which the blob will be injected", and for
  cross-platform builds "`useCodeCache` and `useSnapshot` must be set to false … Since code cache
  and snapshots can only be loaded on the same platform where they are compiled"
  ([Node docs](https://nodejs.org/api/single-executable-applications.html)). Enforcement is by
  construction: the blob is injected into a *copy of the node executable*.
- **Bun** — `bun build --compile` produces a single-file executable, and `--bytecode` is a
  build-time optimisation tied to `target: "bun"`
  ([Bun docs](https://bun.com/docs/compiler/executables), [bundler](https://bun.com/docs/bundler));
  same "the tool that compiles is the runtime" structure. **[inferred: I did not verify Bun's
  internal blob format]**
- **Deno** — `deno compile` embeds a snapshot in a copy of the deno binary
  ([deno compile](https://docs.deno.com/runtime/reference/cli/compile/)).
- **qjsc** — the reference for *our* design: one tool from one quickjs tree emits either raw
  bytecode (`-b`) or "main() and bytecode in a C file" (`-e`), with `-s` to strip source and
  debug info ([qjsc(1)](https://manpages.debian.org/testing/qjs/qjsc.1.en.html)). Version match is
  by construction: compiler and runtime are the same build.

None of them have a version *handshake*; they all remove the mismatch by construction. onde cannot
fully do that (the user's `lite` and the user's `libonde.a` are separate artifacts), so add an
explicit stamp.

### Recommended enforcement for onde

1. **`lite compile app.js -o app.bc`** writes the blob *and* a fixed-size header record:
   `{ magic, format_version, bc_version, quickjs_ng_version, sizeof_jsvalue, endian, ptr_width,
   atom_table_hash, flags }` where `atom_table_hash` is a build-script hash over
   `quickjs-atom.h` + `quickjs.c`'s `BC_VERSION` (both readable from the vendored tree at build
   time). The stamp costs 32 bytes and catches the atom-shift class of bug that `BC_VERSION` misses.
2. **`onde_main` reads the stamp before `JS_ReadObject`** and fails closed with a clear message
   (`onde: bytecode was compiled by lite 0.1.0 (quickjs-ng 0.16.2, bc 28, lp64-le); this runtime is
   quickjs-ng 0.16.2, bc 28, lp64-le — mismatch in atom table`).
3. **`lite --version`** prints the same stamp, and the staticlib exports `onde_engine_stamp()` in
   the same tuple, so a build can diff them in CI.
4. **Generated C carries it too** (§7): the emitted `onde_blob.c` embeds the stamp as a struct next
   to the array, so `nm`/`strings` on the final binary tells you which engine it expects.
5. Add a CI job that compiles a fixture with `lite`, links it against the *packaged* `libonde.a`,
   and runs it — the only way to catch a stale stamp.

---

## 7. `dlopen` instead, and embedding the payload

### `dlopen`-ing the runtime (`cdylib`)

Build `crate-type = ["cdylib"]` → `libonde.dylib` / `libonde.so` / `onde.dll`, `dlsym("onde_main")`.

Pros: the host links no Rust at all; the engine can be updated independently; a plugin model where
several scripts share one engine; no duplicate-std problem *if the host has no Rust*; the runtime's
symbols stay inside the dylib's namespace when loaded `RTLD_LOCAL`.

Cons, in order of severity:

- **Distribution**: a second file to sign/notarize/install, an `install_name`/`@rpath` to get right
  on macOS, `LD_LIBRARY_PATH`/`rpath` on Linux, a DLL search order on Windows. The whole point of
  the exercise is usually *one* file.
- **Static musl/glibc-static hosts cannot `dlopen` at all** — and musl's `dlclose` is a no-op that
  never unmaps ([musl wiki](https://wiki.musl-libc.org/functional-differences-from-glibc.html)),
  so "reload the engine" is not a thing there.
- **Unwinding across the boundary**: the Rust Reference explicitly counts `dlopen` as "linking
  without rustc", where "you must take care to ensure that unwinding is handled consistently"
  ([linkage](https://doc.rust-lang.org/reference/linkage.html)). `panic = "abort"` removes the
  question.
- **Two quickjs copies** in one process is still possible (host has its own); `RTLD_LOCAL` +
  `-Wl,-Bsymbolic` help but do not fix shared global state.
- Startup cost: dyld relocation of a 10 MB dylib is not free, though it is shared across processes
  via the page cache.
- iOS forbids `dlopen` of non-system libraries entirely. **[inferred, but well-established]**

Verdict: `staticlib` for "ship one executable", `cdylib` for "host is a long-lived app that wants to
update/replace the engine, and has a plugin ABI". Supporting both is cheap (same `lib.rs`, two
crate-type entries); the packaging story is what differs.

### Embedding the blob: four techniques, measured

*(a) Generated C array — the "generated C file" the brief asks about*

```c
/* lite compile --emit-c app.bc > app_blob.c */
const unsigned char onde_blob[] = { 0x1c, 0xf9, 0x84, /* … */ };
const unsigned long onde_blob_len = 142;
```

*Verified* with `xxd -i` on random blobs:

| blob | C source | `clang -c -O0` |
|---|---|---|
| 1 MB | 6.1 MB | 0.69 s |
| 10 MB | 61.7 MB | 3.67 s |

The cost is the preprocessor + parser choking on ~10^7 comma-separated integer tokens, and 6x
source inflation (each byte costs `0xNN, ` = 6 chars). That is the reason to avoid the classic
`xxd -i` form for anything above ~1 MB: it makes the *generated file* the build bottleneck and
bloats CI caches. Also note the array is a mutable global by default (goes to `__DATA`, not
`__TEXT`); add `const`.

*(b) `#embed` (C23) — same code shape, no token list*

```c
const unsigned char onde_blob[] = {
#embed "app.bc"
};
```

*Verified* with clang 23 (C23): 1 MB → **0.065 s**, 10 MB → **0.201 s**, object exactly blob-sized
(1,000,928 / 10,000,928 bytes for 1 MB / 10 MB). That is **10–18x faster than the array** and it
keeps the source file tiny. Standardised in C23 ([cppreference](https://en.cppreference.com/w/c/preprocessor/embed)),
clang ≥ 19 and GCC 15 support it **[inferred for GCC]**; MSVC does not yet. Best default for
"generated C file" if the host toolchain is clang.

*(c) macOS linker section — no C parsing at all*

```bash
clang app.c -Wl,-sectcreate,__DATA,__blob,app.bc -o app
```

```c
#include <mach-o/getsect.h>
#include <mach-o/ldsyms.h>
unsigned long size = 0;
const unsigned char *p = getsectiondata(&_mh_execute_header, "__DATA", "__blob", &size);
```

*Verified*: `getsectiondata` returned the right pointer and `size = 1,000,000`; the executable grew
to 1,057,232 bytes. Start/end symbols also work, which is nicer than a runtime lookup:

```c
extern const char section$start$__DATA$__blob[] __asm("section$start$__DATA$__blob");
extern const char section$end$__DATA$__blob[]   __asm("section$end$__DATA$__blob");
```

*Verified*: `start=0x10001c000 end=0x100110240 len=1000000`. `ld -sectcreate segname sectname file`
"created from the contents of file file", and if another input has the same section "the linker
will append the content" ([ld(1)](https://keith.github.io/xcode-man-pages/ld.1.html)) — so exactly
one `-sectcreate` per section, or you get concatenation.

Caveats: `__DATA` is writable (a script bug could scribble on the blob — use `__TEXT,__const` with
`-Wl,-sectalign,__TEXT,__const,0x1000` if you want it read-only, at the cost of alignment padding);
the section is page-aligned so a 1 MB blob costs ~1.05 MB; and the technique is macOS-only.

*(d) ELF: `ld -r -b binary`, or `.incbin`*

```bash
ld -r -b binary -o app_blob.o app.bc     # BFD treats the file as a binary blob
# symbols, by BFD convention: _binary_app_bc_start / _end / _size
```

`ld -b input-format` selects the *binary* BFD format for the input that follows
([GNU ld manual](https://sourceware.org/binutils/docs/ld/Options.html)); the `_binary_<path>_start`
symbol names are BFD's convention, and the path is mangled (non-alphanumerics → `_`).
**[symbol names unverified here — no Linux box — but this is the standard recipe; the `-b` option
itself is documented]**

More portable and self-documenting, and it works on both ELF and Mach-O: assemble the payload with
your own labels.

```asm
# blob.S   —  .incbin works in clang's integrated assembler on Mach-O and ELF
    .section .rodata          # ELF; on Mach-O: .section __TEXT,__const
    .globl onde_blob_start
    .globl onde_blob_end
onde_blob_start:
    .incbin "app.bc"
onde_blob_end:
```

*Verified on Mach-O* (with `__DATA,__blob`): `_myblob_start`/`_myblob_end` came out as `S` symbols,
`len = 1000000`, executable 1,057,272 bytes — no C parsing, no 6x source, works with any assembler.

*(e) Rust-side, if the host is Rust*: `static BLOB: &[u8] = include_bytes!("app.bc");` compiles the
blob into `__DATA,__const`/`.rodata` with no source bloat, and
`#[link_section = "__DATA,__blob"] static BLOB: [u8; N] = *include_bytes!("app.bc");` gives you a
named section. `include_str!` of the minified `bootstrap.js` is already how this repo embeds JS
(`crates/ln-runtime/src/lib.rs:61`), so the pattern is proven in-tree.

### Portable start/end recipe

```c
#if defined(__APPLE__)
  extern const unsigned char onde_blob_start[] __asm("section$start$__DATA$__blob");
  extern const unsigned char onde_blob_end[]   __asm("section$end$__DATA$__blob");
#elif defined(__ELF__)
  extern const unsigned char onde_blob_start[];   /* from blob.S or ld -r -b binary */
  extern const unsigned char onde_blob_end[];
#else
  extern const unsigned char onde_blob[];         /* C array / #embed fallback */
  extern const unsigned long onde_blob_len;
#endif
```

Ship this as `onde_embed.h` plus a tiny `lite embed` subcommand that emits the right one for the
target, and the user never sees a linker flag.

---

## 8. Concrete proposal for this repo

1. New crate `crates/ln-staticlib` (`crate-type = ["staticlib", "cdylib"]`), depends on
   `ln-runtime`; `src/lib.rs` exports `onde_main`, `onde_version`, `onde_engine_stamp`,
   `onde_free_error`/last-error accessor, and (optionally) the quickjs C API re-export.
   `ln-cli`'s `real_main()` moves into it as `pub fn run_with_argv(Vec<String>) -> i32`, with
   `lite` becoming a 40-line wrapper. This also removes `process::exit` from the library path.
2. `#[profile.release]` gains `strip = "symbols"`, `lto = "fat"`, `opt-level = "z"` for the
   staticlib crate only (a `[profile.release.package.ln-staticlib]` override is not enough — LTO is
   whole-graph; instead give the staticlib its own `--profile staticlib` in `.cargo/config.toml`).
3. `lite compile --emit c|raw|stamp` implementing §6, with `#[link_section]`-friendly output and
   the 32-byte stamp. Reuse the `qjsc` conventions (`-b` raw, `-e` main+C, `-s` strip source).
4. Docs: a `docs/embedding.md` with the three link lines (macOS/Linux static/Windows), the
   `--print native-static-libs` output, and the "same build must produce `lite` and `libonde.a`"
   rule stated as a hard requirement.
5. CI: build the staticlib on all three OSes, link a 20-line C fixture and a C++ fixture against
   it, run them, `strip` and record sizes, and run the `lite`-compiled-blob round trip.

Open questions for the ADR:

- Does the embedded runtime own signals by default? (Recommend: no.)
- `process.argv`/`__filename` shape for an embedded main (§2).
- Does `onde_main` return an exit code or call `exit()`? (Recommend: return, and add
  `onde_main_exit()` for scripts that call `process.exit()`.)
- Worker threads + `fork()`: `ln-io` spawns a multi-threaded tokio runtime and `ln-io::signal`
  installs handlers; a host that forks after `onde_main` returns inherits both. Document.

---

## 9. Experiment log (reproducible)

All under `target/scratch/` (nothing outside `target/` was modified; the one file written to the
repo is this document).

| # | what | how | result |
|---|---|---|---|
| 1 | staticlib output | `target/scratch/onde-staticlib` with `crate-type=["staticlib"]`, deps `ln-runtime` | `libonde.a`, 32,498,352 B, 627 members |
| 2 | C deps bundled? | `ar x`, `file`, `nm -g` | 4 quickjs objects inside; `T _JS_NewRuntime` |
| 3 | native-static-libs (macOS) | `cargo rustc --release -- --print native-static-libs` | `-liconv -lSystem -lc -lm` |
| 4 | native-static-libs (Linux) | same, `--target x86_64-unknown-linux-gnu`, pure-Rust crate | `-lgcc_s -lutil -lrt -lpthread -lm -ldl -lc`; produced a real Linux `ar` archive with no linker |
| 5 | cross with a C dep | full staticlib for `x86_64-unknown-linux-gnu` on macOS | fails: `failed to find tool "x86_64-linux-gnu-gcc"` |
| 6 | C host links + runs | `clang main.c libonde.a -o t1 && ./t1` | runs; `clang main.c libonde.a` also links (driver supplies System/c/m) |
| 7 | C++ host | `clang++` without `extern "C"` → link error naming the mangled symbol; with it → runs | C++ needs `extern "C"` |
| 8 | `main` from the library | staticlib exporting `#[no_mangle] extern "C" fn main`, host with no `main` | links, runs, argv correct, exit 7 |
| 9 | duplicate symbols | link `libonde.a` + `libother.a` lazily vs `-force_load` both | lazy OK; force_load → 2283 duplicate symbols |
| 10 | panic behaviour | `catch_unwind` + escaping panic, `panic=abort` vs default | abort 134 vs caught / `panic in a function that cannot unwind` |
| 11 | `process::exit` | `Drop` impl before `exit(3)` | destructor skipped, exit code 3 |
| 12 | LTO + staticlib | `lto="fat"`, `opt-level="z"`, `cgu=1`, `panic="abort"` | archive 7.8 MB (12.2 MB with a real `onde_main`); members are native Mach-O with `__text` **and** `__LLVM,__bitcode` (252/420), plus inherited `__debug_*`; clang links it and the program runs |
| 13 | sizes | see §5 table | 4,445,224 → 2,889,096 (strip) → 2,870,424 (+dead_strip) |
| 14 | lipo on `.a` | two thin archives → `lipo -create`; link `-arch x86_64` | universal `.a` works, right slice chosen; duplicate arch rejected |
| 15 | `-sectcreate` | `blob1.bin` + `getsectiondata` + `section$start$`/`section$end$` | 1,000,000 bytes found; start/end symbols resolve |
| 16 | `.incbin` | Mach-O `.section __DATA,__blob` + own labels | 1,000,000 bytes, `_myblob_start`/`_end` |
| 17 | `#embed` | clang 23 `-std=c23` | 1 MB 0.065 s, 10 MB 0.201 s |
| 18 | C array | `xxd -i` + `clang -c -O0` | 1 MB → 6.1 MB C, 0.69 s; 10 MB → 61.7 MB C, 3.67 s |
| 19 | bytecode round-trip | reimplemented `qjsc`'s `COMPILE_ONLY` + `JS_WriteObject` against vendored quickjs-ng 0.16.2 | blob 142 B, `hdr[0]=28`, reads back and executes |
| 20 | version gate | rebuilt quickjs with `BC_VERSION 29`, read the 28 blob | `SyntaxError: invalid version (28 expected=29)` |
| 21 | atom-table gate | added one atom to `quickjs-atom.h`, kept `BC_VERSION 28`, read the same blob | `a.push(7)`/`s.toUpperCase()` bytecode → `CALL FAILED`; `add`/`a.length` still passed |

Machine notes for anyone reproducing: the sandbox denies writes to `~/.cargo`, so the scratch
crates need the repo's `Cargo.lock` copied in and `--offline` (otherwise cargo tries to fetch a
newer `zeroize` and fails). `nm` from the Xcode toolchain prints
`Unknown attribute kind (105)` on `compiler_builtins` objects produced by rustc 1.100's LLVM 23 —
harmless, and `strip`/`ld` handle the same objects fine.

---

## 10. Citations

- Rust Reference, *Linkage* — staticlib contents, `*.a`/`*.lib`, exported symbols, `--gc-sections`/`-dead_strip`, multiple staticlibs conflict, `crt-static`, unwinding rules:
  <https://doc.rust-lang.org/reference/linkage.html>
- rustc book, *Command-line arguments* — `-l static:+whole-archive` → `--whole-archive`/`-force_load`/`/WHOLEARCHIVE`; `+bundle` packs a native static lib into the staticlib:
  <https://doc.rust-lang.org/rustc/command-line-arguments.html>
- rustc book, *Print options* — `--print native-static-libs`:
  <https://doc.rust-lang.org/rustc/command-line-arguments/print-options.html#native-static-libs>
- `--print native-static-libs` goes to stderr: <https://github.com/rust-lang/rust/issues/125304>
- `std::panic::catch_unwind` — catches only unwinding panics; `extern "C"` aborts on panic:
  <https://doc.rust-lang.org/std/panic/fn.catch_unwind.html>
- ld(1) (Apple) — static archives pulled only as needed, `-force_load`, `-all_load`, `-sectcreate`, `-dead_strip`, `-exported_symbols_list`, `-hidden-l`, universal input/`-arch`, `lipo`:
  <https://keith.github.io/xcode-man-pages/ld.1.html>
- lipo(1) — universal files, `-create`, duplicate-architecture refusal (`man lipo`).
- GNU ld, *Command-line Options* — `-b input-format`, `--gc-sections`, `-r`:
  <https://sourceware.org/binutils/docs/ld/Options.html>
- C23 binary resource inclusion (`#embed`, `__has_embed`):
  <https://en.cppreference.com/w/c/preprocessor/embed>
- Node.js, *Single executable applications* — "The version of the Node.js binary used to produce the blob must be the same as the one to which the blob will be injected"; cross-platform `useCodeCache`/`useSnapshot` must be false:
  <https://nodejs.org/api/single-executable-applications.html>
- Bun, *Single-file executable* / `--compile` / `--bytecode`:
  <https://bun.com/docs/compiler/executables> · <https://bun.com/docs/bundler>
- Deno, *deno compile*: <https://docs.deno.com/runtime/reference/cli/compile/>
- qjsc(1) — `-b` raw bytecode, `-e` main()+bytecode in a C file, `-s` strip source/debug:
  <https://manpages.debian.org/testing/qjs/qjsc.1.en.html>
- quickjs-ng (upstream, `BC_VERSION` lives in `quickjs.c`): <https://github.com/quickjs-ng/quickjs>
- musl wiki, *Functional differences from glibc* — resolver, `dlopen`/`dlclose`, locale:
  <https://wiki.musl-libc.org/functional-differences-from-glibc.html>
- Drepper, *Static Linking Considered Harmful* — NSS/locale/IDN need dynamic loading; static glibc caveats:
  <https://www.akkadia.org/drepper/no_static_linking.html>
- `cargo-zigbuild` — `zig cc` as the cross C compiler/linker: <https://github.com/rust-cross/cargo-zigbuild>
- `getrandom` 0.2 platform support (macOS → `getentropy`): <https://docs.rs/getrandom/0.2.17/getrandom/>
- `ring` build requirements: <https://github.com/briansmith/ring>
- Cargo profiles (`lto`, `panic`, `strip`, `codegen-units`, `opt-level`):
  <https://doc.rust-lang.org/cargo/reference/profiles.html>
- Cargo targets / `crate-type`: <https://doc.rust-lang.org/cargo/reference/cargo-targets.html>
