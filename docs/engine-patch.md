# Engine patch: host-owned job queue (M6)

Status: designed, not applied. Target: `quickjs-ng` 0.17.x.
Purpose: give the scheduler per-job identity and full queue ownership, which ADR-0002 needs for
`async_hooks` / `AsyncLocalStorage` across promise jobs. Nothing else in the runtime depends on
this patch.

## 1. Current plumbing (what we are changing)

```c
/* quickjs.c (abridged) */
typedef struct JSJobEntry {
    struct list_head link;
    JSContext *ctx;
    JSJobFunc *job_func;
    int argc;
    JSValue argv[];          /* js_dup'ed, freed after the job runs */
} JSJobEntry;

struct JSRuntime { ... struct list_head job_list; ... };

int JS_EnqueueJob(JSContext *ctx, JSJobFunc *job_func, int argc, JSValueConst *argv)
{
    JSJobEntry *e = js_malloc(ctx, sizeof(*e) + argc * sizeof(JSValue));
    e->ctx = ctx; e->job_func = job_func; e->argc = argc;
    for (i = 0; i < argc; i++) e->argv[i] = js_dup(argv[i]);
    list_add_tail(&e->link, &ctx->rt->job_list);
    return 0;
}

int JS_ExecutePendingJob(JSRuntime *rt, JSContext **pctx) { /* pop head, call, free, return -1/0/1 */ }
```

Call sites that create jobs (all in `quickjs.c`, except the public API):

| Site | Job |
|---|---|
| `fulfill_or_reject_promise` | `promise_reaction_job`, one per registered reaction, appended at settle |
| `js_promise_resolve_thenable_job` | adopts a thenable |
| `js_global_queueMicrotask` | `js_microtask_job` |
| `js_dynamic_import_job`, `js_finish_dynamic_import_job` | dynamic `import()` (master only; 0.17.0 uses the sync loader) |
| module evaluation | TLA continuations |
| `js_finrec_job` | `FinalizationRegistry` callbacks |

All of them already append at the tail in the right order. We are not changing ordering; we are
adding a way to *observe* and *own* the entry.

## 2. Public surface added

```c
typedef struct JSJob JSJob;

/* Called instead of list_add_tail when set. Return true if the host took ownership;
   false to fall back to the internal list (useful for mixed modes and tests). */
typedef bool JSJobQueueHook(JSRuntime *rt, JSJob *job, void *opaque);
JS_EXTERN void JS_SetJobQueueHook(JSRuntime *rt, JSJobQueueHook *hook, void *opaque);

JS_EXTERN JSContext *JS_JobContext(JSJob *job);
JS_EXTERN int64_t    JS_JobTag(JSJob *job);
JS_EXTERN void       JS_JobSetTag(JSJob *job, int64_t tag);

/* Same contract as JS_ExecutePendingJob's per-job step:
   1 = ran, -1 = exception pending in *pctx. 0 is not possible. */
JS_EXTERN int  JS_JobRun(JSRuntime *rt, JSJob *job, JSContext **pctx);

/* Frees the job and its dupped arguments. Must be called exactly once per job. */
JS_EXTERN void JS_JobFree(JSRuntime *rt, JSJob *job);

/* Tags the promise so that jobs created while it settles inherit the tag.
   This is how a promise reaction job learns its async_id. */
JS_EXTERN void JS_SetPromiseTag(JSContext *ctx, JSValueConst promise, int64_t tag);
JS_EXTERN int64_t JS_GetPromiseTag(JSContext *ctx, JSValueConst promise);

/* Cycle-collector root hook for host-owned jobs. Called from the runtime mark phase;
   the host walks its queue and marks each job's arguments. Without this, a job that
   outlives a GC can lose a cyclic argument graph (rt->job_list is not marked today). */
typedef void JSJobMarkHook(JSRuntime *rt, JS_MarkFunc *mark_func, void *opaque);
JS_EXTERN void JS_SetJobMarkHook(JSRuntime *rt, JSJobMarkHook *mark, void *opaque);
JS_EXTERN void JS_JobMark(JSJob *job, JS_MarkFunc *mark_func);
```

## 3. Internal changes

1. `JSJobEntry` gains `int64_t tag`. `JSJob` is a typedef for it (keeps ABI/name churn down).
2. `js_enqueue_job(ctx, func, argc, argv, tag)` replaces the body of `JS_EnqueueJob`:
   allocate and dup as today, then

   ```c
   if (rt->job_queue_hook && rt->job_queue_hook(rt, e, rt->job_queue_hook_opaque))
       return 0;                      /* host owns e now */
   list_add_tail(&e->link, &rt->job_list);
   return 0;
   ```
