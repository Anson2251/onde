# Building a standalone onde app

Status: implemented, v6 (2026-11-21). Supersedes the append-to-a-copy draft, the onde-side
bundling idea, and the JS-driver draft. The link backend works end to end on the host cell: a real
app is bundled, compiled to bytecode, linked against a local archive, and run after its project
directory and SDK copy are deleted (`test/standalone/run.sh`, `crates/ondec/tests/e2e.rs`).

What exists in the tree:

| piece | crate | notes |
| --- | --- | --- |
| engine identity | `crates/ln-abi` | `Stamp` (read from the vendored sources), encode/parse/compare; FNV-1a of `quickjs-atom.h` |
| stamped engine | `crates/ln-engine` | `build.rs` bakes `engine_stamp()`; `compile::module` (stub loader, §3.3); `eval_module_bytecode` |
| payload format | `crates/ln-payload` | header/table/bodies, structural validation, key resolution, `Builder`, `compress` |
| compiled mode | `crates/ln-runtime` | payload resolver/loader, `Config::payload`, `Isolate::run_payload`, exit 78 on a stamp mismatch |
| C ABI | `crates/ln-embed` | `staticlib` (`libonde.a`), `onde_main_payload`/`onde_engine_stamp`/`onde_version`, `include/onde.h`, `#[used]` marker |
| build tool | `crates/ondec` | clap CLI, rolldown frontend, payload encoder, generated C, cc/link/strip/sign, SDK cache/download, wrappe staging |

Verified on `aarch64-apple-darwin` (Apple clang 21, Apple `ld`): ESM and CJS entries, `node:` and
payload-key imports, `import.meta` from keys, Node SEA's argv shape, `--embed section`, all three
payload codecs, `--no-bytecode`, `--strip-source`, `--print-command`, and a 4.3 MB stripped
executable that starts in ~15 ms.

First real package packaged and run: **vibe-cpc 0.1.1-alpha.1** (338 KB CJS bundle, 1.1 MiB
payload, 5.5 MiB executable). `--help`, `--version`, pseudocode execution, `-o json`, `--verbose`
and its error path all match the Node run byte for byte, and it starts in 43 ms against Node's
183 ms. That test is also what found the `require.main === module` trap in §8.3. Not yet verified: every other cell in §2.1, `ondec sdk` against a
real GitHub release, the wrappe backend's exact CLI invocation, and per-cell CI jobs. Those are
tracked in §11.

**Decision.** A separate build tool, **`ondec`**, bundles the app with rolldown in-process and then
packages it one of two ways:

- **`--packager link` (default).** Compile the bundle to QuickJS bytecode, resolve the SDK cell for
  the requested target tuple, write a temporary C file, compile and link it against
  `libonde-<tuple>.a`, optionally sign. The SDK is two shipped files: `onde.h` and one static
  library per system/libc/arch cell.
- **`--packager wrappe` (opt-in).** Stage `onde-<tuple>` + the bundled assets and let `wrappe` build
  a self-extracting binary. No C toolchain, no SDK; it unpacks at run time (Appendix D).

The rest of this document specifies the link backend, because it is the default and the one with
the interesting constraints. Appendix D specifies the wrappe backend and the trade between them.
Both share the same frontend, so the choice is a flag, not a fork.

**Why linking is the default.** It is the direct path: the payload is a normal object in the image,
so code signing, `strip`, `-dead_strip`, ASLR, and every packaging tool behave normally; the binary
can be smaller than `onde` because unreferenced code is dropped; and the same library is what a
C/C++ host links when it wants to embed onde. Appending to a copy of the runtime (Bun/LLRT/qjs
style) cannot produce a valid macOS signature — verified, see Appendix B — and needs its own loader
format. The `wrappe` backend is the deliberate exception: it is compiler-less and keeps real files
at run time, and it pays for that with extraction, a second process and an outer file whose payload
cannot be sealed. Both are supported; the choice belongs to the project.

Raw research behind the numbers and the prior art:

- [`docs/research/qjsc.md`](research/qjsc.md) — qjsc, generated C, bytecode format, version and
  atom-table coupling, size/startup measurements.
- [`docs/research/static-lib.md`](research/static-lib.md) — `staticlib` mechanics, link lines,
  symbol hazards, cross-compilation, payload embedding techniques.
- [`docs/research/prior-art.md`](research/prior-art.md) — Node SEA, Bun, Deno, pkg/nexe, LLRT.

---

## 1. The shape of the feature

```console
$ ondec build src/main.js --target aarch64-apple-darwin -o app
ondec: bundled 2 entries with rolldown 1.3.2 -> src/main.js, src/worker.js
ondec: target aarch64-apple-darwin (aarch64 / darwin / libc=system)
ondec: sdk v0.1.0 -> ~/.cache/onde/sdk/v0.1.0/aarch64-apple-darwin (fetched, sha256 ok)
ondec: engine qjs-ng 0.17.0 bc28 le atom-3f9a1c02 (tool and sdk agree)
ondec: compiled 2 modules, 41,233 + 6,904 bytes bytecode (source kept, deflate 14,120)
ondec: cc -O2 -I<sdk> app.c <sdk>/libonde-aarch64-apple-darwin.a -o app -liconv
ondec: signed with "Developer ID Application: …"
ondec: app  4,402,112 bytes
```

Six steps, each independently testable. Steps 1–2 are shared by both packagers; steps 3–6 are the
**link** backend. The **wrappe** backend replaces 3–6 with "stage `onde-<tuple>` and the assets,
invoke wrappe" (Appendix D).

1. **Bundle** the entry in-process with rolldown (section 8), including any extra entry points the
   app needs at run time. onde does not bundle; rolldown does, and its output assets are what the
   payload holds.
2. **Transcribe** every output to QuickJS module bytecode with no evaluation at build time. The
   frontend emits one format (ESM), so there is exactly one kind of payload entry.
3. **Resolve the SDK** for the target tuple: `onde.h` + `libonde-<tuple>.a`, from a cache or a
   release download, verified by checksum and ABI stamp. "Pulls what it needs" means exactly this:
   the two SDK files for the requested cell over the network (or from `--sdk`/the cache).
4. **Generate** a temporary C file containing the payload and a `main` that calls into the library.
5. **Compile and link** with the toolchain the user named for that tuple, then **strip** and
   **optionally sign** (codesign / signtool / a command template).
6. **Report** size, tuple, engine stamp, and the exact commands (with `-v`).

The bundle is the unit of deployment, and the payload's module table is exactly the bundler's
asset list keyed by relative path. There is no onde-side bundler, no module-graph freezer, and no custom
`app:///` name space: after the bundler, the only remaining imports are builtins, and the only
remaining files are the ones it emitted (workers, opt-in chunks, and nothing else).

The user always names the tuple (section 5). There is no attempt to discover which cross toolchain
is installed; that is a later phase, and guessing wrong is worse than failing with a list of what
to set.

The driver is a **separate Rust binary, `ondec`** (section 3): it links the bundler (rolldown) and
the bytecode compiler (`ln-engine`) directly, so there is no child process, no Node, and no external
bundler to install. `onde` gains nothing — it stays a 5.3 MB runtime.

---

## 2. The released artifacts

The SDK is two files: one `onde.h` shared by every cell, and one static library per cell. Plus
release metadata. The same release also publishes the build tool (`ondec`, one binary per host
triple); it consumes the SDK, is not part of it, and is not needed to run a built app.

| File | Contents |
| --- | --- |
| `onde.h` | the C ABI: version macros, entry points, stamp accessor. One file for every target; it contains no architecture-specific material and no generated content. |
| `libonde-<tuple>.a` | the runtime as a static archive: `ln-runtime`, `ln-engine`, quickjs-ng C objects, tokio/rustls/ring, the embedded minified stdlib, and the C-ABI shim. MSVC cells ship `onde-<tuple>.lib` (a COFF archive) because that is what `cl`/`link` consume. |
| `SHA256SUMS` | release metadata, not part of the SDK: the driver fetches it to verify the two files. |
| `onde-<tuple>` | the runtime binary for one target, published for the `wrappe` backend (§D); not needed by a linked app, which contains the runtime already. |

No manifest file is needed: the ABI stamp is **embedded as a byte string inside the archive**, so
the JS driver finds it with a `Buffer.indexOf` and validates the fields — no linker, no executable,
no symbol table, and no knowledge of the target architecture (section 4.3).

### 2.1 Naming and matrix

Tuple spelling follows Rust, because that is what the user already knows:

```
<arch>-<vendor>-<os>[-<libc>]        libonde-<tuple>.a
```

Initial matrix (v1). Every cell is built from the same commit and the same quickjs-ng source, with
the workspace's **performance** profile (`opt-level = 3`, `lto = "thin"`, `codegen-units = 1`,
`panic = "abort"`) and the minified stdlib embedded — never a size-oriented profile; see §12. The
archive is compressed for release download, not built small. The engine stamp must
be identical in every cell; the libc/arch differ, nothing else.

| tuple | arch | OS / libc | archive | notes |
| --- | --- | --- | --- | --- |
| `aarch64-apple-darwin` | arm64 | macOS, libSystem | `libonde-aarch64-apple-darwin.a` | primary host |
| `x86_64-apple-darwin` | x86_64 | macOS, libSystem | `libonde-x86_64-apple-darwin.a` | |
| `aarch64-unknown-linux-gnu` | arm64 | Linux, glibc | `libonde-aarch64-unknown-linux-gnu.a` | record glibc floor |
| `x86_64-unknown-linux-gnu` | x86_64 | Linux, glibc | `libonde-x86_64-unknown-linux-gnu.a` | record glibc floor |
| `aarch64-unknown-linux-musl` | arm64 | Linux, musl | `libonde-aarch64-unknown-linux-musl.a` | static by default |
| `x86_64-unknown-linux-musl` | x86_64 | Linux, musl | `libonde-x86_64-unknown-linux-musl.a` | static by default |
| `x86_64-pc-windows-msvc` | x86_64 | Windows, MSVC CRT | `onde-x86_64-pc-windows-msvc.lib` | `/MD` CRT |
| `aarch64-pc-windows-msvc` | arm64 | Windows, MSVC CRT | `onde-aarch64-pc-windows-msvc.lib` | `/MD` CRT |

Deliberately out of scope for v1: 32-bit targets (pointer width is an untested axis for bytecode),
big-endian targets (quickjs-ng writes native-endian bytecode; section 4), and Windows GNU, since
it doubles the Windows support surface for no current user.

Two properties worth stating in the release notes:

- **glibc cells carry a floor.** A Rust static archive still calls libc symbols, so a cell built on
  a new glibc refuses to run on an old one. Build each glibc cell in a container pinned to the
  oldest glibc we support (Debian 11 / glibc 2.31 is a defensible starting point) and record the
  floor in the release table. musl cells have no such problem and are the answer for "one binary
  for any Linux".
