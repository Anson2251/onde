# vendored engine

`vendor/rquickjs-sys` is the [rquickjs] 0.14.0 `rquickjs-sys` crate with its bundled
**[quickjs-ng] 0.17.0** sources patched to add the host-owned job queue described in
[`docs/engine-patch.md`](../docs/engine-patch.md) and used by `ln-engine` since M6.

Everything else in the crate is byte-for-byte the published release — `src/` (the committed
bindings), `quickjs.bind.h`, `wasm-shim/` — with one exception: `build.rs` gains a
`cargo:rerun-if-changed=quickjs` line. Without it cargo watches only the `rerun-if-env-changed`
entries that build script already prints, so editing `quickjs.c` would not rebuild the C. The
workspace patches the crate in with `[patch.crates-io]` in the root `Cargo.toml`, so `cargo`
resolves `rquickjs-sys 0.14.0` to this directory. No bindgen run is needed: the patch adds a handful of `extern "C"` declarations that
`ln-engine` writes by hand (`crates/ln-engine/src/ffi.rs`), and the committed bindings stay
untouched.

## The patch

`job-queue-hook.patch` is the whole delta (one file pair, ~150 added lines). It applies to a
pristine quickjs-ng 0.17.0 tree:

```sh
cd vendor/rquickjs-sys
patch -p1 --dry-run < ../job-queue-hook.patch   # check
patch -p1 < ../job-queue-hook.patch             # apply
```

What it changes:

| Site | Change |
|---|---|
| `JSJobEntry` | becomes public opaque `JSJob`, gains an `int64_t tag` |
| `JS_EnqueueJob` | split into `js_enqueue_job(ctx, func, argc, argv, tag)`; offers the job to `JS_SetJobQueueHook` before touching `rt->job_list` |
| `JS_ExecutePendingJob` | expressed in terms of the new `JS_JobRun` / `JS_JobFree` |
| promise settle | reaction jobs carry the **derived** promise's tag (read from the reaction's resolving function), falling back to the settled promise's; the `RESOLVE` promise hook also fires for rejections (Node's `promiseResolve` means *settled*) |
| async function | `js_async_function_resume` is wrapped so the host is told which promise's body is running |
| `build_backtrace` | appends the host's `at async ...` lines, string path only |
| new API | `JS_SetJobQueueHook`, `JS_JobContext`, `JS_JobTag`, `JS_JobSetTag`, `JS_JobRun`, `JS_JobFree`, `JS_SetPromiseTag`, `JS_GetPromiseTag`, `JS_SetAsyncFunctionHook`, `JS_SetAsyncStackHook`, `JS_DescribeStackFrame`, `JS_FreeStackFrameDesc`, `JS_Malloc`, `JS_Free` |

Ordering is unchanged: the hook is called where `list_add_tail` used to be, so a host that hands
jobs straight back into its own FIFO sees exactly the engine's order. With no hook installed the
engine behaves as upstream (that is what the conformance corpus checks on every run).

The mark hook sketched in the original design turned out to be unnecessary: a job holds a real
reference count on each duplicated argument, and the cycle collector treats any object whose count
survives `gc_decref` as a root, so a pending job's payload cannot be collected. M6 proves this with
a forced-GC test between enqueue and run (`crates/ln-engine/tests/jobs.rs`) instead of adding the
hook.

`JS_Malloc`/`JS_Free` exist because rquickjs installs its own allocator: a buffer the engine frees
must come from the engine's allocator, which libc's `malloc` is not.

## Version policy

Pinned: **quickjs-ng 0.17.0** (2026-09-18), the release rquickjs master pins, and the newest one
whose C API is still compatible with rquickjs 0.14.0's committed bindings.

Not pinned: **0.18.0** (2026-11-01) is newer, but it changes the dynamic-import API
(`JS_SetModuleLoaderFunc2` grows an `attributes` argument, `JS_FinishDynamicImport` becomes
mandatory) and the `JSInterruptHandler` signature. rquickjs 0.14 calls the old shapes, so dropping
0.18 sources under these bindings would break `import()` at runtime and leave dynamic imports
unfinished. Moving to 0.18 means moving to an rquickjs that binds it; that is an M7 task with its
own corpus run, recorded in `docs/m6-plan.md` §10 and `docs/roadmap.md` (R3 rebase debt).

## Rebase procedure (per upstream release)

```sh
# 1. fetch the new tag beside the vendored tree
curl -L https://github.com/quickjs-ng/quickjs/archive/refs/tags/vX.Y.Z.tar.gz | tar -xz
# 2. copy the subset build.rs compiles (libregexp.c libunicode.c quickjs.c dtoa.c + headers)
# 3. re-apply the patch; a rejected hunk names the exact site to port
cd vendor/rquickjs-sys && patch -p1 < ../job-queue-hook.patch
# 4. rebuild and run the corpus; any ordering diff is a build failure
cargo test --all && ./test/conformance/run.sh && ./test/differential.sh
# 5. regenerate job-queue-hook.patch from the pristine tree
```

CI runs steps 1–4 weekly against the newest tag (`.github/workflows/engine-rebase.yml`) and opens
an issue when the patch no longer applies or the corpus changes.

[rquickjs]: https://github.com/DelSkayn/rquickjs
[quickjs-ng]: https://github.com/quickjs-ng/quickjs
