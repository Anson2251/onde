# WebAssembly (`onde:wasm`) — draft plan

Status: **draft, 2026-11-26. Not implemented. Engine not chosen.** This is the working contract for
shipping a wasm module *inside an application*, which is the role [ADR-0012](adr/0012-plugins.md) §6
gives wasm. Where this document and the code disagree later, this document is the intent and the code
is the truth; update this file with the code in the same change.

The reason to do this at all is one sentence: **a wasm module is an artifact that runs on every cell
the runtime builds for.** No per-target build, no `dlopen`, no catalog cell, no `target` field, no
signature, no installation step. Everything else in this document is the cost of that sentence.

## 1. What ships, in one table

| Area | v1 | Deliberately not v1 |
|---|---|---|
| Surface | `onde:wasm`: `compile`, `instantiate`, `validate`; opaque module and instance handles | the `WebAssembly` global, `WebAssembly.Module` as a constructor, `compileStreaming` |
| Numbers | `i32`/`f32`/`f64` as JS numbers, `i64` as BigInt | `v128`, reference types, `externref` tables |
| Memory | one exported linear memory, zero-copy `ArrayBuffer` view, `grow` | memory64, multiple memories, shared memory, heap-to-heap copies the user did not ask for |
| Imports | JavaScript functions, one per declared import | WASI, host globals, host tables, host memories |
| Control | synchronous `instantiate`, traps as `Error` with a `code` | async instantiation, streaming, fuel/epoch as a *guarantee* (§6) |
| Placement | a file next to the app (interpreter) or a payload asset (compiled app) | a wasm module installed as a plugin |
| Engine | one, behind a narrow seam; one tier, interpreter or baseline JIT (§6) | a second backend, two tiers with tier-up |

A wasm **plugin** — a directory in a plugin root, installed and versioned by the catalog — stays
reserved in the plugin format and is not built here (ADR-0012 §6). This document is about the module
the application ships.

## 2. Where a module comes from

The same two-source rule the plugin resolver uses (ADR-0012 §9), for the same reason: compiled apps
have no filesystem path for their own assets.

```js
const wasm = require("onde:wasm");

const mod  = wasm.compile("./add.wasm");     // resolved like an asset, not like a module
const inst = wasm.instantiate(mod, { env: { log } });
inst.exports.add(2, 3);                      // 5
```

* **Specifier.** A relative path or a `file:` URL, resolved against the calling module — the way
  `fs` would resolve it in the interpreter, and the way the payload table keys it in a compiled app.
  A bare specifier is not accepted: this is not a module loader, and pretending otherwise invites
  `require("./add.wasm")` to mean something.
* **Interpreter.** Read from disk through the ordinary permission-checked read (§5 covers what that
  means under `--permission`).
* **Compiled app.** Read from a payload **blob**. This is new in `ln-payload`: today the payload
  carries modules only, and `--asset` is wrappe-only. A `.wasm` file becomes one entry of a new
  entry kind and is handed to the engine as bytes. The entry kind is a format change, so the payload's
  `version` moves and an older runtime refuses the archive rather than misreading it — the same
  refusal posture the format already has for `bc_version` and unknown flag bits.
* **Bytes.** `compile(buffer)` also accepts an `ArrayBuffer`/TypedArray, which is what a bundler
  that inlines a module will produce.

Without the data-asset kind the compiled-app half of this plan does not exist, and with it half the
argument for wasm goes too. It is WP3, not a follow-up.

## 3. The module surface

```js
const { compile, instantiate, validate } = require("onde:wasm");
```

| Member | Meaning |
|---|---|
| `compile(source)` | `source` is a path/URL string, an `ArrayBuffer` or a TypedArray. Returns an opaque module handle. Throws `ERR_WASM_COMPILE` with the engine's message |
| `validate(source)` | boolean; never throws for an invalid module, only for an unreadable source |
| `instantiate(module, imports?)` | returns `{ exports, memory, close() }`. `imports` is `{ moduleName: { importName: fn } }`. Missing or extra imports throw `ERR_WASM_LINK` |

