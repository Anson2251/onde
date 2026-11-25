# ADR-0001: Engine baseline and binding strategy

- Status: accepted
- Date: 2026-11-13
- Related: [0002 scheduler](0002-microtask-scheduler.md), [engine patch](../engine-patch.md)

## 1. Context

We need an embeddable ES engine with: fast cold start, small binary, a stable C API, promise
hooks, and a job queue we can re-host. The realistic candidates are Bellard's QuickJS,
quickjs-ng (a maintained fork), or a different engine entirely (Boa, V8, JavaScriptCore).

Measured on this machine (2026-11-13), same script, same day:

| Probe | Bellard quickjs 2026-06-04 | quickjs-ng 0.17.0 |
|---|---|---|
| `queueMicrotask` | **absent** | present |
| `setTimeout` / `setImmediate` | absent | absent |
| `Promise.withResolvers` | present | present |
| `structuredClone`, `Intl`, `TextEncoder`, `URL`, `AbortController`, `fetch`, `WebAssembly` | absent | absent |
| `JS_SetPromiseHook` (INIT/BEFORE/AFTER/RESOLVE) | **absent** | present |
| `JS_NewSettledPromise`, `JS_PromiseMarkAsHandled` | absent | present |
| `JS_GetPendingJobContext` | absent | present |
| `JS_SetHostPromiseRejectionTracker` with `is_handled` | present | present |
| `JS_SetModuleLoaderFunc2` (import attributes) | present | present |
| `JS_SetDynamicImportFunc` / `JS_FinishDynamicImport` (async dynamic import) | absent | absent in 0.17.0 (master only) |
| `JS_EnqueueJob` / `JS_ExecutePendingJob` | present | present |

Both engines use the older C declaration style differences only cosmetically. The decisive gap
is `JS_SetPromiseHook`: without it there is no way to assign async resource ids to promises
short of a much larger engine patch (ADR-0002 §8). `JS_NewSettledPromise`/`JS_PromiseMarkAsHandled`
make the rejection protocol cheaper to implement, and `JS_GetPendingJobContext` lets the
unpatched adapter assert that the engine and scheduler agree about which realm a job belongs to.

Dynamic `import()` is not a differentiator: both engines drive it through the *synchronous*
module loader and resolve the returned promise through the job queue. `JS_SetDynamicImportFunc`
(the async, `JS_FinishDynamicImport`-based API) is master-only as of 0.17.0; we do not depend on
it, but it is a reason to keep tracking ng tags (R3).

## 2. Decision

1. **Engine: quickjs-ng, pinned by release tag** (0.17.0 at project start), vendored as a git
   submodule in `vendor/quickjs-ng`. No system QuickJS, no Homebrew build, no floating `master`.
2. **Bindings: `rquickjs` 0.14** (which already targets quickjs-ng), used only for value
   conversion, modules, classes and persistence. We do **not** use `AsyncRuntime`,
   `Context::async_with`, or the `futures` feature: they own a job pump and a spawner, which
   violates I1 in ADR-0002.
3. **M6 patch path:** fork `rquickjs-sys` via `[patch.crates-io]`, point its `quickjs` submodule
   at our patched quickjs-ng, add a `ln-engine` unsafe layer for the new symbols. This keeps the
   ergonomic bindings while giving us the job hook. The alternative (replacing rquickjs with a
   hand-written wrapper) is the R6 escape hatch, not the plan.
4. **Backend swap is one crate wide.** `ln-runtime` only sees `ln-engine`'s safe API, so
   replacing rquickjs with `ln-sys` + a hand-written wrapper later touches one crate.

## 3. Why not the alternatives

| Option | Rejection |
|---|---|
| Bellard QuickJS | No `JS_SetPromiseHook`, no settled-promise helpers, no `JS_GetPendingJobContext` in the pinned header; promise hooks are a hard requirement for `async_hooks`/ALS (ADR-0002 §8). Also a slower ES-feature cadence and no import-attribute-aware job/dynamic-import work in flight |
| V8 | Exactly the weight we are avoiding: ~30 MB+ binary, higher RSS floor, C++ build |
| Boa | Pure Rust is attractive, but performance and ES coverage are not yet at a point where "onde" is honest |
| JavaScriptCore | Platform-tied API, heavy, no embed story comparable to QuickJS |
| QuickJS + a JS-level promise wrapper for context | Cannot intercept engine-created reactions; breaks promise identity (see ADR-0002 §11) |

## 4. What we accept

- **No `Intl`.** Verified absent. Non-goal for 1.0; an `icu`-backed onde shim can be a 1.1
  feature flag (R2 in the roadmap).
- **No `TextEncoder`, `URL`, `AbortController`, `EventTarget`, `structuredClone`, `atob`/`btoa`
  (partial), `fetch`.** We ship them. They are cheap in JS over small ops and are needed by
  almost every real script.
- **No JIT.** 5–20x slower on compute-bound code; acceptable for I/O-bound and CLI workloads,
  and documented in the roadmap (R1).
- **Patch maintenance.** ~150 LOC of C, rebased per release, CI-checked (R3).
- **Synchronous module loader in 0.17.0.** Dynamic `import()` of a file resolves through the
  sync loader, so the read happens on the isolate thread. That is acceptable for local files
  (the common case) and becomes async only when `JS_SetDynamicImportFunc` reaches a tagged
  release, or when we patch it in for network imports.
- **`rquickjs` constraints.** Its `Ctx` lifetime model is good but not free: persistent values
  need `Persistent<T>`, and its promise hook slot is single-owner. `ln-engine` owns that slot;
  rquickjs's async features are disabled project-wide by lint/CI (no `futures` feature in
  `Cargo.lock` checks).

## 5. Engine pinning and build

- `vendor/quickjs-ng` at a tag; `vendor/rquickjs-sys` pinned to the matching rquickjs version.
- `build.rs` compiles with `-O2`, `CONFIG_BIGNUM`/atomics as needed, no `-march=native` in
  release artifacts (reproducibility).
- Prebuilt bindings are generated with `bindgen` in a CI job and committed, so downstream users
  do not need libclang.
- A weekly CI job rebases our patch branch onto `quickjs-ng/master` and runs the scheduler
  corpus; failure opens an issue (R3 trigger).

## 6. Consequences

- We get promise hooks and dynamic import without writing an engine.
- We inherit two upstream release streams (quickjs-ng and rquickjs) and a patch queue. That cost
  is bounded and scheduled (M6), not incidental.
- The API surface we must add in JS is known up front, because it is the measured gap table
  above, not guesswork.