3. `JS_EnqueueJob(ctx, f, n, a)` → `js_enqueue_job(ctx, f, n, a, 0)`.
4. `JS_ExecutePendingJob` → find head, unlink, `JS_JobRun`, then keep the existing
   free/lifetime code. `JS_JobRun` contains that code minus the list manipulation.
5. `fulfill_or_reject_promise`: pass `s->async_tag` into the `promise_reaction_job` enqueues.
   `js_promise_resolve_thenable_job` and the TLA continuation do the same. `js_microtask_job`
   passes 0 (or the tag set by the host via `JS_JobSetTag` after enqueue).
6. `JS_SetPromiseTag` writes `JSPromiseData.async_tag` (new field, `int64_t`, default 0).
7. `js_free_rt` keeps freeing `rt->job_list` (unchanged). Host-owned jobs are **not** in that
   list, so the host must free them before `JS_FreeRuntime`; with the hook installed,
   `assert(list_empty(&rt->job_list))` in `JS_FreeRuntime` catches misuse.
8. `JS_MarkRuntime` (the mark phase) calls `job_mark_hook` if set, which lets the host mark the
   arguments of every job it owns. This closes the G11 hazard documented in ADR-0002: today
   `rt->job_list` is never traversed, so a cyclic value held only by a pending job is
   collectable. Host jobs allocated pre-patch should mirror this by keeping their payloads in a
   rooted side table.

Net: ~150 lines, no public API removal, no behaviour change when the hook is unset.

## 4. How the runtime uses it

```
promise hook (INIT)  ──▶ async_id assigned; JS_SetPromiseTag(promise, id)
        │
        ▼
  promise settles
        │
        ▼
  js_enqueue_job(..., tag = promise.async_tag)
        │
        ▼
  host hook → Scheduler::push(Job { id, tag, handle })
        │
        ▼
  loop → Scheduler::run → JS_JobRun(handle) → before(tag) / after(tag)
        │
        ▼
  JS_JobFree(handle)
```

`tag` is the only new datum the scheduler needs. `async_hooks` then has everything: `init` from
the promise hook, `before`/`after` from the job runner, `destroy` from a weak/GC hook plus
explicit release, `promiseResolve` from the promise hook's RESOLVE.

Host-created jobs (e.g. a Rust task that needs to run at microtask priority, or a wrapping op)
are allocated by the host through `JS_EnqueueJob` while the hook is installed, so they get the
same treatment and can set their own tag with `JS_JobSetTag`.

## 5. Patch workflow

```
vendor/quickjs-ng            git submodule, pinned tag
vendor/quickjs-ng.patch      0001-job-queue-hook.patch (git format-patch)
vendor/rquickjs-sys          rquickjs-sys + [patch.crates-io] entry
```

- CI job 1: `git apply --check` the patch on the pinned tag; build; run the ADR-0002 corpus.
- CI job 2 (weekly): rebase onto the newest tag; if it applies and the corpus passes, open a PR
  bumping the pin. If it fails, open an issue with the failing hunk (R3 trigger).
- CI job 3: `bindgen` with the patched header; commit generated bindings for the supported
  triples so users do not need libclang.
- Keep the patch as one commit with a message that can be sent upstream verbatim.

## 6. Upstreaming

Send the PR as soon as M1's spike proves the API shape, not after M6. A generic
`JS_SetJobQueueHook` + opaque `JSJob` is useful beyond our project (any embedder that wants to
integrate with an external loop). If upstream rejects it, the patch stays small and local, and
the fallback is the same code with `#ifdef LITE_NODE` around the hook.

## 7. Failure modes and guards

| Failure | Guard |
|---|---|
| Host forgets `JS_JobFree` | Debug build: job count assertion at loop exit; leak counter in `--trace-events` |
| Host frees a job twice | Handle is opaque and moved; `JobHandle` is `!Copy` in Rust |
| Hook installed but some site still awaits `JS_IsJobPending` | `is_job_pending()` in `ln-engine` asserts the engine list is empty in debug builds |
| Tag read on a non-promise | `JS_GetPromiseTag` returns 0 and does not throw |
| Freeing runtime with queued jobs | `JS_FreeRuntime` assertion + teardown order test (I10) |
| Queued value collected mid-flight (G11) | Mark hook + a test that forces GC between enqueue and run with a cyclic payload |
| Patch silently changes ordering | Corpus C1–C12 must be byte-identical before/after the patch; any diff is a build failure |
