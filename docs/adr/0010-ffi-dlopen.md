# ADR-0010: `dlopen` FFI — libffi, optional declarations, decoded structs

Status: **proposed (2026-11-24).** M10 (1.1), after the M9 permissions model; not implemented. The
work breakdown, the inference rules and the `Struct` reference are in [ffi-plan.md](../ffi-plan.md).
This decision does not touch 1.0: [roadmap.md](../roadmap.md#0-definition-of-v10) already excludes
N-API and native addons from the first release.

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

FFI ships in M10 (1.1), behind a build feature and the M9 permission model, whose policy defaults
to deny.

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
the question. Concretely, it never infers a float. QuickJS normalizes integral doubles built
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
* **`Config::ffi`, default `Deny`.** The embedding application decides. The CLI flips it with
  `--allow-ffi`, one permission in the M9 model (whether the CLI should default to allow is an open
  question in the plan).
* **One reviewed host submodule.** `host/ffi.rs` is the only new capability surface; the codec
  registry, inference and `Struct` are JavaScript policy over it.

None of this is a sandbox. A loaded library can do anything the process can do, and the gates are
about *whether* a process may load one, not about containing one. That distinction belongs in the
docs before the feature ships, not after.

## 8. Consequences

* **Build.** `libffi-sys` vendors C and needs a target toolchain; `libloading` is Rust. The floor is
  libffi ≥ 3.3 (`ffi_get_struct_offsets`); the crate vendors a newer one. Cross compilation and
  `cargo deny` gain a dependency to audit (MIT). The feature is off in 1.0 release builds and turns
  on for M10; the binary-size delta is measured in WP5 and recorded in the plan.
* **Platform.** macOS and Linux, x86_64 and aarch64, are the v1 targets. Windows needs an LLP64
  `cLong` token and an exercised `LoadLibrary` path; deferring it costs nothing in the design.
* **Panic discipline.** The release profile is `panic = "abort"` ([Cargo.toml](../../Cargo.toml#L28)),
  so callback trampolines must be panic-free by construction and `catch_unwind` is not a safety
  net. A debug/test profile with unwinding plus an ASAN CI job covers what release cannot.
* **Security.** Pointers are encode-only in JSON and are never revived from input; codecs are
  resolved through a registry, never through globals; `close()` invalidates symbols and refuses
  while a deallocator-backed buffer is live. None of this protects against a malicious library,
  which is out of scope for an FFI.
* **Compatibility.** `onde:ffi` is an extension, not a Node module. `compat.md` records it as such
  (D67, added with the implementation; D66 is the current last row) and the `node-addons` condition
  stays unimplemented; npm packages that ship prebuilds
  remain unsupported, as they are today.
* **Maintenance.** `libffi` is a dependency we do not own and cannot patch casually; struct layout
  is verified against a compiled C oracle on every CI run, which is the only way to catch an
  alignment disagreement before a user does.
* **Performance.** Per-call overhead is dominated by argument marshalling and the 103 ns host-call
  baseline, not by `ffi_call`. FFI calls are synchronous and block the isolate; the plan documents
  this and does not pretend a timeout can preempt C.
* **1.0 is unaffected.** This is M10 (1.1) scope, behind a feature that stays off in 1.0 release
  builds, with no milestone dependency in [roadmap.md](../roadmap.md).

## 9. What would change this decision

* **N-API becomes a goal.** Then FFI is complementary at best; this ADR is superseded by an ABI
  ADR, not amended.
* **quickjs-ng grows a JIT or an engine-level FFI API.** D1 becomes viable and the call-overhead
  argument for it gets stronger; the rest of this decision (types, structs, gates) would survive.
* **Windows becomes a first-class target earlier.** The gates and the type system do not change;
  only the platform table in the plan does.
