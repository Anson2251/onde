# Engine patch: host-owned job queue and async context (M6)

Status: **applied** in `vendor/rquickjs-sys` against quickjs-ng **0.17.0**; the whole delta is
`vendor/job-queue-hook.patch` (~260 added lines including comments). The runtime design that uses
it is [ADR-0009](adr/0009-async-context.md); the milestone contract is
[m6-plan.md](m6-plan.md).

Purpose: give the host per-job identity and full queue ownership, and let it run an async
function's body and an error's stack as their own async context. Everything is inert until a hook
is installed: with no hooks the engine behaves as upstream, which the conformance corpus checks on
every build.

## 1. What was changed

```c
/* quickjs.c, abridged */

typedef struct JSJobEntry {          /* before */
    struct list_head link;
    JSContext *ctx;
    JSJobFunc *job_func;
    int argc;
    JSValue argv[];
} JSJobEntry;

struct JSJob {                       /* after: opaque, tagged */
    struct list_head link;
    JSContext *ctx;
    JSJobFunc *job_func;
    int64_t tag;
    int argc;
    JSValue argv[];
};
```

| Site | Change |
|---|---|
| `JS_EnqueueJob` | split into `js_enqueue_job(ctx, func, argc, argv, tag)`, which offers the job to `JS_SetJobQueueHook` *before* touching `rt->job_list` and appends it there only if the hook returns false |
| `JS_ExecutePendingJob` | expressed with `JS_JobRun` + `JS_JobFree`; ordering unchanged |
| promise settle | reaction jobs are tagged with the **derived** promise's tag (read from the reaction's resolving function), falling back to the settled promise's tag |
| promise hook | `RESOLVE` now fires for rejections too: Node's `promiseResolve` means *settled* |
| async function | `js_async_function_resume` is wrapped so the host sees `(tag, entering)` around every body |
| `build_backtrace` | appends whatever `JS_SetAsyncStackHook` returns, for the string path only |
| `JS_FreeRuntime` | still frees `rt->job_list`; the host-owned queue is not in it |

New public entry points (declared in `crates/ln-engine/src/ffi.rs`, not in the committed
bindings):

```c
typedef struct JSJob JSJob;
typedef bool JSJobQueueHook(JSRuntime *rt, JSJob *job, void *opaque);
void     JS_SetJobQueueHook(JSRuntime *rt, JSJobQueueHook *hook, void *opaque);
JSContext *JS_JobContext(JSJob *job);
int64_t  JS_JobTag(JSJob *job);
void     JS_JobSetTag(JSJob *job, int64_t tag);
int      JS_JobRun(JSRuntime *rt, JSJob *job, JSContext **pctx);   /* 1 = ran, -1 = threw */
void     JS_JobFree(JSRuntime *rt, JSJob *job);

void     JS_SetPromiseTag(JSContext *ctx, JSValueConst promise, int64_t tag);
int64_t  JS_GetPromiseTag(JSContext *ctx, JSValueConst promise);

typedef void JSAsyncFunctionHook(JSContext *ctx, int64_t tag, bool entering, void *opaque);
void     JS_SetAsyncFunctionHook(JSRuntime *rt, JSAsyncFunctionHook *hook, void *opaque);

typedef char *JSAsyncStackHook(JSContext *ctx, void *opaque);
void     JS_SetAsyncStackHook(JSRuntime *rt, JSAsyncStackHook *hook, void *opaque);
char    *JS_DescribeStackFrame(JSContext *ctx, int level);          /* "name (file:line:col)" */
void     JS_FreeStackFrameDesc(JSContext *ctx, char *desc);
void    *JS_Malloc(JSContext *ctx, size_t size);                    /* the runtime's allocator */
void     JS_Free(JSContext *ctx, void *ptr);
```

Call sites that create jobs, all of which now pass a tag: `fulfill_or_reject_promise`,
`perform_promise_then` (already-settled), `js_promise_resolve_thenable_job`,
`js_global_queueMicrotask`, dynamic import and `FinalizationRegistry` (tag 0: the host tags those
around its own wrapper, or leaves the enclosing context in place).

## 2. The mark hook that was not needed

