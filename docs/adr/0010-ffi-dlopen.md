# ADR-0010: `dlopen` FFI — libffi, optional declarations, decoded structs

Status: **accepted (2026-11-27), implemented in M10 before 1.0.** The work breakdown, the inference
rules, the `Struct` reference and the recorded deviations are in
[ffi-plan.md](../ffi-plan.md) (§17 is the implementation account). This decision does not open the
door to native addons: [roadmap.md](../roadmap.md#0-definition-of-v10) still excludes N-API from the
first release, and §2 explains why FFI is not a route to it.

onde runs CLIs, build steps, config loaders and plugin hosts. Sooner or later one of those needs a
native library: sqlite3, libgit2, a system framework, libc itself. Node's answer is N-API; Bun's is
`bun:ffi`; Deno's is `Deno.dlopen`. The question is which of those this runtime should be, and what
the boundary costs.

## Options

* **A. No FFI.** Ship built-in modules for the libraries that matter (`node:sqlite`, more of
  `crypto`), and leave native code to a separate process.
* **B. N-API.** Implement `napi_*` so npm packages with prebuilds run unchanged. This is the
  ecosystem-compatible answer, and `process.dlopen` becomes meaningful.
* **C. Curated native shims.** A small `extern "C"` surface compiled into the binary, one function
  per supported operation, extended by rebuilding onde.
* **D. `dlopen` FFI.** Let scripts load a library and call its symbols, with types supplied by the
  caller.

Within D there are three implementation choices: **D1** engine-level thunks and JIT specialization
(Bun's approach), **D2** `libffi` for the call frame plus `libloading` for the loader, **D3**
`dyncall` or hand-rolled per-architecture trampolines.

## Decision

**D with D2.** A new `crates/ln-ffi` owns loading, symbol tables, call plans, `ffi_type` trees,
layout and trampolines; `ln-runtime` adds one `host.ffi` submodule for JS-value conversion; and
`js/lib/ffi.js` owns the public surface, the type vocabulary, `Struct` and JSON. Signatures are
declared at `dlopen` **or** resolved per call from typed values, with inference restricted to
values that are unambiguous; the per-call return type may be omitted, in which case it takes the
declaration's, or `i32` for an undeclared symbol. Structs
are JavaScript values whose layout is computed by the host.

FFI ships in M10, before 1.0, behind the `ffi` build feature and M8's `ffi.load` permission, whose
policy defaults to deny.

## 1. Why not A

Built-in modules are the right answer for one library at a time and the wrong answer for the
general case. `node:sqlite` is worth doing on its own merits, but it does not make libgit2, a
platform framework or a vendor SDK reachable, and every new library would otherwise wait for a
release. The plugin story is the deciding case: an embedder that wants to expose *its own* native
library to onde scripts cannot do that through a curated enum of functions.

The cost of A is that onde stays a runtime you must recompile to extend. The cost of D is memory
unsafety, which this ADR confronts directly rather than hiding.

## 2. Why not B

N-API is a different project, not a larger FFI. It is roughly 150 entry points, a handle model, a
lifecycle for external objects, and a set of assumptions — V8's `napi_value` identity, async work,
thread-safe functions — that quickjs-ng does not provide and that would have to be emulated in a
shim layer. It also ties onde to Node's ABI policy and to the prebuild matrix of every package it
wants to run. The roadmap records the same conclusion at
[roadmap.md](../roadmap.md#7-what-we-are-explicitly-not-doing): if N-API is ever needed, it is a
separate project with its own ABI shim.

If that project ever exists, this ADR is superseded, not amended. FFI is not a stepping stone to
N-API, and it should not be sold as one.

## 3. Why not C

Compiled-in shims are the safest version of native access and the least useful: the set of
reachable operations is fixed at build time, the ABI belongs to the runtime, and adding a library
means rebuilding and redistributing onde. It is the right choice for a *specific* embedder
(`ln-embed` exposing its own functions), where the set is known and small. It is not a general
answer, and doing C would leave the plugin case unsolved.

## 4. Why `libffi` and not engine thunks

Bun's FFI lives inside JavaScriptCore: the engine converts arguments, the call sites JIT-compile
into direct native calls, and TinyCC is embedded for `cc()`. That design buys call overhead we
cannot match, and it needs a JIT and an engine-level trampoline generator this runtime does not have.
`libffi` closures do allocate executable trampolines when a JavaScript callback is handed to C; that
is a library facility, not a compiler of our own, but it is real executable memory and the plan
treats it as such (entitlements, `ffi_closure_free` rules).

`libffi` is the opposite trade. It is an ABI implementation, not a compiler: the host builds an
`ffi_type` tree once per signature, `ffi_prep_cif` validates it, and `ffi_call` assembles the
register and stack frame. A scalar call costs tens of nanoseconds before marshalling — well below
the 103 ns a host call already costs in this runtime
([native-candidates.md](../native-candidates.md#why-not-port-the-whole-buffer-module)), so it is
not the bottleneck for the calls that matter. It is MIT, it is the same library CPython's `ctypes`,
PHP's FFI and Ruby's Fiddle use, and it covers every target the roadmap names.

D1 was rejected because copying it means either embedding a C compiler for thunks or patching
quickjs-ng's JIT — the engine has neither. D3 was rejected because `dyncall` is a second
per-architecture assembly matrix with no documented advantage for our call shapes, and
hand-written trampolines are a maintenance liability for a runtime whose whole claim is
reviewability. `libloading` is a thin, well-tested wrapper over `dlopen`/`dlsym` (and
`LoadLibrary` later); it is not a framework.

## 5. Why declarations are optional, and why inference is a resolution not a guess

A mandatory signature table is the thing people hate about `node-ffi` and the reason `ctypes`
callers reach for `argtypes` only when something breaks. A typed value already carries what the
callee needs: a `Ptr` knows it is a pointer, a string knows it is a C string, a struct instance
knows its class. So the design has three tiers, in order:

1. a declared signature, authoritative when present;
2. typed values, which need no declaration;
3. untyped primitives, inferred only when the value is unambiguous — otherwise **the call throws**.

The rule that makes this safe is the last clause. A wrong marshalling decision is not a wrong
answer, it is memory corruption, so the runtime refuses to guess where the value does not settle
the question. Portability is the other half of the same rule: struct classification, register
assignment, alignment and variadic handling differ by ABI, and `long`/`size_t` change width on
LLP64, so a declaration or a typed value is the only description that survives a target change. Concretely, it never infers a float. QuickJS normalizes integral doubles built
through `js_number()` ([quickjs.c](../../vendor/rquickjs-sys/quickjs/quickjs.c#L1640)) — literals,
`Math.*` rounding — into an int tag; mixed add/sub/mul keeps the float tag via `js_float64`, while
division normalizes on every path, so `w / 2` is accepted when exact and refused when fractional.
That value-dependence is why the API tells callers to convert explicitly (`Math.trunc(w * 0.5)` or
`f64(2)`), not because the runtime rounds silently. It never widens
a number to 64 bits — `i64`/`u64` come from a BigInt or a declaration — and it never infers whether
a struct is passed by value or by address. Those are the cases that produce silent corruption, and
each one gets a named error and a one-token fix (`Math.trunc(w * 0.5)`, `f64(2)`, `u64(1n)`,
`ref(T)` or a declaration).

A call's return type is optional: when omitted it takes the declaration's `ret`, or `i32` if the
symbol is undeclared, because the majority of C functions return an `int` status. The fallback is
documented as unsafe for a pointer or 64-bit return, which must be stated: a truncated pointer
passed back into FFI is a crash, and a struct return under an `int` signature is an ABI mismatch.
When a symbol is declared, the declaration's return type is authoritative in ABI terms; an explicit
call-site return type may only *refine* it where the ABI is identical (any pointer to any pointer,
an integer of the same width), and a different width or class throws
`ERR_FFI_SIGNATURE_CONFLICT`.

That refinement rule is the only kind of dynamic typing C actually has. The return ABI cannot vary
with the arguments; what varies is the caller's knowledge of a `void*` — `dlsym`, `malloc`,
`bsearch`, `tsearch`, a generic container. The declaration says `void*` because it must, and the
call site says `Ptr.of(T)` or `Callback.of(args, ret)` because it knows. Anything that would need a
different return *class* (an `int` for one argument, a struct for another) has to be two symbols
behind a JavaScript wrapper.

This is the difference between "we guess the signature and it is your problem" and "we resolve the
signature and refuse when it is ambiguous". The former passes a smoke test and corrupts a call
under load; the latter is the only version consistent with the runtime's stated honesty about the
parts of Node it implements.

## 6. Why structs are decoded values, not native buffers

A struct instance is a JavaScript object of coerced values, not an owner of native memory. Layout
— offsets, `sizeof`, alignment, the `ffi_type` tree — is computed in Rust, because `libffi` needs it
there anyway and because a second implementation in JavaScript would eventually disagree with the
first. Instances carry no finalizer, no lifetime and no aliasing; encoding happens only at a call
boundary.

This was not the first instinct. By-value structs looked like the expensive part until the layout
existed: once there is an `ffi_type` tree, `libffi` owns the ABI, so by-value arguments and returns
are nearly free and the cost is the layout grammar, not the calling convention. The costs that
remain are bounded and have named escapes: `ref(T)` for out-params, and `Struct.view` for poking a
single field of a large struct without decoding and re-encoding it.

The alternative — instances wrapping `malloc`-allocated buffers with lazy accessors — buys zero-copy
fields at the price of lifetimes, finalizers and a second memory model in the runtime. For the
structs FFI actually meets (`stat`, `timespec`, `sockaddr`, `sqlite3_value`'s opaque handles), the
decode is trivial and the safety is worth more.

## 7. The capability boundary

`__ln_host` is the entire capability list, and
[host/mod.rs](../../crates/ln-runtime/src/host/mod.rs#L1) says so: "if a capability is not here,
JavaScript cannot perform it." `dlopen` is the capability that subsumes all the others — file
access, sockets, process spawning and arbitrary computation — so it is not added quietly.

Two gates, plus one structural rule that keeps the surface reviewable:

* **Build feature `ffi`.** A binary built without it has no `libffi`, no `libloading` and no
  `onde:ffi`; the module is not merely disabled, it is absent. This lets an embedder ship a binary
  that *cannot* load native code, which is a property worth having even when the binary is trusted.
  The feature is in `onde`'s default build and off in `ln-embed`.
* **The `ffi.load` permission.** The runtime gate is the capability M8 defined in
  [ADR-0011](0011-permissions.md), granted by a policy file or `--allow-ffi` (which requires
  `--permission`). With `--permission` and no grant, `dlopen` throws `ERR_ACCESS_DENIED` with
  `capability: "ffi.load"`; a build without the feature has no module at all. The originally
  proposed **`Config::ffi` was not added**: M8 shipped the single gate, and a second switch would
  have been a second policy to keep in sync.
* **One reviewed host submodule.** `host/ffi.rs` is the only new capability surface; the codec
  registry, inference and `Struct` are JavaScript policy over it.

None of this is a sandbox. A loaded library can do anything the process can do, and the gates are
about *whether* a process may load one, not about containing one. That distinction belongs in the
docs before the feature ships, not after.

## 8. Consequences

* **Build.** The implementation links the **system** libffi (`-lffi`, ≥ 3.3 for
  `ffi_get_struct_offsets`) plus `libloading`, rather than vendoring `libffi-sys` as first sketched.
  The platform package must therefore be present: `libffi-dev` on Linux (`test/ffi/run.sh` runs in
  CI, which installs it) and the SDK on macOS. libffi is MIT, and `cargo deny` / the license audit
  gain one dependency. The `ffi` feature is on in `onde`'s default build and off in `ln-embed`; the
  binary-size delta is +173,632 bytes (+2.2%) on an otherwise identical release build (below).
* **Platform.** macOS and Linux, x86_64 and aarch64, are the v1 targets. `cLong` follows the
  host's `sizeof(long)`, so an LLP64 build would get a 32-bit token; the remaining Windows work is
  an exercised `LoadLibrary` path.
* **Panic discipline.** The release profile is `panic = "abort"` ([Cargo.toml](../../Cargo.toml#L28)),
  so callback trampolines must be panic-free by construction and `catch_unwind` is not a safety
  net. A debug/test profile with unwinding plus an ASAN CI job covers what release cannot.
* **Security.** Pointers are encode-only in JSON and are never revived from input; codecs are
  resolved through a registry, never through globals; `close()` invalidates symbols and refuses
  while a deallocator-backed buffer is live. None of this protects against a malicious library,
  which is out of scope for an FFI.
* **Compatibility.** `onde:ffi` is an extension, not a Node module: the namespace is `onde:`, it is
  absent from `module.builtinModules`, and bare `ffi` and `node:ffi` do not resolve. `compat.md`
  records it as D81; the `node-addons` condition stays unimplemented, and npm packages that ship
  prebuilds remain unsupported.
* **Maintenance.** `libffi` is a dependency we do not own and cannot patch casually; struct layout
  is verified against a compiled C oracle in CI (`test/ffi/layout.c`, five structs), which is the
  only way to catch an alignment disagreement before a user does.
* **Performance.** Per-call overhead is dominated by argument marshalling and the 103 ns host-call
  baseline, not by `ffi_call`. `test/ffi/bench.js` prints per-call numbers for a declared symbol,
  `fn()` and an undeclared `call()`. On a release build (macOS arm64): 4.4–4.6 µs for a declared
  symbol, 5.5–5.6 µs through `fn()`, 4.3 µs undeclared; marshalling and the two host crossings
  dominate, not `ffi_call`. FFI calls are synchronous and block the isolate; the plan documents
  this and does not pretend a timeout can preempt C.
* **1.0 includes it.** FFI is M10 scope, shipped before the release, behind a feature that is on by
  default in `onde` and off in `ln-embed`. The permission gate is the one the release already
  documents; [roadmap.md](../roadmap.md) now sequences M8 → M10 → M9.

| Measurement | Value |
|---|---:|
| per-call overhead, declared symbol | 4.4–4.6 µs |
| per-call overhead, `fn()` | 5.5–5.6 µs |
| per-call overhead, undeclared `call()` | 4.3 µs |
| binary-size delta, `ffi` feature | +173,632 bytes (+2.2%) |

### Implementation notes (2026-11-27)

The full list of deviations is [ffi-plan.md §17](../ffi-plan.md#17-implementation-deviations); the
three this ADR's design had to adjust:

* No `Config::ffi`. The runtime gate is `ffi.load` from [ADR-0011](0011-permissions.md); a denial is
  `ERR_ACCESS_DENIED` (`capability: "ffi.load"`), not the `ERR_FFI_NOT_ALLOWED` this ADR sketched.
* `threadsafe: true` callbacks are refused with `ERR_FFI_UNSUPPORTED_THREADSAFE`. Same-thread
  callbacks, exception parking and reentrancy ship; a callback invoked on a foreign thread cannot
  enter QuickJS, and v1 does not pretend otherwise.
* `close()`'s `ERR_FFI_LIVE_REFERENCES` maps a live deallocator to its loaded image with `dladdr`,
  so only the handle whose library owns the deallocator is blocked. A foreign or unresolvable
  deallocator does not block a close.

The suite is `test/ffi/run.sh`: a C fixture with 35 functions and one data symbol, a layout oracle
compared for five structs, and seven JavaScript files with 84 cases, plus the feature-off build
check and the `ffi.load` permission gate.

## 9. What would change this decision

* **N-API becomes a goal.** Then FFI is complementary at best; this ADR is superseded by an ABI
  ADR, not amended.
* **quickjs-ng grows a JIT or an engine-level FFI API.** D1 becomes viable and the call-overhead
  argument for it gets stronger; the rest of this decision (types, structs, gates) would survive.
* **Windows becomes a first-class target earlier.** The gates and the type system do not change;
  only the platform table in the plan does.