An instance is a plain object, not a class: `exports` is a null-prototype object of functions,
`memory` is `null` when the module exports no memory, and `close()` releases the engine's store.
Dropping an instance without `close()` is safe (a finalizer or the engine's own teardown handles it),
but `close()` is the deterministic path and the one a long-lived host should use.

**No string bridge, no `wasm-bindgen` protocol, no JS object graphs.** A module and its host exchange
integers and floats; anything else is marshalled by the caller through linear memory, by hand. That
is the same decision as ADR-0012 §5 — the runtime does not invent an ABI between two things it did not
build — and it is what keeps the surface auditable.

## 4. Numbers, memory, traps

| wasm | JavaScript | Coercion |
|---|---|---|
| `i32` | number | integer in `[-2^31, 2^31)`; a non-integer or out-of-range value throws `ERR_INVALID_ARG_TYPE`, never wraps silently |
| `i64` | BigInt | BigInt only; a plain number throws, because a 64-bit quantity that lost precision is a bug |
| `f32` | number | rounded by the engine to f32; `NaN`/`±Infinity` pass through |
| `f64` | number | as-is |

Exports are called as `inst.exports.name(...)`; the correct arity and types are the module's, and a
mismatch is a JS-side type error rather than a trap.

**Memory.** `inst.memory.buffer` is an `ArrayBuffer` over the engine's linear memory, zero-copy
through the engine's external-buffer hook — the same hook [`ffi-plan.md`](ffi-plan.md) §8 specifies
for `toArrayBuffer`, which does not exist yet and lands with M10. **Reading the property after a
`grow` is required**; the previous view is detached. `inst.memory.grow(pages)` returns the old size in
pages and throws `ERR_WASM_OOM` when the engine refuses.

**A call blocks the isolate**, exactly as an FFI call does ([ffi-plan.md](ffi-plan.md) §8): the
checkpoint interrupt runs at JavaScript checkpoints, and a wasm frame is not one. Until fuel is
exposed (§6 measurement 5), a module can hold the thread for as long as it likes, and that is a
documented cost rather than a bug to be discovered.

**Traps** are ordinary `Error` objects with `code: "ERR_WASM_TRAP"`, the engine's message, and the
instance marked poisoned: a second call throws `ERR_WASM_POISONED`. A host function that throws while
wasm is on the stack follows the same path — the wasm call unwinds as a trap, the instance is
poisoned, and the original error is rethrown. Recovering a half-executed instance is not something
v1 pretends to do.

## 5. No WASI in v1, and what that buys

A module that declares an import this host does not provide fails at `instantiate` with
`ERR_WASM_LINK`, naming the missing `module.name`. That includes every `wasi_snapshot_preview1` import.

This is a scope line with a capability story under it: **v1 wasm modules can compute and nothing
else.** No files, no clock, no random, no sockets, no environment. The host functions the application
passes in are the only authority a module has, and they are the application's own code. WASI is a
design of its own — preopens are a filesystem policy, clocks and random are capabilities, and none of
it has an entry in [ADR-0011](adr/0011-permissions.md)'s nine ids — so it is deferred until there is a
permission model to hang it on, not quietly enabled because it is convenient.

Under `--permission`, `compile` reads a file like any other read: `fs.read` on the path. A module
compiled from bytes never touches the filesystem.

## 6. The engine: the seam, and how it gets chosen

`crates/ln-wasm` owns the engine. The public surface above is a thin mapping onto a narrow internal
trait — `Engine`, `Module`, `Instance`, `Memory` — so the choice is a crate-level substitution rather
than a rewrite. v1 implements **one** engine; the trait exists so that the second one is a port, not a
design meeting.

The candidates and what is known about them today, without a decision:

| engine | language | footprint | JIT | metering | notes |
|---|---|---|---:|---|---|
| [`wasm3`](https://github.com/wasm3/wasm3) | C, MIT | ~64 KB code | no | gas metering, resource caps, guard pages since 2026 | "minimal maintenance" by the maintainer's own statement; the engine inside `txiki.js` |
| [WAMR](https://github.com/wasm-micro-runtime/wasm-micro-runtime) | C, Apache-2.0 + LLVM exception | ~59 KB interpreter | Fast JIT, LLVM JIT, tier-up, AOT | gas | active, TSC of several vendors; SIMD, GC, EH, threads, memory64 |
| `wasmi` | Rust, MIT | ~1 MB | no | fuel | active, pure Rust, no vendored C |
| `wasmtime` | Rust, Apache-2.0 + LLVM exception | multi-MB, hundreds of crates | Cranelift | fuel, epoch | the most complete, the least compatible with this tree's size thesis |

The decision procedure, in order, with the measurement written into this file before the first line of
engine code:

1. **Does it need executable memory?** Record the answer rather than judging it: a build with `ffi`
   already asks for the JIT entitlement on macOS, because libffi's closures are executable memory
   ([ffi-plan.md](ffi-plan.md) §9), so the question is which *builds* pay — not whether the project
   accepts it. A JIT that compiles lazily on first call pays only when a module is actually invoked.
2. **What does the feature cost a release build?** `.text` delta on `aarch64-apple-darwin` with
   `--features wasm`, measured the way [`test/features/size.sh`](../test/features/size.sh) measures
   the module flags. Above ~1 MB the feature flips from default-on to opt-in.
3. **Instantiation:** time to `compile` + `instantiate` a 1 MiB module, and cold start with wasm
   loaded but unused. The second number must be zero — the feature must not cost what it does not use.
4. **Throughput** on the fixture corpus against native, so the tier's honest speed claim is recorded
   rather than assumed. Interpreters will be an order of magnitude off; that is expected and stated,
   not hidden.
5. **Metering**, if the engine offers it: does a module that loops forever stop, and does a module
   that calls `grow` in a loop hit the ceiling? A metering bug is a denial of service; the test for it
   is a prerequisite for exposing fuel at all, not a follow-up.

The trait is the reason this can stay undecided while WP1 starts: it is written against the smallest
common denominator — one memory, functions as imports, no threads, no reference types.

## 7. Build, size, and the cells

* **A Cargo feature `wasm`** on `ln-runtime`, mirroring `node-sqlite`: it pulls `ln-wasm`, the module
  is present or absent as a whole, and a build without it fails `require("onde:wasm")` with
  `ERR_UNKNOWN_BUILTIN_MODULE` — the same honest error the other absent modules give.
* **Default on**, like `node-sqlite` (`+2.1 MB`), if §6 measurement 2 says the delta is small; the
  README's feature table gains a row either way.
* **`ln-embed`** gains the feature behind the same name, so a compiled app that uses a module links
  an archive that has it; the SDK's default archive includes it when the feature is default-on.
* **No new cell.** A wasm module is one artifact for every target in
  [standalone-build.md](standalone-build.md) §2.1 — that is the point — so the feature is a build
  choice per cell, not a matrix dimension.

## 8. Testing

* **The spec suite.** The wasm spec testsuite subset that the chosen engine claims: Core, no SIMD, no
  threads, no GC. Run it once for the engine, and again through `onde:wasm` for the marshalling.
* **Fixtures compiled from source**: one C module and one Rust module (both `wasm32-unknown-unknown`,
  no WASI) exported as numbers, memory and a trap. The C one is the point — nothing Rust-shaped may
  leak into the boundary, the same rule as ADR-0012's plugin fixtures.
* **Marshalling matrix**: every row of §4, including the throws (`i32` out of range, a float for
  `i64`, wrong arity), and a host function that throws mid-call.
* **Memory**: zero-copy (a write through `inst.memory.buffer` is visible to the module without a
  flush), growth detaches the old view, `grow` past the ceiling is `ERR_WASM_OOM`.
* **No WASI**: a module importing `wasi_snapshot_preview1.fd_write` fails to instantiate, and the
  message names it.
* **Both placements**: the same fixture through `onde` (from disk) and through `ondec` (as a payload
  data asset); byte-identical results, and the compiled app reads no file at run time.
* **Cold start**: a build with `wasm` on and an app that never calls it is within noise of one without.
* **Metering**, if exposed: an infinite loop is interrupted, and the interruption is a trap, not a
  hang.

## 9. Work packages

| WP | Work | Est. |
|---|---|---|
| 1 | `crates/ln-wasm`: the trait, one engine vendored and pinned, module/instance/memory mapping, trap and poison handling | 5 d |
| 2 | `ln-runtime/src/host/wasm.rs`, `js/lib/wasm.js`, the `wasm` feature through `ln-cli` and `ln-embed`, the external-buffer hook shared with M10's `toArrayBuffer` | 5 d |
| 3 | `ln-payload`: a blob entry kind (format-version bump), `ondec` emitting `.wasm` assets, the runtime-side lookup `compile` uses | 3 d |
| 4 | Fixtures, the test matrix in §8, the size measurement, `README` feature row, `compat.md` entry (`onde:wasm` as an extension, D-number at implementation) | 4 d |

≈17 engineering days, ≈3.5 eng-weeks with review. It assumes M10's external-buffer hook (WP2 depends
on it) and does not include WASI, the `WebAssembly` global, or a second engine.

## 10. Deliberate limits

* **No `WebAssembly` global.** `compat.md` records WebAssembly as a non-goal, and this does not
  quietly turn it into a goal. The global is a compatibility layer with its own semantics
  (`Module`/`Instance`/`Memory`/`Table`/`Global` objects, `RuntimeError`, `LinkError`, streaming) and
  it is worth building only if something needs it. `onde:wasm` is the honest name until then.
* **No WASI, no host globals or tables.** §5.
* **No threads, no SIMD, no GC, no memory64, no shared memory.** Each is an engine feature the
  smallest common denominator does not have; each can arrive later without changing the JS surface
  that §3 defines.
* **No async instantiation, no streaming compile.** A local module is bytes; an async API would add a
  scheduling dependency to a path that has none.
* **No plugin tier.** A wasm plugin directory remains reserved in the plugin format and is not built.
* **One tier in v1.** Whether that tier is an interpreter or a baseline JIT is §6's decision, taken
  against a size and cold-start ceiling. What v1 does not ship is two tiers with tier-up: two code
  paths for the same module is two metering stories, and metering is the tier's whole purpose.

## 11. Open questions

* **Which engine.** §6's measurements decide; the draft deliberately does not.
* **Is `onde:wasm` the final name**, or `onde:wasm` plus a `node:`-shaped alias later? The `onde:`
  namespace is the extension namespace, and a Node-shaped name would be a compatibility claim the
  runtime does not make.
* **Fuel in the public API.** If the engine meters, is fuel a compile-time option, an instantiate
  option, or a host callback? The shape matters more than the name: a budget that can only be set
  once, at instantiate, is the only one that is hard to get wrong.
* **Does every `.wasm` in the bundle become a blob automatically**, or does the bundler need an
  explicit marker? Automatic is smaller and matches `.json`; explicit is reviewable in the build log.
* **Should `instantiate` accept an import object with a `Proxy`**, so a missing import is detected
  lazily? v1 says no — every declared import must be present before the first instruction, which is
  also what the spec's linking step does.

## 12. Acceptance

The feature is done when all of the following hold in CI on macOS arm64 and Linux x86_64:

1. The fixture matrices in §8 pass in both placements, with identical results.
2. A wasm module in a compiled app runs from the payload with no file read at run time.
3. Cold start with the feature compiled in but unused is within noise of a build without it.
4. A module importing WASI fails to instantiate, naming the import.
5. The size delta and the throughput figures are measured and written into this file.
6. `--permission` behaviour is recorded: `compile` from a path is an `fs.read`, bytes are not.
7. `compat.md` records `onde:wasm` as an extension and leaves `WebAssembly` a non-goal.