- **macOS universal binaries** are possible two ways: link each arch and `lipo` the two
  executables, or `lipo` the two archives into one fat `.a` and link once. Both work; `lipo`
  accepts `.a` files (verified) but refuses duplicate arch members.

### 2.2 `onde.h`

C99, `extern "C"`, no struct passed by value, no ownership transfer across the boundary:

```c
#ifndef ONDE_H
#define ONDE_H
#include <stddef.h>

#define ONDE_ABI_VERSION 1          /* bump only for a breaking C ABI change */

/* Run a payload: a C array, a linker-section view, an mmap, a resource.
   The bytes must stay valid and immutable for the whole call (the runtime reads
   QuickJS bytecode in place). Returns the process exit code, 78 on an ABI mismatch.
   The generated C file's main() calls exactly this. */
int onde_main_payload(const unsigned char *blob, size_t len, int argc, char **argv);

/* "ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=3f9a1c02;" — the same string the
   archive carries and the driver scans for. Compare it against the payload header
   when embedding the runtime in a long-lived host. */
const char *onde_engine_stamp(void);

/* "0.1.0"; the header and the archive must agree on ONDE_ABI_VERSION. */
const char *onde_version(void);

#endif
```

Rules the host must know, and which belong in comments in the header:

- `panic = "abort"`: a Rust panic aborts the process. A C host must not expect an exception it can
  catch, and there is no unwinding across `onde_main_payload`.
- **Only one Rust static library per program.** Linking two archives that both carry `std` (e.g.
  onde plus another Rust library built as a staticlib) produces thousands of duplicate symbols;
  verified: two `-force_load`ed Rust staticlibs gave 2,283 duplicate symbols. Prefer `cdylib` for
  the other library, or link it together with onde into one archive.
- Signals, `setlocale`, and process-wide handlers are **opt-in**. `ln-io` installs signal handlers
  for `process.on('SIGINT')`; in library mode the embedder decides, via a config call (not in the
  v1 header, but the runtime must support suppressing it).
- The payload must outlive the call: `onde_main_payload` does not copy, because
  `JS_READ_OBJ_ROM_DATA` lets QuickJS keep pointers into it.
- Threading: one isolate per thread, and the calling thread is the isolate thread;
  `onde_main_payload` returns when the event loop drains.

The header also carries the ABI stamp in a comment, so `strings onde.h` and a diff against the
archive symbol is enough for a human to debug a mismatch.

### 2.3 What a host must link

The set is cell-specific and is printed by rustc at SDK build time
(`cargo rustc -- --print native-static-libs`), then recorded in the release table and echoed by
`ondec build --print-command`. For this dependency set:

- macOS: `-liconv` (nothing else: `cc` brings in libSystem, libc and libm, and naming them makes
  `ld` warn about duplicate libraries; no frameworks, since `getrandom` uses `getentropy(2)` and
  `ring` links its own asm statically).
- Linux/glibc: `-lgcc_s -lutil -lrt -lpthread -lm -ldl -lc` (most are implicit when `cc` drives
  the link).
- Windows/MSVC: the `*.lib` equivalents rustc prints; the C side must use the same CRT as the
  archive (`/MD` for the default build).

---

## 3. The toolchain is a separate CLI

**Decision: `ondec` is its own Rust binary in this workspace.** It is not a subcommand of `onde`,
and `onde` gains no build code and no build dependencies.

Why a separate binary:

- The bundler is a large Rust dependency tree. `rolldown` 1.3.2 pulls `oxc` 0.158 and `tokio`
  across ~200 crates; linking that into `onde` would blow up build time and add megabytes to a
  5.3 MB runtime that ships embedded in other programs.
- `onde` stays a runtime: no HTTP client, no temp files, no C compiler awareness, no bundler.
- `ondec` is a **host** tool, built per developer machine; `libonde.a` is **per target**. Keeping
  them separate keeps the release matrix about the runtime, not about the tool.
- Version lockstep is explicit and checkable: `ondec <version>` ⇔ SDK `<version>`. A dev build of
  `ondec` pairs with a locally built archive through `--sdk <dir>`, and the ABI stamp catches any
  mismatch either way.

What `ondec` links:

| dependency | why |
| --- | --- |
| `rolldown` | the frontend: bundling, TS/JSX loaders, Node resolution, CJS→ESM, in-process |
| `ln-engine` | bytecode: the same quickjs-ng build as the SDK, so `BC_VERSION`/atoms match by construction |
| `curl` (spawned, `-fsSL --retry 2`) | SDK download; the same route this repository's `wasi-sdk` build step takes, and one fewer TLS stack in a build tool |
| `sha2`, `flate2` | `SHA256SUMS` verification; `--compress` |
| `rolldown_common` | naming rolldown's `Output` enum (the `rolldown` crate re-exports its options, not its output types) |
| `clap`, `tempfile` | the interface, staging |

That is a deliberately heavy build tool and a deliberately lean runtime. `ondec` is shipped as a
release artifact per host triple (`ondec-aarch64-apple-darwin`, `ondec-x86_64-unknown-linux-gnu`, …)
next to the SDK cells; `cargo install --path crates/ondec` covers people building from source.

Size is a release-engineering target for the tool, not a design constraint on the app: expected
well under 25 MB, with a CI gate at 25 MB and a hard failure at 100 MB. None of that budget is
spent at run time — the built app links `libonde.a`, not `ondec`, so rolldown and the toolchain
never appear in a user's process.

### 3.1 Interface

```
ondec build <entry> [--target <tuple>] [-o <file>] [--help]

  Packager (section 3.2, Appendix D)
    --packager link|wrappe   default link; wrappe needs no C toolchain and unpacks at run time
    --runtime <path>         `onde` binary for the wrappe payload (default: next to ondec, else
                             download onde-<tuple>)
    --wrappe <path>          wrappe CLI (default: `wrappe` on PATH)
    --asset <path>           copy a file or directory into the wrappe payload, repeatable
    --unpack-target temp|local|cwd   wrappe unpack location (default temp)

  Frontend (section 8)
    --entry <file>           additional entry point, repeatable (workers, CLI tools)
    --outbase <dir>          project root for payload keys; default: nearest package.json
    --externals <spec,…>     leave these imports unresolved (they will fail at run time)
    --splitting              let the bundler emit shared chunks (they become payload keys)
    --minify                 pass through to the bundler
    --sourcemap              emit a source map next to the payload (not yet consumed)
    --no-bytecode            store source instead of bytecode (debugging)

  SDK
    --sdk <dir>              use this unpacked SDK instead of the cache/download
    --sdk-version <v>        default: this ondec's version
    --no-fetch               fail instead of downloading
    --sdk-base-url <url>     mirror (default: the release URL for the version)

  Payload
    --strip-source           smaller payload; loses Function.prototype.toString
    --compress / --no-compress   deflate the payload; off by default (costs ~1.4 ms/MiB to inflate)

  Toolchain (section 5)
    --cc <command>           compiler driver for the target
    --cc-family gcc|clang|zig|msvc   flag policy; default derived from the tuple
    --sysroot <dir>          cross sysroot
    --cflags <flags>         extra compiler flags
    --ldflags <flags>        extra linker flags
    --embed array|section    payload placement (default: array)

  Output
    --strip                  run strip after linking (default: on for exe output)
    --sign <spec>            none | codesign:<identity> | signtool:<cert> | @<template>
    --print-command          print the commands instead of running them
    --keep-temp              keep the bundle, the generated C file and the payload
    -v                       one line per step
```

Companion subcommands, for a restricted environment that must pre-stage the SDK:

```
ondec sdk list                        # cells available for this version
ondec sdk install [--target <tuple>]  # fetch + verify into the cache
ondec sdk path --target <tuple>       # print the cache directory
ondec sdk verify --target <tuple>     # sha256 + ABI marker against this ondec
```

`--target` may be omitted; the default is the host tuple (printed, not guessed). What is *not*
automatic is the toolchain: a non-host tuple with no `--cc` and no `CC_<tuple>` fails with the exact
environment variable and flag to set.

### 3.2 Pipeline

1. **Bundle in-process** with rolldown (§8): the entry plus any `--entry` extra entries, Node
   platform, ESM output, assets collected in memory. Both backends start here; the frontend does
   not depend on the packager.
2. **Map assets to keys**: each asset's filename relative to the project root is its key; the asset
   produced for the main entry is the entry.

   *Link backend:* steps 3–8 below. *Wrappe backend:* stage `onde-<tuple>` + the bundled entry as
   `app.mjs` + every other asset at its key + `--asset` copies, then run
   `wrappe --input <stage> --runner <tuple> onde app.mjs -o <out>`. No SDK, no `cc`, no payload
   format; the entry is parsed by `onde` at each start, and signing is the user's problem
   (Appendix D).
3. **Compile every asset** to QuickJS module bytecode with `ln-engine` (§3.3). A parse error stops
   the build with the runtime's file/line/caret renderer; nothing is written.
4. **Resolve the SDK**: cache hit or download; sha256 against `SHA256SUMS`; scan the archive for
   the ABI marker; compare with `ondec`'s own stamp. Refuse on mismatch, naming both stamps.
5. **Encode the payload** (§7): header, table, bodies, optional deflate; offsets and lengths are
   checked before anything is written.
6. **Generate** `$TMP/ondec-build-XXXX/app.c` (§6), plus `app.bc` when the payload is placed by a
   linker section.
7. **Compile + link** with the chosen `cc`, one invocation, plus the cell's link libraries.
8. **Strip**, then **sign** if asked; report sizes and, with `-v`, every command.

Failure modes are part of the interface: a bundler error, a syntax error in a bundle, no `cc` for
the tuple, no network and no cached SDK, a stale SDK (marker mismatch), a signing identity missing
from the keychain. One actionable sentence each, exit 1; usage errors exit 2; the runtime's "ABI
mismatch" exit is 78.

### 3.3 The compiler lives in `ln-engine`

`ondec` does not shell out to `onde` to get bytecode. `ln-engine` has a compile module:

```rust
pub struct Options { pub name: String, pub strip_source: bool, pub endian: ln_abi::Endian }
pub fn module(source: &str, options: &Options) -> Result<Vec<u8>, CaughtError>;
pub fn module_name(bytes: &[u8]) -> Result<String, CaughtError>;
```

It parses with `JS_EVAL_FLAG_COMPILE_ONLY`, serializes with `Module::write` (source kept unless
`strip_source`), and runs in a dedicated `Runtime`/`Context` so `ondec`'s state is irrelevant.

One correction to the v5 draft: **the loader is called during compilation.** QuickJS resolves
every import in `js_eval_internal` even under `JS_EVAL_FLAG_COMPILE_ONLY` (the source carries the
comment "Could add a flag to avoid resolution if necessary"), and `JS_ReadModule` resolves the
module's imports again when bytecode is read back. So the compile engine installs an identity
resolver and a **stub loader** that declares an empty `export {}` module for any specifier. Nothing
is linked, so the stub's lack of exports is never consulted; what travels in the bytecode is the
import *specifier*, and the app's loader resolves it against the payload at run time.

