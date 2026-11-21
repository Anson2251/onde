# M6 implementation plan — engine patch and async context

This is the working contract for M6. [roadmap.md](roadmap.md#m6--engine-patch-and-async-context--4-w)
says *what* ships; this page says where it lives, what the engine owns versus what the runtime
owns, and what is deliberately left out. The engine delta is specified in
[engine-patch.md](engine-patch.md); the runtime decision is
[ADR-0009](adr/0009-async-context.md).

Status: **complete on 2026-11-21.** WP0–WP7 all landed. §12 records the outcome, the deviations
taken while implementing, and the acceptance numbers.

M6 is the only milestone that changes the engine itself. Before it, quickjs-ng owned the microtask
queue and jobs were anonymous: the scheduler could say "run the next job" and nothing more.
`async_hooks` cannot be built on that, because it needs to know *which* asynchronous resource a
job belongs to and when that resource was created. M6 therefore does three things at once:

1. **Vendors and patches the engine** so the host owns the job queue and every job carries an
   `int64_t` tag (`vendor/`, `crates/ln-engine/src/{ffi,jobs}.rs`).
2. **Moves the queue into Rust** and makes the runtime the only thing that runs a job, in
   `ln-engine`, without teaching `ln-sched` anything about the engine.
3. **Builds `async_hooks` on top**, split between Rust (identity and execution context) and
   JavaScript (hooks, `AsyncLocalStorage`, `AsyncResource`).

Pinned engine: **quickjs-ng 0.17.0**, the release rquickjs master pins and the newest one whose C
API still matches rquickjs 0.14's committed bindings (§10.1 explains why not 0.18.0).

## 1. What ships, in one table

| Area | Ships | Does not ship (documented) |
|---|---|---|
| Engine | host-owned job queue, per-job `int64_t` tag, promise tags, `RESOLVE` for rejections, async-function context hook, async-stack hook, `JS_Malloc`/`JS_Free` | GC mark hook (proved unnecessary, §3.4), upstream PR (patch is kept rebaseable instead) |
| Vendoring | `vendor/rquickjs-sys` (rquickjs-sys 0.14.0 + quickjs-ng 0.17.0 + one patch), `[patch.crates-io]`, hand-written FFI, `vendor/job-queue-hook.patch`, weekly rebase CI | bindgen at build time (bindings are committed), a git submodule (the crate is vendored whole) |
| `async_hooks` | `createHook` (`init`/`before`/`after`/`destroy`/`promiseResolve`), `executionAsyncId`, `triggerAsyncId`, `executionAsyncResource`, `asyncWrapProviders` | promise ids for resources created before the module was loaded (D54) |
| `AsyncLocalStorage` | `run`, `getStore`, `enterWith`, `exit`, `disable`, `withScope` (+ `RunScope.dispose`), static `bind` | `snapshot()` (D55) |
| `AsyncResource` | constructor (`type`, `triggerAsyncId`, `requireManualDestroy` accepted), `asyncId`, `triggerAsyncId`, `runInAsyncScope`, `bind`, `emitDestroy`, static `bind` | nothing else |
| Async stacks | `--async-stack-traces`: `at async <fn> (file:line:col)` stitched through the async-id chain for errors created inside async functions | it is opt-in and does not rewrite already-created stacks (D56) |

## 2. The engine patch and the vendored crate

```
vendor/rquickjs-sys              rquickjs-sys 0.14.0, byte-for-byte except:
  quickjs/*                      quickjs-ng 0.17.0 sources
  quickjs/quickjs.c              + the patch (~260 added lines including comments)
  quickjs/quickjs.h              + the declarations
  build.rs                       + rerun-if-changed=quickjs (see §10.3)
vendor/job-queue-hook.patch      the whole C delta, applies with `patch -p1`
vendor/README.md                 version policy, rebase procedure, what the patch changes
```

The workspace patches the crate in:

```toml
[patch.crates-io]
rquickjs-sys = { path = "vendor/rquickjs-sys" }
```

No bindgen runs at build time. The patched entry points are declared by hand in
`crates/ln-engine/src/ffi.rs`, which is smaller and more reviewable than regenerating 300 KB of
bindings for ten functions; the committed bindings stay untouched, and a library that regenerates
them for other targets is unaffected.

What the patch adds, in one line each:

| Added | Why |
|---|---|
| `JS_SetJobQueueHook` + opaque `JSJob` | the host must own every enqueued job, in the engine's order |
| `JS_JobRun`/`JS_JobFree`/`JS_JobContext`/`JS_JobTag`/`JS_JobSetTag` | move-only job handles with a payload the engine never interprets |
| `JSPromiseData.async_tag` + `JS_SetPromiseTag`/`JS_GetPromiseTag` | a job inherits the tag of the promise whose reaction it is |
| `RESOLVE` promise hook fires for rejections too | Node's `promiseResolve` means *settled* |
| `JS_SetAsyncFunctionHook` | lets the host run an async function's body as that function's own promise |
| `JS_SetAsyncStackHook` + `JS_DescribeStackFrame` | `--async-stack-traces` |
| `JS_Malloc`/`JS_Free` | host buffers the engine frees must use the runtime's allocator (rquickjs installs its own) |

The C is tested through Rust: `crates/ln-engine/tests/jobs.rs` drives the queue directly, and the
whole conformance corpus runs on the patched engine, so "no behaviour change when nothing is
installed" is checked on every build.

## 3. The host-owned queue

### 3.1 Ownership

```
engine enqueues ──▶ hook ──▶ JobQueue (VecDeque<*mut JSJob>) ──▶ pop ──▶ JS_JobRun
                                                                        │
                                                                    JS_JobFree
```

`ln-engine::jobs::JobQueue` owns the pointers; `Engine::run_next_job` is the only place a job is
run or freed. A job is moved, never copied, and `Engine::drop` uninstalls the hook, frees what is
left, and asserts that nothing was adopted and not released. `Engine::has_jobs` asserts in debug
builds that the engine's own `rt->job_list` stays empty.

`ln-sched` stays engine-free (ADR-0002's split). The roadmap's "ln-sched now holds `JSJob`
handles" was the wrong shape: it would put raw engine pointers in the crate whose whole point is
to be testable without an engine. The scheduler keeps owning *policy* (ticks before microtasks,
mailbox, budget); `ln-engine` owns the *queue*; `ln-runtime` brackets each job with the
async-hooks pair. This is recorded as deviation 1 in §12.

### 3.2 Ordering and the pump

The hook runs exactly where `list_add_tail` used to, so the engine's order is preserved. The
runtime still seeds one scheduler microtask per engine job (unchanged from M1): that is what lets
`process.nextTick` jump ahead of the remaining promise jobs, and it means the M1/M2 ordering
corpus is byte-identical. `Engine::next_job_tag()` is read *before* the run so `before` fires with
`executionAsyncId()` already set to the job's tag, which is what Node promises.

### 3.3 Tags: the derived promise, not the settled one

A `then` callback runs as the promise `.then()` created, not as the promise that settled. The
patch therefore reads the tag from the reaction's resolving function when enqueuing
(`js_reaction_job_tag`) and falls back to the settled promise's tag. Getting this wrong is
invisible until `triggerAsyncId()` or an ALS store is observed from a `then` callback, which is
why it has a dedicated test (`reaction_jobs_carry_the_derived_promises_tag`).

### 3.4 No GC mark hook

`engine-patch.md` §2 sketched a mark hook for host-owned jobs, reasoning that a pending job's
payload could be collected (ADR-0002 G11). It cannot: a job holds a real reference count on each
duplicated argument, and the cycle collector treats "refcount survived `gc_decref`" as a root, so
the payload and everything reachable from it survive. The patch does not add the hook, and
`a_job_payload_survives_gc_between_enqueue_and_run` forces a collection between enqueue and run
with a cyclic payload to prove it.

## 4. Ids and the execution context

`crates/ln-runtime/src/async_hooks.rs` owns three things:

* **`next_id`**: a monotonic `i64` per isolate, starting at 2. `1` is the root, which is what
  `executionAsyncId()` returns outside any resource (Node does the same).
* **`current`**: the id of whatever is running. Every entry point that runs user JavaScript moves
  it: the job pump (`before`/`after` per engine job), the stdlib dispatch for timers, ticks,
  immediates and ops (`host.asyncEnter`/`asyncLeave`), and async function bodies.
* **`wants`**: a bitmask of the event kinds JavaScript subscribed to. Nothing crosses the boundary
  for a kind nobody listens to.

Both sides of the tracker start *lazily*: loading `node:async_hooks` (or passing
`--async-stack-traces`) is what flips the flag, after which the stdlib mints ids and the engine
hooks do their work. The engine hooks themselves are installed at boot but return immediately
while the flag is clear — rquickjs borrows the runtime for the whole of a JavaScript call, so a
host function cannot install them later, and an inert hook costs one C-to-Rust call per promise
(measured as noise). Before the lazy start, tracking at boot cost ~10% of the HTTP server and
~50% of a callback-heavy benchmark (§10.4).

### 4.1 Promise ids

The engine's promise hook does the minimal work: on `INIT` allocate an id and tag the promise; on
`RESOLVE` read the tag and emit `promiseResolve`. The *trigger* is the parent promise's tag when
`.then()` created the promise, and the running code's id otherwise — Node's rule, and the one that
makes `triggerAsyncId()` inside a `then` point at the promise it came from.

Ids are allocated even when no hook is enabled, so a hook enabled later still sees stable,
monotonic ids for promises that already exist. The tag write is one store; the measured cost of
the always-installed hook is under 1% of a 1M-promise loop (M7 may make it conditional on the
module ever being loaded).

### 4.2 Async function bodies

quickjs has no notion of an async function's own async context: during the synchronous prefix of
an `async function`, the running code is the caller, so a promise created there is attributed to
the caller. Node attributes it to the function's promise, and both `executionAsyncId()` and
`AsyncLocalStorage` depend on that.

The patch adds `JS_SetAsyncFunctionHook`, fired around every async-function body with the tag of
the promise representing the invocation. Rust pushes the previous `current` on a stack, sets the
function's id for the body, and restores on the way out. This is what makes

```js
als.run("A", async () => {
  await 1;
  als.getStore(); // "A", even though the promise that resumes here was created later
});
```

work for chains of any depth, and it is why async stack traces can name the awaiting function.

### 4.3 Trigger chain

`current` alone is not enough for `getStore()`: a job that runs later must see the store of the
resource that created it, not of whatever happens to be running. The store table is therefore
keyed by async id and filled at `init` time from the *currently executing* id — not from the
trigger id, because `p.then(cb)` called inside `run()` must inherit the run's store even when `p`
was created outside it. That single rule is the whole of ALS propagation; everything else is
bookkeeping.

## 5. The JavaScript layer

`js/lib/async_hooks.js` (bundled and minified like the rest of the stdlib) owns what is policy:

* the enabled-hook arrays, split per callback so the hot path does not re-check five properties;
* the `id -> { type, trigger }` table behind `triggerAsyncId()` and `executionAsyncResource()`;
* the `AsyncLocalStorage` store tables, the `RunScope` handle for `withScope`, and `AsyncResource`;
* argument validation with Node's error codes (`ERR_INVALID_ARG_TYPE`, `ERR_ASYNC_CALLBACK`,
  `ERR_ASYNC_TYPE`).

It is installed as `__ln_async_event` (a non-enumerable global, like the other Rust→JS hooks), and
it calls back into `host.asyncEnable(mask)`, `host.asyncInit`, `host.asyncEnter`, `host.asyncLeave`
and `host.asyncDestroy`. The split is deliberate: identities cannot be forged in JavaScript, and
hook semantics do not need a rebuild of the engine to change.

Promise resources are registered with a `FinalizationRegistry` so the table is pruned when a
promise dies — that is also when Node emits a promise's `destroy`. The promise itself is held
through a `WeakRef` only when a `destroy` hook is active; otherwise the entry is just
`{ type, trigger }` and the registry prunes it. Without that, 1M tracked promises would leak their
entries, which is exactly what the leak test measures.

## 6. Event dispatch

Rust pushes events synchronously, at the point they happen, and only when subscribed:

| Event | Emitted by | When |
|---|---|---|
| `init` | promise hook, `host.asyncInit` | resource creation, before the creator continues |
| `before`/`after` | job pump, `host.asyncEnter`/`asyncLeave`, async-function hook | around the callback, with `current` already the resource |
| `destroy` | stdlib (timer/tick/op teardown), promise finalizer | when the resource is finished or collected |
| `promiseResolve` | promise hook `RESOLVE` | at settlement, for fulfilments and rejections |

A hook that throws does not unwind through the engine's C frames: the exception is caught,
converted and parked in `AsyncTracker::take_errors`, and the runtime reports it through
`uncaughtException` at the next checkpoint boundary.

## 7. Async stack traces (`--async-stack-traces`)

Off by default; recording a creation site per promise is measurable and the roadmap calls for
opt-in.

When on, the tracker records `name (file:line:col)` for every promise created *inside an async
function body* (the frame where that function was called, i.e. its `await` site), walks the
trigger chain when an `Error` is constructed, and hands the engine a block of

```
    at async outer (/tmp/t4.js:2:32)
```

lines through `JS_SetAsyncStackHook`, which appends them to the error's stack while it is being
built. Recording only promises created inside async bodies is what keeps the output Node-shaped: a
`.then()` chain at module scope records nothing, because there is no async activation to name.

`JS_DescribeStackFrame` is the C side: it walks `rt->current_stack_frame` and formats one frame
with the engine's own line/column machinery. It is only called when the flag is on.

## 8. File map

```
vendor/rquickjs-sys/**                       vendored crate + patched quickjs-ng 0.17.0
vendor/job-queue-hook.patch                  the C delta (applies with patch -p1)
vendor/README.md                             version policy and rebase procedure
crates/ln-engine/src/ffi.rs                  hand-written declarations for the patch
crates/ln-engine/src/jobs.rs                 JobQueue: ownership, ordering, teardown
crates/ln-engine/src/lib.rs                  Engine: hook install, run_next_job, promise/stack hooks
crates/ln-engine/tests/jobs.rs               queue tests, incl. forced GC between enqueue and run
crates/ln-runtime/src/async_hooks.rs         ids, execution context, trigger chain, async stacks
crates/ln-runtime/src/host/mod.rs            host.async* primitives
crates/ln-runtime/src/lib.rs                 promise/async-function/stack hooks, job bracketing
crates/ln-runtime/src/host/…                 (unchanged; ops/timers mint ids in JS)
js/lib/async_hooks.js                        createHook, ALS, AsyncResource, validation
js/bootstrap.js                              async ids for timers/immediates/ticks/microtasks/ops
test/async/                                  ALS matrix (96 cells), hook semantics, 1M-promise leak
test/js/lib/async_hooks.test.js              module surface and validation
test/conformance/async_hooks/                two corpus cases recorded from Node
```

## 9. Work packages (as they landed)

| WP | Work | Result |
|---|---|---|
| WP0 | check upstream versions, vendor `rquickjs-sys`, pin quickjs-ng 0.17.0, apply the job-queue patch, prove the corpus unchanged | 230/230 before any feature work |
| WP1 | `ffi` + `JobQueue`, move the pump off `JS_ExecutePendingJob`, teardown assertions, queue tests | 6 engine tests |
| WP2 | promise tags, `RESOLVE`-on-reject, the derived-promise rule | `PumpOutcome` carries the tag |
| WP3 | tracker: ids, `current`, enter/leave, subscription mask, hook-error parking | 1 host module |
| WP4 | `async_hooks` module: hooks, ids, `AsyncResource`, ALS, validation | 37 surface assertions |
| WP5 | propagation: timers, immediates, ticks, microtasks, ops, async functions | 96-cell matrix equals Node |
| WP6 | async stack traces: C helpers, trigger recording, CLI flag, filtering | `at async` lines match Node's shape |
| WP7 | tests, docs, CI, performance measurement | §12 |

## 10. Deliberate limits and follow-ups

### 10.1 Why 0.17.0 and not 0.18.0

quickjs-ng 0.18.0 (2026-11-01) is newer than the 0.17.0 pinned here. It is not usable under
rquickjs 0.14's committed bindings: 0.18 changes `JS_SetModuleLoaderFunc2` to take an `attributes`
argument and makes `JS_FinishDynamicImport` mandatory, while rquickjs calls the old shapes and
never finishes a dynamic import. Dropping 0.18 sources under these bindings would break
`import()` at runtime. Moving to 0.18 is an M7 task (with rquickjs that binds it) and is tracked
as rebase debt in §11 of [roadmap.md](roadmap.md#risks).

0.17.0 adds only three public functions relative to 0.16.2 and changes no signature, which is why
the committed bindings still match.

### 10.2 Async resources for net/http/child processes

Sockets, servers, `http` requests and child processes do not mint their own resource ids yet.
Their callbacks inherit the context of whatever dispatched them, so an ALS store created before a
`socket.on("data")` listener runs is still visible, but the socket itself is not an async resource
and `executionAsyncId()` inside its events is the dispatching context. Recorded as D57. The
matrix in `test/async/` covers the boundaries the exit criteria name.

### 10.3 Rebuild trap: `rerun-if-changed`

The vendored `build.rs` emitted only `rerun-if-env-changed`, so editing `quickjs.c` did not rebuild
the C (cargo disables its package-wide default when any `rerun-if-*` is present). The vendored copy
adds `rerun-if-changed=quickjs`; without it, a patch edit silently kept the old object file — which
is exactly how the first version of the derived-promise rule appeared not to work.

### 10.4 Performance

Measured on this machine (release):

| Workload | Node 26 | lite before M6 | lite with M6, `async_hooks` unused | lite with hooks active |
|---|---|---|---|---|
| 1M `Promise.resolve` | 0.11 s | 0.22 s | 0.22 s | 1.14 s |
| 600k callbacks (ticks, microtasks, timers) + 200k-link promise chain, CPU user time | — | 0.76 s | **0.77–0.83 s** | — |
| HTTP hello, 100 keep-alive conns, 100k requests | 29.9–32.3k req/s | 14.3k req/s | **13.9–15.1k req/s** | — |
| cold start `-e '1+1'` | — | 12.16 ms | **11.72 ms** | — |
| cold start `require("http")` | — | 21.00 ms | **18.43 ms** | — |

The first implementation started tracking at boot. That cost ~10% of HTTP throughput and ~50% of
the callback benchmark: every tick, microtask and timer paid three host calls (`asyncEnter`,
`asyncLeave`, `asyncDestroy`) and a closure, even though no hook existed. Gating tracking on
`require("async_hooks")` (with the engine hooks installed but inert) removed it; the remaining
HTTP difference is within run-to-run noise, and the callback benchmark is back at the pre-M6
number.

With hooks active, a callback costs ~1.2 µs of bookkeeping (the Rust↔JS crossing, the table
update and the hook call itself); Node, whose hooks are C++, pays less. M7's fast-path work
(persistent handles, interned type codes, a Rust-side trigger table) targets that gap. The HTTP
p99 measured during this rebench (100–150 ms for lite) is *not* M6: the pre-M6 binary showed the
same tail on the same loaded machine, and it is the M4 single-isolate queueing issue listed in
`m4-plan.md` §8.

### 10.5 Divergences recorded

D54–D58 in [compat.md](compat.md): late module load, no `snapshot()`, async frames only for
opt-in runs, no per-socket resources, and `executionAsyncResource()` returning `{}` for a promise
when no `destroy` hook is active.

## 11. Acceptance

| Gate | Result |
|---|---|
| Rust tests | **378** across the workspace, green |
| Conformance corpus | **232/232** under lite; **223/223** re-validated under Node |
| Differential harness | **223/223** byte-identical stdout + exit code |
| JS stdlib suites | **77/77** under node and lite |
| M6 acceptance (`test/async/run.sh`) | **3/3** — ALS matrix (96 cells), hook semantics, 1M-promise leak |
| HTTP rebench (100 conns, 100k requests) | 13.9–15.1k req/s lite vs 14.3k pre-M6 vs 29.9–32.3k Node, interleaved; no M6 regression beyond noise (§10.4) |
| M1 scheduler corpus | byte-identical (§3.2) |
| Engine queue | 6 tests, including forced GC between enqueue and run |
| Cold start | 11.72 ms (`-e`), 18.43 ms (`require("http")`), release, median of 20 |
| Hygiene | `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` |

## 12. Outcome (2026-11-21)

Everything in §1 ships. Deviations from the plan, all deliberate:

1. **`ln-sched` does not hold `JSJob` handles.** The queue lives in `ln-engine` and the runtime
   pumps it. This keeps `ln-sched` engine-free (its tests need no FFI) and puts the ownership
   invariants in the crate that already owns `unsafe`. `ln-sched` still owns ordering and budgets.
2. **The GC mark hook was dropped** (§3.4) — jobs already root their payloads through refcounts,
   and a forced-GC test replaces the hook.
3. **The patch also fixes `promiseResolve` for rejections** and **tags reactions with the derived
   promise**, both upstream deviations the milestone needed but `engine-patch.md` did not list.
4. **Two hooks beyond the job queue**: `JS_SetAsyncFunctionHook` (§4.2) and
   `JS_SetAsyncStackHook` (§7). Both are small, both are behind host callbacks that are null by
   default.
5. **The engine upgrade is 0.17.0, not "0.17.x"** as the old notes said, and not 0.18.0 (§10.1).
6. **`withScope` returns a `RunScope`** with `dispose()`/`Symbol.dispose`, matching Node 24+.
7. **Promise resources are weakly held** and pruned by a finalizer: without that, the resource
   table is a real leak at 1M promises (found by the leak test, which is why the test exists).
8. **`AsyncLocalStorage` inheritance uses the running id, not the trigger id**, which is what
   makes `p.then(cb)` inside `run()` inherit even when `p` was created outside.
9. **Tracking starts lazily.** The first implementation minted ids and entered contexts for every
   callback from boot; an HTTP rebench (§10.4) showed that costing ~10% of throughput and ~50% of
   a callback benchmark for programs that never use `async_hooks`. Loading the module (or
   `--async-stack-traces`) now starts it, the engine hooks stay installed but inert, and a
   resource created before that has no id — D54, widened from promises to every resource.
