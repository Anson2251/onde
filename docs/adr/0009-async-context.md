# ADR-0009: async context — host-owned jobs, engine-side tags

Status: accepted (M6, 2026-11-21). Implements [roadmap.md](../roadmap.md#m6--engine-patch-and-async-context--4-w)
with the engine delta in [engine-patch.md](../engine-patch.md) and the work breakdown in
[m6-plan.md](../m6-plan.md).

`async_hooks` and `AsyncLocalStorage` need identity that quickjs-ng does not expose: an id per
promise, a job that knows which promise it belongs to, and a notion of "the async function whose
body is running". There are three places to get them:

* **A. Stay on the stock engine and approximate.** Track `executionAsyncId` from the host's own
  schedule (timers, ticks, ops) and accept that `await`/`then` continuations have no identity.
* **B. Patch the engine so the host owns the queue and jobs carry an opaque tag.** (~260 lines of
  C, including two small host hooks beyond the queue.)
* **C. Move the runtime onto a different engine** (V8, JavaScriptCore) whose embedder API has async
  context built in.

This ADR records **B**, and the shape of the boundary B implies.

## 1. Why not A

Approximation is not a smaller version of the feature; it is a different feature. Every propagation
cell the roadmap lists — `await`, chained `.then`, `queueMicrotask`, timers, `fs` callbacks, stream
events — is a *promise* boundary except the last three, and promise boundaries are exactly what the
stock engine cannot name. An `AsyncLocalStorage` that works for timers and not for `await` would
pass a smoke test and fail every real program, and the failure mode is silent: `getStore()` returns
`undefined` instead of the store.

There is also a structural problem: `JS_ExecutePendingJob` pops from `rt->job_list` without telling
anyone. The host cannot correlate a job with the promise it came from even in principle, so
`before`/`after` would have to be guessed from the enclosing host callback. Node's contract —
"`before` runs with `executionAsyncId()` equal to the resource" — becomes unkeepable.

## 2. Why not C

The runtime's identity is a 12 ms cold start, a single-threaded isolate model and a 25 MB hello
server. V8 brings an embedder API with async stacks and `PromiseHook` for free, but also a
multi-megabyte binary, a snapshot/build story this project does not have, and an FFI surface that
would rewrite `ln-engine` from scratch. M0 chose quickjs-ng for the inverse trade
([ADR-0001](0001-engine-baseline.md)); M6 is not the milestone to relitigate it. The patch is
bounded, testable against the corpus, and rebased in CI.

## 3. The boundary

### 3.1 The engine owns *creation*, the host owns *the queue*

```c
/* the patch (vendor/job-queue-hook.patch) */
typedef bool JSJobQueueHook(JSRuntime *rt, JSJob *job, void *opaque);
void JS_SetJobQueueHook(JSRuntime *rt, JSJobQueueHook *hook, void *opaque);

typedef void JSAsyncFunctionHook(JSContext *ctx, int64_t async_tag, bool entering, void *opaque);
void JS_SetAsyncFunctionHook(JSRuntime *rt, JSAsyncFunctionHook *hook, void *opaque);

typedef char *JSAsyncStackHook(JSContext *ctx, void *opaque);
void JS_SetAsyncStackHook(JSRuntime *rt, JSAsyncStackHook *hook, void *opaque);
```

The engine still decides *when* a job exists and in what order jobs are appended — that is
semantics, and it belongs with the engine. The host decides *where the job lives* and *what tag it
carries*. Nothing in the patch changes ordering, and with no hook installed the engine behaves
exactly as upstream (the corpus runs on every build to keep that true).

### 3.2 The tag is opaque to the engine

`int64_t` is not an "async id" to C; it is a payload. Writing the tag onto a promise
(`JS_SetPromiseTag`) and copying it into the jobs a settling promise enqueues is the minimum
plumbing that lets the host answer "which promise is this reaction for". Deciding what the number
means, whether it is monotonic, and what happens when it is zero is host policy, tested in Rust.

### 3.3 Two rules the engine cannot express, so the host states them

* **A reaction belongs to the promise `.then()` created**, not to the promise that settled. The
  patch reads the derived promise's tag from the reaction's resolving function.
* **An async function's body runs as that function's promise**, not as its caller. The
  async-function hook brackets the body; Rust keeps a stack of previous `current` values.

Both are one-liners in the C, and both are invisible until an id is observed. That asymmetry is
why they have dedicated tests rather than relying on the corpus.

### 3.4 Marking is not needed

Pending jobs root their payloads through ordinary refcounts; the cycle collector keeps every object
whose count survives `gc_decref`, and a job's `js_dup` is such a count. The mark hook sketched
before implementation would have been dead code. `a_job_payload_survives_gc_between_enqueue_and_run`
forces a collection with a cyclic payload and proves it.

## 4. The split inside the host

| Layer | Owns | Why there |
|---|---|---|
| `ln-engine` | the queue, hook installation, the unsafe FFI, teardown assertions | the only crate that may hold raw engine pointers |
| `ln-runtime::async_hooks` | ids, `current`, trigger chain, subscription mask, async-stack recording | engine-free logic that needs `js::Ctx` only to call the dispatcher |
| `js/lib/async_hooks.js` | hook arrays, `AsyncLocalStorage`, `AsyncResource`, validation | policy that should change without rebuilding C or Rust |

`ln-sched` stays engine-free: it owns when a checkpoint runs, not what runs inside it, and the
queue boundary (`Engine::run_next_job`) is inside `ln-engine`.

Rust never interprets a hook. It emits five event kinds to one JavaScript entry point
(`__ln_async_event`), and JavaScript decides which callbacks those reach. The reverse direction is
a small set of `host.async*` primitives, so a module can mint an id (a timer) or bracket a callback
(an op completion) without knowing what the tracker does with it.

## 5. Cost model

Tracking starts when `node:async_hooks` is loaded (or `--async-stack-traces` is passed), not at
boot. Until then the engine hooks are installed but inert: the promise hook returns immediately and
the stdlib mints no ids, so a program that never asks for `async_hooks` pays one C-to-Rust call per
promise (measured as noise) and nothing per timer, tick or microtask. Once started, *events* are
still gated by a subscription mask, so a `destroy`-only hook pays nothing per promise.

The eager install is forced by rquickjs: the runtime is borrowed for the whole of a JavaScript
call, so a host function cannot add a promise hook from inside one. An inert hook is the cheapest
way to keep installation off the JS path.

Measured cost of the whole feature on this machine: ~1.2 µs per callback when tracking is on
(three host calls plus a context switch), ~50% on a synthetic 600k-callback benchmark and ~10% on
the HTTP hello server. The first version started tracking at boot and paid that on every callback;
gating it on module load brought both back to the pre-M6 baseline.

The table that backs `triggerAsyncId()` is pruned by a `FinalizationRegistry`, and promises are
held weakly. Without that, tracking 1M promises retained the entries after the promises died, which
the leak test caught (M6 §12.7).

## 6. Consequences

* The engine is now a *fork we own*: `vendor/rquickjs-sys` plus one patch. Every upstream release
  is a rebase, checked weekly in CI. The patch is kept as a single file that applies with
  `patch -p1`, with the procedure in `vendor/README.md`.
* The engine version is coupled to rquickjs's committed bindings: 0.17.0 now, 0.18.0 only with an
  rquickjs that binds its dynamic-import API (M7).
* `async_hooks` semantics can change without touching C; identity cannot be faked from JavaScript.
* A throwing hook cannot unwind through C: the runtime parks the exception and reports it at the
  next checkpoint, which is Node's "throw out of the hook" without the undefined behaviour.
* Net/http/child-process resources are not yet ids of their own (D57); that is surface, not
  architecture — the boundary already supports it.