The pre-implementation design added a cycle-collector root hook so a pending job's payload could
not be collected. It cannot be collected in the first place: the job holds a real reference count
on each duplicated argument, and `gc_scan` treats any object whose count survives `gc_decref` as a
root. The hook would have been dead code, so the patch does not include it;
`crates/ln-engine/tests/jobs.rs` forces a collection between enqueue and run with a cyclic payload
to prove the reasoning.

## 3. How the runtime uses it

```
promise INIT hook ──▶ async id, JS_SetPromiseTag(promise, id)
        │
        ▼
  promise settles ──▶ js_enqueue_job(..., tag = derived promise's id)
        │
        ▼
  host hook ──▶ JobQueue { id, tag, handle }
        │
        ▼
  loop ──▶ Engine::next_job_tag ──▶ before(tag) ──▶ JS_JobRun ──▶ after(tag) ──▶ JS_JobFree
```

`tag` is the only datum the scheduler needs. `async_hooks` then has everything: `init` from the
promise hook, `before`/`after` from the job runner, `destroy` from the stdlib's teardown plus a
promise `FinalizationRegistry`, `promiseResolve` from the promise hook's `RESOLVE`.

Host-created jobs are allocated through `JS_EnqueueJob` while the hook is installed, so they land
in the same queue and can be tagged with `JS_JobSetTag`. onde does not create any today (its host
tasks are Rust closures in `ln-sched`), so the setter is marked unused rather than wired to a
caller that does not exist.

## 4. Patch workflow

```
vendor/rquickjs-sys          the crate, byte-for-byte rquickjs-sys 0.14.0 except:
  quickjs/                   quickjs-ng 0.17.0 sources (docs/tests/examples pruned)
  quickjs/quickjs.{c,h}      the patch
  build.rs                   + rerun-if-changed=quickjs
vendor/job-queue-hook.patch  the delta, applies with `patch -p1` from vendor/rquickjs-sys
```

- CI job 1: `patch -p1 --dry-run` the patch against a pristine checkout, build, run the corpus.
- CI job 2 (weekly): fetch the newest quickjs-ng tag, apply the patch, build, run the corpus; open
  an issue with the failing hunk when it no longer applies (`.github/workflows/engine-rebase.yml`).
- The patch stays one file with a message that can be sent upstream verbatim.

Rebase procedure, in full: `vendor/README.md`.

## 5. Upstreaming

A generic `JS_SetJobQueueHook` + opaque `JSJob` is useful to any embedder that wants an external
loop, and the `RESOLVE`-on-rejection fix is a bug in the existing hook. Both are worth sending
upstream as one patch. The async-function and async-stack hooks are more onde-specific (they pass
a host-owned `int64_t`), so they can stay behind the same patch or be dropped if upstream objects;
the fallback is the same code with `#ifdef ONDE_ENGINE_HOOKS`.

Note for 0.18.0: the dynamic-import API changed (`JS_SetModuleLoaderFunc2` attributes,
`JS_FinishDynamicImport`) and `JSInterruptHandler` takes a `JSContext *` now. Rebasing this patch
onto 0.18 means rebasing rquickjs's loader with it; see `m6-plan.md` §10.1.

## 6. Failure modes and guards

| Failure | Guard |
|---|---|
| Host forgets `JS_JobFree` | `Engine::drop` asserts the queue is empty; `JobQueue` counts adopted vs freed |
| Host frees a job twice | handles are moved, never copied; the only free is `JobQueue::free` after a pop |
| Hook installed but something still awaits `JS_IsJobPending` | `Engine::has_jobs` debug-asserts the engine list is empty |
| Tag read on a non-promise | `JS_GetPromiseTag` returns 0 and does not throw |
| Freeing the runtime with queued jobs | `Engine::drop` uninstalls the hook, clears the queue, then drops the engine |
| Queued value collected mid-flight (G11) | refcount rooting, plus the forced-GC test |
| Struct layout drifting away from the bindings | `JSValue` stays 16 bytes (bindings assert it); the patched C adds no changes to public structs |
| Patch silently changing ordering | the whole corpus runs on the patched engine; any diff is a build failure |
| C edit not rebuilding (`rerun-if-changed`) | the vendored `build.rs` watches `quickjs/` (m6-plan §10.3) |