`module_name` reads the name back out of the bytecode. It matters because QuickJS registers a
module by name: `ondec` compiles each asset as `file:///<key>`, and the runtime loader refuses
bytecode whose baked-in name disagrees with the table, instead of registering it under a name
nobody will ask for.

Because `ondec` and the SDK archive are built from the same commit, `BC_VERSION` and the atom table
match by construction; the stamp check is for the case where they are not (a stale download, a dev
build paired with a release archive).

## 4. SDK resolution

### 4.1 Cache layout

```
$XDG_CACHE_HOME/onde/sdk/<version>/<tuple>/onde.h
                                          libonde-<tuple>.a
                                          SHA256SUMS        (the verified copy)
```

The tool follows `$XDG_CACHE_HOME`, then `$HOME/.cache` (the same rule everywhere, including
macOS, so one environment variable moves it), and `$ONDE_SDK_CACHE` overrides the root. `--sdk
<dir>` bypasses the cache entirely; that is the route for an air-gapped machine and for a `onde`
built from a checkout, which has no matching release.

A local SDK for the host cell is one script away (`make sdk` runs it):

```console
$ ./scripts/build-sdk.sh
== building libonde.a (release, the profile the SDK ships)
== verifying the archive's engine identity
archive: dist/sdk/0.1.0/aarch64-apple-darwin/libonde-aarch64-apple-darwin.a
stamp:   ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=ef94ec99;
SDK ready: dist/sdk/0.1.0/aarch64-apple-darwin

$ target/release/ondec build app.js --sdk dist/sdk/0.1.0/aarch64-apple-darwin -o app
```

It writes the same three files a release publishes (header, correctly named archive, `SHA256SUMS`)
and verifies the archive against the tool it just built, so `--sdk dist/...` and a downloaded SDK
exercise the same code path. `dist/` is gitignored: an SDK is a build product, not a source file.

### 4.2 Download

```
GET <base>/v<version>/onde.h
GET <base>/v<version>/libonde-<tuple>.a
GET <base>/v<version>/SHA256SUMS
```

`<base>` defaults to the project's GitHub release URL and is overridable (`--sdk-base-url`,
`ONDE_SDK_BASE_URL`) so a team can mirror. The assets are immutable per tag. The transfer is
delegated to `curl -fsSL --retry 2` (it follows redirects to object storage, and Windows 10+ ships
`curl`); the digest is then checked against `SHA256SUMS` before the directory is used.
`ondec sdk install` is the explicit step for a machine that must pre-stage the SDK, and
`--no-fetch` turns a cache miss into an error that names the missing cell instead of touching the
network.

SHA-256 here covers the **transport and the cache**, not the finished app: it catches a truncated
download, a corrupted cache entry, and a mirror that serves the wrong bytes. Once the bytes are
linked into the executable they are indistinguishable from the rest of the program, and the
executable's own signature is the only boundary that matters — which is why the payload itself
carries no hash (§7).

Version selection is the one place where "the compiler must be the runtime" is enforced:
`onde`'s own version picks the SDK. A release build (`0.1.0`) maps to tag `v0.1.0`; a development
build (version contains `-dev`/`-dirty`, or `git describe` finds no tag) refuses to download and
requires `--sdk`, because there is no guarantee that a published archive has the same engine.

### 4.3 ABI stamp, without a manifest

Three things must match between the `ondec` that compiles the bytecode and the archive that runs it:

- `BC_VERSION` (28 today);
- the quickjs-ng **builtin atom table**, because const atoms are serialized as indices — inserting
  one atom with an unchanged `BC_VERSION` produced bytecode that failed at run time (`CALL FAILED`);
- endianness (quickjs-ng writes native-endian; every cell in the v1 matrix is little-endian).

`ln-engine/build.rs` computes the stamp once, through `crates/ln-abi`:

```
ONDE-ABI:1;qjs=<quickjs-ng version>;bc=<BC_VERSION>;endian=<le|be>;atom=<hex8>;
hex8 = FNV-1a 32 of the bytes of quickjs-atom.h
```

The hash is an **identity**, not an integrity check: it makes "same engine, same atoms" a compact
value that both sides can print, compare and put in a header. It is FNV-1a rather than SHA-256
because it must be computable identically by every build script with no dependencies, and because
the threat model is a stale archive, not a collision-finding attacker. The same 32 bits are the
`atom_hash` field in the payload header, so the runtime compares a number.

`endian` is taken from `CARGO_CFG_TARGET_ENDIAN` (the build script runs on the host, so
`cfg!(target_endian)` would be the wrong answer for a cross build). `format=1` is
`ONDE_ABI_VERSION`, and a difference there is a hard refusal for the C ABI's sake.

The static library carries that string verbatim (`ln-embed/build.rs`):

```rust
#[used]
#[no_mangle]
pub static ONDE_ABI_MARKER: [u8; 43] = *b"ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=ef94ec99;";
```

The array, not a `&str`, so the bytes are in `.rodata` whether or not the pointer is kept; verified
in the release archive (`strings libonde.a` finds it four times) and in the linked executable.

and the driver finds it with a **plain byte scan of the archive file** — `buffer.indexOf("ONDE-ABI:1;")`,
then parse up to the `;` that terminates `atom=`, validating the fields. No `nm`, no `object` crate,
no symbol table, no linker, no target execution. Verified: the marker appears verbatim in a
fat-LTO staticlib (`libmarker.a`, 6.2 MB, found at offset 238,036) and in a non-LTO one; `ar` and
`ranlib` do not touch member data. The scan must stop at the field terminator rather than a NUL,
because the next rodata object follows immediately with no padding.

The same string is what `onde_engine_stamp()` returns at run time, and its `bc_version`/`endian`/
`atom_hash` fields are what the payload header carries. A mismatch is therefore caught three times:
by `ondec` before writing a temp file, by the linker if someone mixes an incompatible archive
(missing or duplicate symbols), and by the library before it reads the payload.

---

## 5. Toolchain selection: compilers, linkers, libc

The tuple fixes the ABI — OS, libc, architecture. Inside that cell the user picks the compiler,
the linker it drives, and any sysroot. The archive itself is deliberately boring: a static library
of native objects for that cell (Rust `std`, `ln-runtime`, the quickjs-ng C objects, `ring`'s
assembly), in the platform's object format. It needs no LTO plugin, no special linker feature, and
no build-system integration beyond "link this file".

One distinction the rest of this section depends on: **musl is a libc, not a compiler.** It appears
twice, and the two are independent:

- as a **cell**: `aarch64-unknown-linux-musl` decides which archive to download;
- as a **toolchain**: `musl-gcc`, or `zig cc -target aarch64-linux-musl`, decides which C compiler
  emits the generated file and which linker combines it with the archive.

The archive must match the cell; any compiler that produces objects for that cell can be the
toolchain. glibc is the same story in reverse.

### 5.1 Resolution order

| tuple | archive | default extra link libs | compiler source |
| --- | --- | --- | --- |
| `aarch64-apple-darwin` | `libonde-aarch64-apple-darwin.a` | `-liconv` | `--cc`, else `CC_aarch64_apple_darwin`, else `cc` |
| `x86_64-apple-darwin` | `libonde-x86_64-apple-darwin.a` | `-liconv` | same pattern |
| `x86_64-unknown-linux-gnu` | `libonde-x86_64-unknown-linux-gnu.a` | `-lpthread -ldl -lm` (mostly implicit) | `--cc`, else `CC_x86_64_unknown_linux_gnu`, else `cc` |
| `aarch64-unknown-linux-musl` | `libonde-aarch64-unknown-linux-musl.a` | `-static` | same pattern |
| `x86_64-pc-windows-msvc` | `onde-x86_64-pc-windows-msvc.lib` | cell-recorded `.lib` set | `--cc` (e.g. `cl`), else `CC_x86_64_pc_windows_msvc` |

Resolution order, for every tuple:

1. `--cc <command>` (a full command, not a path; may include a wrapper such as `zig cc`),
2. `CC_<tuple with - → _>` (cargo's convention, so an existing cross setup already works),
3. for the **host tuple only**, `$CC` then `cc`.
4. otherwise: fail, printing `--cc` and the exact `CC_…` variable name.

The **compiler family** is a separate, explicit input because flag spelling depends on it:

```
--cc-family gcc | clang | zig | msvc      (default: derived from the tuple, never probed)
```

The default is `clang` for darwin, `gcc` for linux, `msvc` for windows-msvc; `zig` must be stated
because `zig cc` looks like clang to every `--version` probe and behaves differently at link time.
Nothing is discovered by executing the compiler with `--version` and guessing: a user who names
`clang` while `--cc` is MSVC gets a clear error from the linker, not a silently mangled command.

`--cflags`, `--ldflags`, `--sysroot` are appended verbatim, after the driver's own flags, so a user
can override a wrong default without patching onde. `--print-command` prints the final line, which
is also what the failure message shows. The command is always executed as
`spawn(program, argsArray, { stdio: "inherit", env })` — never through a shell, so paths with
spaces, `&`, or quotes work on every platform, and `--cc "zig cc -target …"` is split with a small
argv-aware tokenizer owned by the tool (quotes are honoured; no globbing, no variable expansion).

### 5.2 Compilers

| family | typical command | cells | what it gives us | what to watch |
| --- | --- | --- | --- | --- |
| **Apple clang** | `clang`, `cc` | darwin | the only compiler that finds the SDK and Apple's linker without wiring; verified here (clang 21) linking this archive | tied to Xcode; its linker choice is Apple's, not yours |
| **upstream LLVM clang** | `clang` from Homebrew/apt | linux, darwin | `--target`, `-fuse-ld=lld`, `--sysroot`; verified here (clang 23) linking the archive on macOS | on Darwin it still needs the Apple SDK, and Apple `ld` is safer than `ld64.lld` |
| **gcc** | `gcc`, `cc`, `<triple>-gcc` | linux-gnu, linux-musl (via `musl-gcc`) | the distro default; drives GNU ld, and `-fuse-ld=mold/lld` when it is newer than the linker | binutils must be new enough for the arch (arm64 relocations); old cross gcc is the usual cause of a confusing relocation error |
| **zig cc** | `zig cc`, `zig c++` | linux-gnu, linux-musl, windows-gnu | one binary carrying clang, lld and libc sources; the best cross story (`-target x86_64-linux-gnu.2.31` even selects a glibc version) | cannot supply the macOS SDK ([zig#16557](https://github.com/ziglang/zig/issues/16557)); Windows targets are GNU, not MSVC; its libc is zig's own build, so a glibc cell is "compatible with", not "built by", that glibc |
| **MSVC cl** | `cl` | windows-msvc | native Windows toolchain; `link.exe`; the cell's CRT contract | `/MD` (default) vs `/MT` must match the archive; `.lib`, not `.a`; `clang-cl` + `lld-link` can stand in |

Notes that matter in practice:

- **zig cc is the recommended cross compiler for Linux cells**, and the only one that needs no
  sysroot of ours: `zig cc -target x86_64-linux-musl` produces a static binary from a musl cell on
  any host. It is not a way to build the darwin or windows-msvc cells.
- **musl-gcc** is the native check that the musl cell is honest: if a build works with `zig cc` but
  not `musl-gcc`, the problem is usually a stray glibc flag (a `-lpthread` or `-ldl` that musl does
  not ship as separate libraries), not the archive.
- **gcc and clang on Linux are interchangeable for the C file**; they differ only in the linker
  they default to (GNU ld vs lld on some distros) and in warning flags. The driver's flag set is
  the intersection, with `--cflags`/`--ldflags` for the rest.
- **Apple clang is not required for Mach-O** — upstream clang with `-isysroot` works (verified) —
  but it is the path with the fewest surprises.

### 5.3 Linkers

The C compiler driver invokes the linker; the driver exposes that through `--ldflags`, and only
needs to know how to request a specific one.

| linker | platform | use it when | flags | notes |
| --- | --- | --- | --- | --- |
| **GNU ld (bfd)** | ELF | default everywhere; the compatibility floor | `-Wl,--gc-sections -Wl,-z,noexecstack` | slow on multi-hundred-member archives, but correct; needs a binutils that knows the arch |
| **gold** | ELF | — | — | deprecated upstream; do not recommend |
| **lld** | ELF, Mach-O (`ld64.lld`) | Linux: fastest correct default; Mach-O: only if you must | `-fuse-ld=lld` | the linker rustc itself uses on Linux; on Mach-O `ld64.lld` is less proven than Apple's `ld` |
| **mold** | ELF | large links, CI speed | `-fuse-ld=mold` | drop-in for GNU ld flags (`--gc-sections`, `-static`); Linux only |
| **Apple ld64 / ld-prime** | Mach-O | always on macOS | `-Wl,-dead_strip`; `-Wl,-sectcreate,…` | `ld-prime` is the default linker since Xcode 15; if it misbehaves with a link, `-Wl,-ld_classic` is the documented escape hatch |
| **link.exe / lld-link** | COFF | windows-msvc | `/DEBUG:NONE`; `.lib` | `lld-link` works with `clang-cl`; mingw's `ld` does not belong to this cell |

What the driver actually requires from a linker, and what it does not:

1. **Read the cell's object format** and resolve the archive. Every linker above does.
2. **No LTO plugin.** The SDK archive is built with `lto = "thin"`, and rustc still emits native
   objects next to the bitcode; verified: an archive of this kind links with Apple `ld` and with
   upstream clang on macOS. If a cell's linker ever refuses it, build that cell with `lto = "off"`
   — the release notes record which mode a cell used.
3. **Dead-code elimination is optional.** `--gc-sections` / `-dead_strip` cut a few hundred
   kilobytes from a real app; they are not needed for correctness.
4. **Section embedding is the only linker-specific feature.** `--embed=section` needs Mach-O
   `-sectcreate` (ld64/ld-prime) or an ELF `.incbin` (the assembler, not the linker). MSVC has no
   equivalent and the tool rejects the flag there.

### 5.4 libc and CRT rules

glibc cells:

- dynamic linking only. `-static` with glibc is not supported for a runtime that calls
  `getaddrinfo` (NSS loads modules) and may `dlopen`; glibc's own documentation says so. The
  `--static` flag is rejected for `*-linux-gnu`, with a message pointing at the musl cell.
- the archive carries a **glibc floor**: link against the target's sysroot if cross-building, and
  run only on hosts at or above the floor. Cell builds happen in a pinned old container (§2.1).
- `-lpthread -ldl -lm` are harmless and mostly implicit on modern glibc (2.34 merged libpthread).

musl cells:

- static by default; pass `-static`. musl has thread, dl and math in libc, so a leftover
  `-lpthread`/`-ldl` from a gnu template is at best a no-op, at worst an error with `musl-gcc`.
- DNS uses musl's own resolver (no NSS, no `/etc/nsswitch.conf` module loading) — a behavioural
  difference worth a line in the docs, not a build problem.
- the result is a fully static binary: no glibc floor, which is exactly why the cell exists.

macOS cells:

- libSystem; the only extra library is `-liconv`; `-mmacosx-version-min` should match the SDK
  cell's deployment target (the driver passes the cell's value unless `--cflags` overrides it).

Windows cells:

- MSVC CRT. The default cell is `/MD`; a `/MT` host needs a `+crt-static` cell, which is a separate
  release artifact, not a flag the driver invents.

Never mix, in any direction: a glibc archive with `-static`, a musl archive against glibc headers,
an `onde-*-msvc.lib` with mingw, or a 32-bit archive with a 64-bit compiler. The stamp catches
engine mismatches; the linker catches the rest, usually with a message worth translating (§5.6).

### 5.5 Support matrix

| cell | verified here | planned in CI | best effort | unsupported |
| --- | --- | --- | --- | --- |
| `aarch64-apple-darwin` | Apple clang 21 + ld64; upstream clang 23 + ld64; `-sectcreate`; `-dead_strip` | Apple clang + ld64 | upstream clang; Homebrew LLVM | gcc (no Darwin target) |
| `x86_64-apple-darwin` | — | Apple clang + ld64 (`-arch x86_64`) | as above | gcc |
| `*-unknown-linux-gnu` | — (no Linux host here) | gcc + GNU ld; clang + lld; gcc + mold | zig cc; clang + GNU ld | old binutils; any `-static` glibc link |
| `*-unknown-linux-musl` | — | musl-gcc + GNU ld; zig cc | clang + lld with a musl sysroot | linking with glibc objects |
| `*-pc-windows-msvc` | — | cl + link.exe | clang-cl + lld-link | mingw gcc |

The rule behind the table: the **cell** decides what is possible, the **compiler** decides what is
convenient, and the CI matrix only promises the first two columns. "Verified here" means a
prototype archive plus the generated C was linked and executed on this machine; it is evidence that
the toolchain family works, not a promise about a released cell. Anything outside the CI columns
still works if the user says so, and `--print-command` is what they paste into a bug report.

### 5.6 Failure modes worth translating

| message | cause | fix |
| --- | --- | --- |
| `version 'GLIBC_2.34' not found` at run time | archive built against a newer glibc than the host | use the musl cell, or the cell built for the older floor |
| `cannot find -lpthread` (musl) | gnu link libs applied to a musl cell | drop `-lpthread`/`-ldl`; add `-static` |
| `unrecognized relocation` / `relocation truncated` | binutils too old for arm64 objects | newer binutils, or `-fuse-ld=lld` |
| `duplicate symbol '__rust_alloc'` (or thousands of others) | two Rust static libraries in one link | link only onde, or merge the other library into the same archive |
| `LNK2038: mismatch detected for 'RuntimeLibrary'` | `/MT` C object against an `/MD` archive | build the C file `/MD`, or use a `+crt-static` cell |
| `ld: warning: ignoring file …, building for macOS-arm64 but attempting to link with file built for macOS-x86_64` | wrong arch cell | pass the matching `--target` |
| `error: unable to find libSystem` (zig) | zig has no macOS SDK | build darwin cells with Apple clang |
| `ld-prime` crash or malformed `LC_DYSYMTAB` | Apple's new linker on unusual input | `--ldflags -Wl,-ld_classic` |

### 5.7 Worked examples

```console
# host tuple, host compiler
ondec build app.js -o app

# cross to x86_64 Linux (glibc) with zig as the C toolchain
ondec build app.js --target x86_64-unknown-linux-gnu --cc-family zig \
    --cc "zig cc -target x86_64-linux-gnu.2.31" -o app-linux

# fully static musl binary, cross-compiled with zig
ondec build app.js --target aarch64-unknown-linux-musl --cc-family zig \
    --cc "zig cc -target aarch64-linux-musl" -o app-arm64

# cross with a sysroot and an explicit compiler (musl-gcc family)
ondec build app.js --target aarch64-unknown-linux-musl --cc-family gcc \
    --cc aarch64-linux-musl-gcc --sysroot /opt/musl-aarch64 -o app-arm64

# Linux host, fastest link
ondec build app.js --target x86_64-unknown-linux-gnu --ldflags -fuse-ld=mold -o app
```

## 6. The generated C file

Written to a temp directory created with `fs.mkdtempSync(path.join(os.tmpdir(), "onde-build-"))`
and removed on success unless `--keep-temp`; the payload is written as one `Buffer` (the C array is
generated in 16-byte lines, so a 6 MB file is a string join, not 6 million `write` calls).

### 6.1 Default: bytecode array

```c
/* generated by ondec build 0.1.0 — target x86_64-unknown-linux-gnu */
#include "onde.h"

static const unsigned char onde_payload[] = {
    0x1c, 0x19, 0x84, 0xf4, /* … */
};

int main(int argc, char **argv) {
    return onde_main_payload(onde_payload, sizeof onde_payload, argc, argv);
}
```

Portable across every cell and every compiler, seals into the image (so signing just works), and
costs about 6× the payload in C text (1 MB of bytecode is ~6.1 MB of source and compiles in
0.2–0.7 s). This is the v1 default.

### 6.2 `--embed section`

Payload outside the C file, placed by the linker:

- **Mach-O**: `-Wl,-sectcreate,__DATA,__onde,app.bc`; read with
  `getsectiondata(&_mh_execute_header, "__DATA", "__onde", &size)` (verified: 192-byte payload read
  back and executed).
- **ELF**: a 6-line generated `payload.S` with `.section .onde,"a"` and `.incbin "app.bc"`, plus
  `extern const unsigned char onde_payload_start[]`, `onde_payload_end[]`; or `ld -r -b binary`
  where GNU ld is available.
- **MSVC**: no `.incbin`; use `#pragma section` + `__declspec(allocate(".onde"))`, or keep the
  array. `--embed=section` on MSVC is rejected rather than silently downgraded.

With ELF `--gc-sections`, the generated C must reference the start/end symbols, otherwise the
linker can discard an otherwise unreferenced allocation section; the generated file does exactly
that. On Mach-O, `-sectcreate` sections are not candidates for `-dead_strip`. On Apple silicon the
linker emits an ad-hoc signature for the output; that is what makes the freshly built binary run,
and a Developer ID signature replaces it (section 9).

The section matters for large payloads (debug builds with source can be several MB) and for hosts
that want to replace the payload without recompiling C, not for signing.

### 6.3 Where the payload lives at runtime

There is exactly one entry point: the generated `main` passes the array (or the section range) to
`onde_main_payload`. No weak symbols, no link-time symbol ranges that differ between Mach-O, ELF
and COFF, and no second entry-point name to document; a C host that embeds onde calls the same
function with its own buffer. The array is `static` in the single generated translation unit, which
is what keeps it in the image on every compiler.

---

## 7. Payload format

The payload is a flat key/value map — the VFS — keyed by relative path, plus one entry:

```
header (36 bytes, little-endian, byte-packed)
  magic "ONDEPAY\0" | format u16 | flags u16
  bc_version u8 | endian u8 | reserved u16
  atom_hash u32             // same 8 hex as the ABI marker; identity, not integrity
  module_count u32 | entry_index u32 | table_offset u32
  total_len u32             // payload bounded to 4 GiB

table entry
  key_len u16 | key (utf8, POSIX, relative: "index.js", "worker.js", "chunks/a.js")
  kind u8                   // 1 = esm-bytecode, 2 = esm-source
  flags u8
  offset u32 | len u32

bodies                      // or: one zlib stream of table+bodies (flags bit 0)
```

Rules:

- Keys are exactly the bundler's asset filenames relative to the outbase: POSIX separators, no leading `./`.
  The map is flat; directories exist only as prefixes inside a key, which is all the resolver needs.
- Names visible to JS are those keys: `__filename = "worker.js"`, `__dirname = "."` at the root,
  `import.meta.url = "file:///worker.js"`, and stack traces read `worker.js:3:12`. There is no
  `app:///` scheme and no synthetic mount path — a key is just the name the bundler gave the file,
  and `file:///<key>` is its URL form (so `fileURLToPath` yields `/worker.js`).
- Both kinds are ES modules: kind 1 is loaded with `Module::load` from bytecode, kind 2 is
  declared from source (`--no-bytecode`, for diagnosing a bytecode problem). There is no CJS
  payload kind, because the frontend emits one format (§8.3).
- `import.meta.url` is a **name**, not a filesystem location: turning it into a path and calling
  `fs` reads the host filesystem, because only the module loader consults the table. If embedded
  assets are ever added, the keys become a virtual fs layer instead.
- **Compression: off by default, and the codec is a choice.** `--compress none|zlib[:level]|
  zstd[:level]`; the header carries the codec id in its flags next to the "compressed" bit, so a
  payload says how to read it before any decoder runs. The stream covers everything after the
  36-byte header, and the runtime rebuilds the image from the header plus the inflated body with
  the compressed bit cleared before parsing it. `total_len` always describes the uncompressed
  image.

  Measured (§7.1), on a 3.8 MiB payload (a 30,000-function app) and a 147-byte payload:

  | payload | executable | startup | note |
  |---|---:|---:|---|
  | bare | 8.85 MB | **39.6 ms** | fastest, largest |
  | zlib:6 | 5.62 MB | 48.8 ms | dominated |
  | zlib:9 | 5.58 MB | 48.9 ms | dominated; zlib's levels produce the same size |
  | zstd:3 | 5.54 MB | 44.4 ms | |
  | zstd:9 | 5.50 MB | 44.6 ms | |
  | zstd:19 | **5.25 MB** | 45.3 ms | smallest, still faster than zlib |

  On a 147-byte payload every codec starts in 20.4–21.7 ms: the difference is noise, and the only
  cost is the decoder in the image — **+249 KB** (4.54 MB → 4.79 MB) when the archive carries
  zstd, paid whether or not the payload is compressed. zlib costs nothing extra because the SDK's
  `zlib-payload` feature already links `flate2` for this decoder.

  **The decision.** Bare is the default (`--compress none`): startup is what small tools feel, and
  a bare payload is the fastest and makes the 147-byte app cost nothing. zlib stays available
  because it is free — `flate2` is already in the image for `zlib-payload` — and it is the codec to
  pick when even the zstd decoder's bytes are unwanted. zstd is the size option: `zstd:9` by
  default, `zstd:19` when the executable is the thing that matters, and both decode faster than
  zlib. The zstd decoder lives in the one archive (+249 KB, 5.5% of a 4.5 MB app).

  The split was considered and deferred: `libonde-zstd-<tuple>.a`, linked only for compressed
  payloads, would give bare and zlib apps their 4.54 MB back. It needs the runtime to reach the
  decoder through a registered function pointer (no weak symbols on stable Rust) plus
  `-Wl,-u,<anchor>` so the linker pulls the shim archive, a third artifact per cell, and a second
  error path. That is a real 249 KB for apps that will mostly be bare, but it is 5.5% of a binary
  that is already dominated by the engine, and the complexity lands in the release matrix. If the
  percentage ever matters, this paragraph is the design.

  One implementation note: the runtime decodes straight into the payload image (header first, body
  appended into the same `Vec`), so a 3.8 MiB payload is one allocation instead of two and the
  copy is gone. Measured startup did not move beyond noise (the decode itself dominates), but the
  peak RSS during startup drops by the body size.

### 7.1 Measurements behind the codec choice

| codec | payload | ratio | compress | decompress |
|---|---:|---:|---:|---:|
| zlib -1 | 558,100 | 3.53× | 4.8 ms | 2.83 ms |
| zlib -6 | 556,368 | 3.54× | 48.2 ms | 2.24 ms |
| zlib -9 | 558,973 | 3.53× | 154.5 ms | 2.30 ms |
| zstd -3 | 533,734 | 3.69× | 1.8 ms | 0.89 ms |
| zstd -9 | 519,727 | 3.79× | 9.5 ms | 0.92 ms |
| zstd -19 | 383,890 | 5.13× | 535 ms | 1.31 ms |
| zstd -3, `ruzstd` | 533,734 | 3.69× | — | 4.39 ms |

1,971,227 bytes of QuickJS bytecode, in-process release build, best of three batches, one `Vec`
per decode. The pure-Rust decoder (`ruzstd`) is twice as slow as zlib, so it is not an option if
the "no run-time cost" rule is taken seriously; libzstd's decoder is what the numbers above use.
- **Source policy:** bytecode keeps the module source by default. `JS_WRITE_OBJ_STRIP_SOURCE` alone
  keeps line/column and loses `Function.prototype.toString` and error excerpts; stripping debug
  loses stack locations entirely (`<null>:0:1`). `--strip-source` exists for size emergencies,
  `--no-bytecode` for diagnosing a bytecode problem.
- **No checksum in the payload.** It is linked into the executable, so its integrity is the
  executable's integrity: the platform's code signature (or the file's permissions) is the
  boundary, and an attacker who can rewrite the payload can rewrite the check too. A hash here
  would only catch a build-tool bug, which the tool catches itself before writing the C file.
  The header keeps `bc_version`, `endian` and `atom_hash` because those are **compatibility**, not
  integrity: loading bytecode from another engine is unsafe and must fail fast (section 4.3).
- **Structure is still validated, cheaply and at build time.** `ondec` checks its own payload
  (magic, format version, every table offset/length inside the body region, `entry_index` in range,
  `total_len` consistent) before emitting `app.c`. At run time the runtime re-checks the same
  O(1) invariants, because `JS_READ_OBJ_BYTECODE` is unsafe on truncated or malformed input and a
  clear "bad payload" beats a crash — but that is a guard against bugs and corruption, not a
  security boundary.
- v1 embeds modules only. Static data files are out of scope; `fs` reads the real filesystem.

### 7.2 Runtime semantics in compiled mode

- `process.argv` is `[exec_path, exec_path, ...user args]`: there is no script path, so `argv[1]`
  repeats `argv[0]`, exactly as Node SEA does. `process.execPath` is the binary.
- `import.meta.url = "file:///<key>"`, `.filename = key`, `.dirname = dirname(key)` (`"."` at the
  root), `.main` true for the entry, `.resolve` still works.
- Everything the module loader sees is either a builtin or a key; a missing key is
  `ERR_MODULE_NOT_FOUND` with the specifier and the importer in the message.
- The compiled app does no parse at startup: every module arrives as bytecode (kind 1). Changing
  the module source means rebuilding, which is the point.
- These divergences are recorded in `docs/compat.md` rather than discovered by users.

---

## 8. The frontend: rolldown

### 8.1 Choosing a bundler

| option | in-process? | verdict |
| --- | --- | --- |
| **esbuild** | no | written in Go; there is no Rust binding. The `esbuild-rs` crate is a wrapper that spawns the esbuild binary, so "internal dependency" would be false and every build would need Node or a downloaded tool |
| **oxc** | yes | the parser / transform / minifier toolkit this repo already uses at build time — not a bundler. `oxc_bundler` is not published on crates.io; the bundler role moved to rolldown |
| **rolldown** | yes | Rollup-compatible bundler built on oxc, published as a Rust crate (1.3.2), the bundler behind Vite. **Chosen.** |
| **swc_bundler** | yes | published (59.0.0), but aimed at ES-module output and with no Node platform preset; the CJS path would be ours to build |

So the "essential complexity" is one crate dependency, not a child process: `ondec` links rolldown
and calls it in-process. That is the whole reason the toolchain is a separate binary (section 3):
a bundler dependency belongs in a build tool, not in the 5.3 MB runtime.

### 8.2 API

As built (`crates/ondec/src/frontend.rs`, rolldown 1.3.2):

```rust
use rolldown::{Bundler, BundlerOptions, CodeSplittingMode, InputItem, OutputFormat, Platform};

let mut bundler = Bundler::new(BundlerOptions {
    input: Some(vec![
        InputItem { name: Some("src/main".into()),   import: "src/main.js".into() },
        InputItem { name: Some("src/worker".into()), import: "src/worker.js".into() },
    ]),
    cwd: Some(project_root.clone()),
    platform: Some(Platform::Node),
    format: Some(OutputFormat::Esm),
    dir: Some("out".into()),                                  // virtual: only filenames matter
    entry_filenames: Some("[name].js".into()),                // keeps `src/main.js` as the key
    chunk_filenames: Some("chunks/[name]-[hash].js".into()),
    code_splitting: Some(CodeSplittingMode::Bool(splitting)),
    sourcemap: sourcemap.then_some(SourceMapType::File),
    minify: minify.then_some(RawMinifyOptions::Bool(true)),
    ..Default::default()
});

let output = block_on(bundler.generate())?;   // BundleOutput { assets: Vec<Output>, warnings }
```

Three details the draft got wrong or left open, now measured:

- **`generate()` is `async` and needs a runtime.** A current-thread tokio runtime is enough; it adds
  no scheduler of this project's own. `write()` is not used: the payload wants bytes in memory, and
  `--keep-temp` keeps the *generated C and payload*, which are the interesting artifacts.
- **Multiple inputs force code splitting.** rolldown rejects `code_splitting: false` with more than
  one input, so `--entry` implies it; `--splitting` remains the opt-in for a single entry whose
  dynamic imports should become chunks.
- **`Output` lives in `rolldown_common`, not `rolldown`.** The `rolldown` crate re-exports bundler
  options only; naming the output enum needs the companion crate at the same version.

### 8.3 Always ESM

`platform: Node` + `format: Esm` is deliberate:

- rolldown supplies `__dirname` and `__filename` to bundled **CommonJS** modules through
  `import.meta.dirname`/`import.meta.filename`
  ([bundling CJS](https://rolldown.rs/in-depth/bundling-cjs)), so the main reason to keep a CJS
  output disappears;
- `require()` of externals, including node builtins, is rewritten into ESM imports by rolldown's
  built-in [`esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require),
  which `ondec` enables for the Node platform, so `require("node:fs")` in a CJS app still works;
- therefore the payload has **one** kind (`esm-bytecode`), the runtime has **one** load path, and
  there is no `--format` flag and no CJS wrapper bytecode.

The CJS behaviours that cannot survive hoisting are documented rather than papered over: a computed
`require(expr)` is not statically known; a lazy `require("external")` becomes an eager import; and
`require.main` / `module.parent` / `require.cache` reflect rolldown's CJS emulation rather than
onde's loader.

One of those is not rare, and it is worth naming precisely because it produces a **silent**
failure. A CJS CLI usually ends with `if (require.main === module) main()`. After conversion to ESM
there is no `module`, so `__require.main === module` is false and the program exits 0 having done
nothing — verified with Node running the same bundle, so this is the CJS→ESM conversion, not onde.
`ondec` therefore rewrites that exact guard in the **entry chunk only** to `true` and prints a
warning; a compiled entry is the main module, so that is the honest value. Two things follow:

- the rewrite is a bridge, not the design. It is a text substitution on generated code, scoped to
  the entry and to the three spellings of the guard (`__require.main === module`,
  `require.main === module`, `module === require.main`).
- the principled fix is a **CJS payload kind**: bundle a CJS entry as CJS, store it as such, and
  run it through the runtime's existing CommonJS loader (which sets `require.main` properly).
  That reverses "always ESM" for the entry only, and is the right follow-up if CJS CLIs keep
  hitting the boundary.

The first real package built this way — `vibe-cpc`, a TypeScript interpreter distributed as a
338 KB CJS bundle — is exactly this shape, and it is why the rewrite exists.

### 8.4 Output mapping

- Each `Output` becomes a payload entry. Its key is the asset filename relative to the project
  root (the nearest `package.json`, or `--outbase`), POSIX separators, no leading `./`
  (`src/main.js`, `src/worker.js`, `chunks/a.js`).
- The asset whose `name`/`entryPoint` is the main entry is the payload entry.
- Ordering is deterministic; the table is sorted by key before encoding, so two builds of the same
  input produce the same payload bytes.

### 8.5 Workers and extra entries

- `ondec build src/main.js --entry src/worker.js` puts both in `input`. The outputs are
  `src/main.js` and `src/worker.js`, so `new Worker("./worker.js")` from the entry resolves to the
  key `src/worker.js` after normalisation.
- The specifier must equal the produced key relative to the importing module. `new
  Worker("./worker.js")` and `new Worker(new URL("./worker.js", import.meta.url))` both work;
  `new Worker("./src/worker.ts")` does not, because rolldown does not rewrite strings. The help
  text says so.
- A worker entry is compiled like any other module and evaluated in a fresh isolate, from the same
  table, never from disk.

### 8.6 Dynamic import and code splitting

- Default: no splitting; rolldown inlines a literal `import("./x.js")` into the bundle.
- Splitting is opt-in (`--splitting`); chunks are assets like any other, so they become keys and
  `import()` resolves them through the same table. The runtime needs no special case.

### 8.7 Resolution in a compiled app

| specifier | result |
| --- | --- |
| `node:fs`, `fs`, any builtin | builtin module, as today |
| `./worker.js`, `../lib/x.js`, `/worker.js` | normalise against the importer's key, look up the table |
| bare `lodash` (made external explicitly) | not found: `ERR_MODULE_NOT_FOUND` |
| anything not in the table | not found |

There is deliberately **no disk fallback for modules** in compiled mode: a "standalone" build that
silently reads a file from the build machine is not standalone, and the error names the missing
key. `onde app.js` keeps resolving from disk exactly as today; this is a separate mode. `fs` still
reads the real filesystem — that is the app's decision, not the module loader's.

### 8.8 Determinism, source maps, tsconfig

- rolldown's output is deterministic for a given version and input; the payload sorts its table, so
  byte-identical builds are a testable property. CI pins the rolldown version and prints it under
  `-v`.
- Source maps: rolldown can emit one, but the error renderer does not consume it yet. Bytecode
  keeps the bundle text, so stack traces point into the bundle (`src/main.js:41`). Documented
  limitation, source-map consumer as a follow-up.
- TypeScript/JSX: rolldown's loaders handle them; a `tsconfig.json` is read for `paths` where
  present. No separate transpile step.

## 9. Signing

Signing is a post-link step, never something the library or the payload knows about.

```
--sign none                      (default)
--sign codesign:<identity>       macOS: codesign --force --options runtime --timestamp --sign <id>
--sign signtool:<cert>           Windows: signtool sign /fd SHA256 /tr <ts> /td SHA256 /c <cert>
--sign @<template>               anything else: the template with {output} substituted
```

Order is fixed: compile → link → strip → sign → report. Each signing step is a
`child_process.spawn` with an argv array, `stdio: "inherit"`, so the tool's output and warnings are
visible and the exit code is honoured. The `wrappe` backend moves the step: the files it extracts
are the ones that are loaded, so the staged runtime and every staged native file are signed before
packing (Appendix D.4), and the outer artifact is signed after, if at all. `ondec build` prints the
command it runs (identity names are not secrets, but certificates and PFX passwords are: those come
from the environment or the keychain, never from the command line). The macOS identity in v1
carries no entitlements by default; QuickJS does not need JIT entitlements.

---

## 10. Cross-building

The driver only has to invoke a compiler; the hard part lives in the release matrix and in the
toolchain choice described in section 5. The rules:

- each cell is built in CI on its target (or with `zigbuild`/`cross`) from the same commit, and the
  engine stamp is asserted identical across all cells;
- glibc floors and the musl/static story are recorded per cell (§2.1, §5.4);
- the bytecode is generated by the **host** `onde` and consumed by the **target** archive. That is
  safe because both are built from the same quickjs-ng source, the format is little-endian,
  pointer-size-neutral for module bytecode (no SharedArrayBuffers in an app blob), and stamped;
- a cross build is always explicit: `--target <tuple> --cc <compiler> [--cc-family …] [--sysroot …]`.
  `zig cc` is the low-friction path for the Linux cells; cross gcc works when a sysroot is already
  installed; the darwin and windows-msvc cells need their native toolchains (Apple clang, MSVC or
  clang-cl).

Nothing about the target is auto-detected, exactly like cargo: the tuple is the contract.

---

## 11. Work in this repo

| Piece | Where | Status |
| --- | --- | --- |
| Engine identity | `crates/ln-abi` | done: `Stamp` read from the vendored sources, encode/parse/compare, FNV-1a atom hash |
| Stamped engine + compiler | `crates/ln-engine` (`build.rs`, `src/compile.rs`) | done: `engine_stamp()`, `compile::module` with a stub loader, `eval_module_bytecode` |
| Payload format | `crates/ln-payload` | done: `Builder`, `Payload::parse`, structural checks, `resolve_key`, `compress` |
| Compiled mode | `crates/ln-runtime/src/modules.rs`, `lib.rs` | done: payload resolver/loader, `Config::payload`, `Isolate::run_payload`, exit 78 |
| C ABI | `crates/ln-embed` (`staticlib`), `include/onde.h` | done: `onde_main_payload`, `onde_engine_stamp`, `onde_version`, `#[used]` marker |
| `ondec` | `crates/ondec` | done: clap CLI, rolldown frontend, payload encoder (bare/zlib/zstd), generated C (array/section), `cc`/link/strip/sign, `--print-command`, `-v` |
| SDK | `crates/ondec/src/sdk.rs` | done: `--sdk`, cache, `curl` download, `SHA256SUMS`, archive scan, `sdk list/install/path/verify` |
| Wrappe backend | `crates/ondec/src/wrappe.rs` | staged: copies the runtime, modules at their keys and `--asset` inputs, then spawns wrappe. The invocation follows wrappe 1.0.6's documented CLI and has **not** been run against a wrappe install |
| Compiled-mode semantics | `crates/ln-runtime` | done for ESM/CJS entries, builtins, keys, `import.meta`; workers still start from a file (§7.2's worker note) |
| Release matrix | CI | one cell (`aarch64-apple-darwin`) proven by `test/standalone/run.sh`; the other seven cells, `onde-<tuple>` and `ondec-<host>` artifacts, and the per-backend smoke jobs are not wired yet |

Tests that pin the feature:

| test | what it proves |
| --- | --- |
| `crates/ln-abi` unit tests | the stamp round-trips, survives a byte scan, rejects garble, and the real vendored engine reads as `qjs=0.17.0;bc=28` |
| `crates/ln-engine/tests/bytecode.rs` | a compiled module runs from bytecode, keeps its name, carries `import.meta`, and a name mismatch is refused |
| `crates/ln-payload` unit tests | round-trip, determinism, key rules, every corruption path, compressed framing |
| `crates/ln-runtime/tests/payload.rs` | an isolate runs a payload from keys only, `import.meta`/argv semantics, exit 78 on a stamp mismatch, missing key is `ERR_MODULE_NOT_FOUND` |
| `crates/ondec` unit tests | tuple parsing/refusals, toolchain resolution and flag policy, `emit` output, sign specs, payload encoding, frontend bundling (ESM, CJS, multi-entry) |
| `crates/ondec/tests/e2e.rs` | the real binary builds real apps and they run after the project and SDK are deleted; `--embed section`, `--compress`, `--no-bytecode`, `--strip-source`, `--print-command` |

Phases, as executed:

- **P0 — done.** Stamp, `ln-engine` compile API, payload format, compiled-mode loader, `ln-embed`.
  The golden test is `crates/ln-runtime/tests/payload.rs`: compile → encode → `run_payload`.
- **P1 — done.** `ondec` for the host cell with `--sdk <dir>`: rolldown frontend, keys, payload,
  emit, `cc`, link, strip, `--sign codesign:`, `--print-command`, report. Acceptance met
  (`test/standalone/run.sh`), including ESM and CJS fixtures and a stamp mismatch that names both
  sides.
- **P2 — mostly done.** `sdk list/install/path/verify`, cache, `curl` download, `SHA256SUMS`,
  archive scan, `--target` with explicit `--cc`/`CC_<tuple>`. Not done: running it against a real
  GitHub release, and the first cross cell.
- **P3 — partially done.** `--entry` and chunk keys work (multi-entry forces splitting, and chunks
  become keys); the `ERR_MODULE_NOT_FOUND` diagnostics name the importer and the key that was
  tried. Not done: `worker_threads` entries resolved through the payload.
- **P4 — staged.** The wrappe backend exists and stages correctly; its CLI invocation is unverified
  until someone runs it against wrappe 1.0.6.
- **P5 — partially done.** `--embed section` (Mach-O `-sectcreate`, ELF `.incbin`) and `--compress`
  work; `docs/compat.md` gains the compiled-mode section; the rest of the matrix is open.

Acceptance for the whole feature: on a machine with `ondec` and a C compiler, `ondec build app.js
--target <host>` produces a binary that runs after the project directory (and the SDK cache) is
deleted; `--print-command` is a faithful description of what ran; every cell in the matrix builds
and runs a hello-world app in CI; and `ondec build --packager wrappe` produces a self-extracting
binary that runs on a machine with neither a compiler nor the SDK, as documented in Appendix D.

## 12. Runtime performance guardrails

The build pipeline may cost build time and tool size. It may not cost **run-time** performance. That
is a rule with tests, not a preference.

This section governs the **link** backend, the default. The `wrappe` backend exists precisely to
trade run-time performance for a compiler-less build (Appendix D); its numbers are reported in the
same table but it is not gated, because the trade is the point.

### 12.1 What bytecode buys (measured)

| module | parse + eval | bytecode load | load + eval |
| --- | --- | --- | --- |
| 247 KB, 4k functions | 22.8 ms | 1.0 ms | 1.5 ms |
| 1.88 MB, 30k functions | 786 ms | 5.2 ms | 9.1 ms |

The ratio holds and improves with size: bytecode load is roughly 20–150× cheaper than parsing, so
a compiled app always starts faster than the same sources under `onde`. A small app (tens of KB)
gains a millisecond or two; a bundled app (hundreds of KB to megabytes) gains tens to hundreds of
milliseconds. That is the only performance claim the feature makes, and it is in the gate (§12.3).

### 12.2 Rules

1. **Bytecode is the default.** `--no-bytecode` exists to diagnose a bytecode problem; it is not a
   shipping mode.
2. **Performance build profile for every SDK cell.** `opt-level = 3`, `lto = "thin"`,
   `codegen-units = 1`, `panic = "abort"`. No `opt-level = "z"`, no size-oriented LTO choice, no
   codegen flag changed to shrink the archive. A bigger `.a` is acceptable; release downloads carry
   a gzip next to the archive.
3. **No compression by default.** `--compress` saves 3–4× of payload size and costs ~1.4 ms/MiB of
   inflate before the first module is read. Opt-in, with the number documented.
4. **No extraction, no staging at run time.** The payload lives in the image's read-only data and
   `JS_ReadObject` reads it in place (`JS_READ_OBJ_ROM_DATA`). No temp directory, no unzip to disk,
   no self-extraction, no file I/O before the app starts.
5. **One hash-map lookup per import, not a VFS layer.** Compiled mode replaces "resolve against
   the filesystem" with "normalise the key, look it up in a sorted table"; there is no path walk,
   no `stat`, no open. Builtins take exactly the path they take today.
6. **No integrity hash in the payload.** The payload is part of the image; a hash would protect
   nothing that the executable's signature and file permissions do not already protect, and an
   attacker able to rewrite the payload can rewrite the check. The O(1) structural checks
   (magic, version, bounds, `atom_hash`) stay because they turn a malformed build into a clear
   error instead of a crash; see §7.
7. **No minification by default.** `--minify` can shrink the payload but makes stack traces worse
   and is a separate, measured trade; it stays opt-in.
8. **The bundler's output shape is the app's code.** rolldown's CJS helpers can be faster or slower
   than the original module graph; that is why the gate below includes a CJS fixture, not just ESM.

### 12.3 The gate

CI builds a fixture set (hello, a CJS app using `__dirname`/`require`, a 1–2 MB synthetic bundle,
the `test/bench` corpus) twice: once as `onde <source>` and once via `ondec build` + run. It fails
on:

- cold start slower than the source run by more than 2%;
- throughput on the bench corpus below the source run by more than 2%;
- payload larger than 3.5× the bundled source (a bundler pacing check, not a runtime one);
- `ondec` over 25 MB (warn) or 100 MB (fail).

The first two are the promises: the compiled app must start no slower than `onde` on the same
sources — in practice it starts much faster — and it must not be slower once running.

## 13. Risks

- **glibc floor.** A glibc cell built on a new distro will not run on older ones. Pin the build
  image and publish the floor; point people at musl for portable Linux binaries.
- **Archive size.** The performance profile yields a larger archive than a size-oriented one; the
  release compresses each cell for download (`libonde-*.a.gz`), and the per-app payload is separate.
  Never shrink the profile to shrink the artifact: §12 sets the rule.
- **Tool size creep.** Each rolldown bump adds crates; `ondec` has a 25 MB budget and a 100 MB hard
  gate in CI, and its size never affects the app's size or speed.
- **Two Rust static libraries.** Documented in the header; a host that links another Rust staticlib
  gets duplicate symbols. A `cdylib` for the other library is the workaround.
- **Atom-table drift.** The stamp catches it; the CI matrix check keeps the cells honest. Any
  quickjs-ng bump must rebuild every cell and bump the SDK version.
- **Debug-build stack, single huge module.** A ~1.9 MB module with tens of thousands of top-level
  declarations overflows the default 2 MB spawned-thread stack inside oxc's analysis when `ondec`
  is built without optimisations (release builds are fine; a bare `rolldown` probe reproduces it,
  so it is the bundler's frame size). `ondec` raises `RUST_MIN_STACK` to 16 MB before spawning
  anything, which costs address space and not memory, and keeps `cargo run -p ondec` usable on a
  big bundle. If a future rolldown needs more, the failure is loud (Rust aborts on overflow).
- **Bytecode trust.** `JS_READ_OBJ_BYTECODE` is explicitly unsafe against hostile input. Only the
  payload the tool generated is ever loaded; there is no "run a .bc file" command. Integrity is the
  executable's signature, not a hash in the payload (§7, §12).
- **Toolchain variance.** `clang`, `gcc`, MSVC and `zig cc` differ in flag spelling, default
  linker, and libc assumptions; section 5 is the contract, and `--cc-family` makes the family an
  explicit input instead of a guess. The per-cell flag table must stay small, with
  `--cflags`/`--ldflags` as the escape hatch. The tool tokenises `--cc` itself, so quoting rules
  are documented and unit-tested.
- **Linker drift.** GNU ld on an old distro, `ld-prime` on new Xcode, and mold/lld versions all
  change behaviour on unusual input (section 5.6). CI links every cell with its documented
  default linker, and the release notes name the linker used.
- **rolldown is a young dependency.** 1.3.x is the first stable line; its Rust API is less
  documented than the JS one and fields can move between minors. Pin an exact version, keep the
  frontend behind a small `Frontend` trait (`bundle(inputs) -> Vec<Asset>`), and treat an upgrade
  as a code change with a fixture-corpus run, not a `cargo update`.
- **CJS→ESM caveats.** Bundling CJS to ESM is what removes the second payload kind, but a computed
  `require(expr)` cannot be hoisted and a lazily-required external becomes an eager import.
  Documented per case; a hard error where rolldown can see it.
- **Bundle-level stack traces.** Bytecode embeds the bundle, so errors point at bundled line
  numbers, not the original files. Acceptable for v1; a source-map consumer is the follow-up.
- **Two artifacts in lockstep.** `ondec <version>` and the SDK must come from the same tag; the
  stamp rejects a mix, and the release publishes both. A user who keeps an old `ondec` gets a clear
  error rather than a corrupt binary.
- **Two packagers, one frontend.** The wrappe backend is user-visible and must be documented as
  such: it is not a fallback for a broken link build, it is a different trade. Keep the backend
  boundary explicit (same staged assets, different packager) so a fix or feature does not have to
  be implemented twice.
- **`ondec` build weight.** Linking rolldown (oxc + tokio) and quickjs makes `ondec` a large binary
  with a slow first build. That is the point of a separate tool; keep its dependency set closed and
  do not let it leak into `onde`.
- **Signing.** Account-bound for macOS notarization and Windows certificates; keep credentials out
  of the tool, print commands, document the order (sign last).
- **Windows CRT.** `/MD` vs `/MT` is a real footgun; the cell must declare its CRT and the driver
  must not mix.

---

## 14. When to build it

**Built in M7** (v6, above): M6 had landed, the engine was pinned, and the bytecode snapshot work
shared the emitter and the loader. The reasoning below is kept as the record of why that window and
not another.

**Recommended window: M7, immediately after M6; promoted to default in M9.** Not before M6, not
deferred past 1.0.

### 14.1 Why not now

- **M6 replaces the engine build.** It vendors a patched quickjs-ng (job-queue hook, `rquickjs-sys`
  via `[patch.crates-io]`). That patch touches the engine's atoms and its build, so the
  `BC_VERSION`/atom hash changes: every SDK cell and every payload produced before M6 is invalid.
  Rebuilding the matrix is the expensive part of this feature, not the code, so paying for it twice
  is the one thing to avoid.
- **No release matrix exists yet.** The feature's output is only as good as the per-cell builds and
  their smoke tests; building the tool before the CI that validates it produces an unverifiable
  SDK.
- **No consumer.** A matrix with no users rots. `tuckbox/` exists because a real workload forced the
  module system to be honest; the first compiled app should play the same role.

### 14.2 Why M7

- M7 already plans "bootstrap + stdlib compiled to bytecode at build time"
  (`docs/roadmap.md`). That is the **same emitter, the same stamp and the same loader** the app
  payload needs. With the snapshot in place, the standalone feature is roughly two weeks of
  marginal work (frontend + payload + cc driver + SDK fetch) instead of four to six from scratch.
- M7's exit criteria (startup < 15 ms, HTTP < 25 ms) are exactly the numbers the linked path must
  meet; one benchmark harness measures both the runtime and the compiled app.
- M6 is the last engine-moving milestone before 1.0. Once it lands, the stamp stabilizes.

### 14.3 Why not after 1.0

M9 is "compatibility sweep, docs, packaging, release". A standalone build is a packaging story; if
it arrives after 1.0, the first release ships without the deployment mode most likely to attract
users, and the SDK matrix competes with 1.1 work. Ship it behind a flag in M7, make it the default
in M9.

### 14.4 Cheap now, regardless of timing (1–3 days)

- The **ABI stamp** in `build.rs` (hash `quickjs-atom.h` + `BC_VERSION`, emit the marker). M7's
  snapshot needs it anyway.
- The **payload format + reader** (magic, table, bounds checks) — no dependency beyond the stamp.
- The **`wrappe` backend** (2–3 days, no runtime changes) if someone needs *a* binary before M7.
  It is the stopgap, not the destination: no bytecode, no signed macOS artifact.

### 14.5 Start the SDK matrix only when all of these hold

1. M6 is applied and pinned; `BC_VERSION` and the atom table have not moved for one release cycle.
2. M7's snapshot is merged — the emitter is shared, not duplicated.
3. The conformance corpus is green: compiled mode changes module resolution, and the tests have to
   exist before the promise does.
4. Release CI can build, stamp and smoke-test every cell (`link` and, later, `wrappe`).
5. At least one real app ships as a binary — `tuckbox`, or a user's CLI.

If a second engineer is available during M6, the frontend half (`ondec` CLI, rolldown integration,
SDK resolver, emit/cc/sign) can proceed against the pinned engine without colliding with the engine
patch. The bytecode half waits for M6.

---

## Appendix A — measurements behind the numbers

Bytecode round-trip, macOS arm64, two synthetic ES modules (4,000 and 30,000 functions):

| path | 247 KB module | 1.88 MB module |
| --- | --- | --- |
| parse (`declare`) | 22.3 ms | 786 ms (measured as declare+eval; parsing dominates) |
| `load` bytecode | 1.0 ms | 5.2 ms |
| `load` + `eval` | 1.5 ms | 9.1 ms |
| deflate ratio (level 6) | — | 3.63× (1.88 MiB → 0.52 MiB) |
| inflate | — | 1.41 ms |

Bytecode size (same engine):

| input | source | source kept | source+debug stripped |
| --- | --- | --- | --- |
| `js/bootstrap.js` | 24,723 | 54,790 (2.2×) | 11,939 (0.48×) |
| `js/lib/stream.js` | 62,075 | 108,682 (1.75×) | 27,961 (0.45×) |
| 247 KB synthetic | 246,864 | 498,930 (2.0×) | 240,116 (0.97×) |

Static library, full runtime, thin LTO, macOS arm64:

| artifact | bytes |
| --- | --- |
| `libonde.a` | 14,383,944 |
| executable linked with a C `main` | 5,222,664 |
| …stripped | 4,441,216 |
| engine-only archive / executable stripped | 7,971,496 / 1,395,744 |
| reference `onde` / stripped | 5,317,472 / 4,621,248 |

C array cost: 1 MB payload → ~6.1 MB C source, ~0.2–0.7 s to compile. Section embedding (Mach-O):
192-byte payload read back via `getsectiondata`, 3.0 ms end-to-end for the tiny app.

## Appendix B — why not append

Tested, because it is what Bun/LLRT/`qjs -c` do:

```console
$ cp target/release/onde app && printf 'PAYLOAD' >> app
$ ./app -e '1+1'                      # 2  (a local ad-hoc build still runs)
$ codesign --force --sign - app       # "replacing existing signature"
$ codesign --verify app               # "main executable failed strict validation"
$ spctl -a -t exec -vv app            # rejected
```

Codesign keeps the existing `LC_CODE_SIGNATURE` code limit, so appended bytes are never sealed; the
signature is structurally invalid however often you re-sign. The same payload placed **inside** the
image (C array or linker section) verifies after an ad-hoc sign:

```console
$ codesign --verify --strict app-sect   # exit 0
```

So appending is a local-only trick, and a compiled app that cannot be signed is not shippable on
macOS. It also cannot dead-strip, cannot be embedded in a C host, and needs its own trailer format.
Those are the reasons this design links instead.

## Appendix C — reproduction

```sh
# bytecode round-trip (throwaway crate in target/research/bc)
cd target/research/bc && cargo build --release
./target/release/bc-probe compile big.mjs big.bc
./target/release/bc-probe declonly big.mjs
./target/release/bc-probe loadonly big.bc

# static library + C main (target/research/embed, embed-min)
CARGO_TARGET_DIR=../embed-target cargo build --release
cc -O2 main.c ../embed-target/release/libonde_embed_poc.a -liconv -o app-poc

# payload in a Mach-O section
cc -O2 main-sect.c ../embed-min-target/release/libonde_embed_min.a -liconv \
   -Wl,-sectcreate,__DATA,__onde,app.bc -o app-sect
```

## Appendix D — the wrappe backend (opt-in)

`wrappe` 1.0.6 is a packer for "executables and directories into single-binary applications". It is
the second packaging backend, selected with `--packager wrappe`, because it needs **no C toolchain**
and no per-target static library — the opposite trade from the rest of this document.

The default stays `--packager link`: a linked app starts faster, carries a valid signature, and is
smaller. `wrappe` exists for the cases where those are worth less than "build it anywhere, with no
compiler, and keep real files on disk". The choice is the project's, not the tool's.

### D.1 What it actually does

- Input: a directory (or file) plus the command to run; the packer zstd-compresses the payload and
  appends it to a **prebuilt runner** for the target platform (`--runner`, from the wrappe release
  or built in at compile time).
- Output: one executable = runner + compressed payload.
- At run time the runner **unpacks the payload to a directory** — `temp` by default, `local` or
  `cwd` on request — then **launches the command as a child process**. Options: versioning
  (`sidebyside`/`replace`/`none`, default `sidebyside`), verification (`existence`/`checksum`/
  `none`), `--cleanup`, `--once`, console handling, working directory, Windows icons/resources.

So for onde the package would be:

```
runner                                   (wrappe, prebuilt per platform)
  └─ zstd payload: onde, app.js, assets…  (unpacked to temp/<name>-<version>/)
       └─ command: onde app.js
```

The startup script does not need boxing: `onde` already embeds `bootstrap.js` and the minified
stdlib. What the payload adds is the engine binary, the app, and whatever assets the app reads at
run time.

`onde` needs **no change at all**: it runs the script from the unpack directory exactly as it runs
any file today. That is the seductive part.

### D.2 Requirements

- `wrappe` on `PATH`, or `--wrappe <path>`. `ondec` shells out to the CLI (the crate is binary-only)
  and records `wrappe --version` under `-v`, the same way it records the compiler.
- A **`onde` binary for the target**: `--runtime <path>`, else a `onde-<tuple>` next to `ondec`,
  else a download from the same release/SDK cache. `onde-<tuple>` is therefore a release artifact
  (§2). Host-target packaging needs nothing extra.
- The staged payload: `onde` as the command, the bundled entry as `app.mjs`, every other bundled
  asset at its key, and any `--asset` copies. `wrappe --input <stage> --runner <tuple> onde app.mjs
  -o <out>`.
- The app's files are real files in the unpack directory, so `new Worker("./worker.js")`,
  `fs.readFile(__dirname + "/data.json")` and `child_process` work without a VFS — the reason this
  backend is worth keeping.

### D.3 What it buys

- **No C toolchain, no SDK matrix.** The runner is prebuilt; cross-packaging is `--runner <name>`.
  This is the only design here that works on a machine with no compiler and no `libonde.a`.
- **Real files at run time.** Workers, `fs.readFile(__dirname + "/data.json")`, `child_process`
  and native assets all work because the files exist on disk. The linking design needs a module
  table for code and has no answer for data files without an extra VFS.
- **Packaging features already written**: Windows resources and icons (`editpe`), console
  behaviour, versioned unpack directories, optional cleanup, single-instance mode.
- **Zero runtime code.** No compiled-mode loader, no payload format, no bytecode pipeline.

### D.4 What it costs

- **Run-time performance, in exactly the way §12 forbids.** First run decompresses and writes the
  whole engine (~5–6 MB) to disk; every later run spawns a second process from the unpack directory
  after a file-existence/checksum pass. A linked app is one process; `wrappe` is at best runner +
  `onde`, and at worst a cold extraction of several megabytes.
- **Path semantics change.** `process.execPath`, `argv[1]`, `__dirname`, `import.meta.url` point
  into `temp/<name>-<version>/`, not at the packaged file. Re-exec via `process.execPath`,
  self-spawn, logs and error messages all see a temporary path that may be cleaned up.
- **Environment fragility.** The default target is the system temp directory; `noexec` there
  (containers, hardened CI, many kiosks) breaks the package. `local`/`cwd` move the problem to
  permissions and cleanup instead.
- **Signing: not by signing twice.** Signing the inner `onde` works and its signature survives
  extraction (the bytes are unchanged), so the unpacked binary is fine. But the file the user
  launches is the *outer* one, and its signature has to cover the payload. `wrappe` appends the
  payload after the Mach-O image (the `PE3DATA` footer), so the signature's code limit stops
  before it. Re-signing after packing does **not** extend that limit: measured;
  `codesign --force --sign -` reports success, `codesign --verify` still fails, `spctl` rejects
  (Appendix B has the exact transcript). To get a signable artifact the payload must be *inside*
  the image — a Mach-O segment, as Node SEA's `NODE_SEA` and Bun's `__BUN` do — or inside a signed
  `.app` bundle's resources. Both need a packer that knows the format; neither is a wrappe flag.
  That last sentence is about the **outer** file — what Gatekeeper and the service manager check —
  and it is not the check that runs when the extracted `onde` loads a native plugin. Under the
  hardened runtime, library validation at `dlopen` compares the library against the identity of the
  process that loads it, which is the inner `onde`: it is signed, its signature survives extraction,
  and it is the process the load happens in. So a wrappe package that ships native plugins is viable
  on macOS when the staged `onde` and every staged plugin library are signed with one identity
  **before** packing. What stays unsealed is the outer artifact, which is a distribution and
  Gatekeeper question, not a load-time one. An ad-hoc signature does not satisfy library validation;
  the identity has to be real.
  Windows is different: Authenticode hashes the file up to the certificate table, so `signtool`
  after packing does work, and only the extracted `onde` needs its own signature.
- **Size.** Always the whole `onde` (5.3 MB) plus runner (~1 MB) plus the app; no dead-code
  elimination, no bytecode (the script is parsed at run time by `onde`).
- **Third-party trust.** The runner is a prebuilt binary from another project (or one you build
  from a pinned wrappe), in the trust chain of every shipped app.

### D.5 Choosing between the backends

| | `--packager link` (default) | `--packager wrappe` |
| --- | --- | --- |
| toolchain | C compiler + per-target `libonde.a` | `wrappe` + a `onde-<tuple>` binary |
| startup | one process, bytecode in the image | runner + `onde`, bytecode parsed at start, first run extracts |
| output files | one binary, no runtime files | one binary that unpacks to disk |
| app's view of the filesystem | only builtins; modules from the table | real files; workers/assets/`fs` just work |
| macOS signing | valid (payload inside the image) | the outer file cannot be sealed; the extracted runtime and any native files can be signed first, and load-time library validation uses those |
| size | ~4.4 MB + app | ~6.5–7 MB + app |
| data files | out of scope (a future VFS would be needed) | real files, `--asset` |
| run-time performance gate (§12) | enforced | reported, not enforced (the trade is the point) |

Choose `link` when the app is code and shipping a signed, fast binary matters. Choose `wrappe` when
a compiler is not available on the build machine, when the app reads files next to itself, or when
the convenience of one self-extracting artifact outweighs a slower first run. Both share the same
rolldown frontend and the same `ondec` command, so switching is a flag, not a rewrite.
