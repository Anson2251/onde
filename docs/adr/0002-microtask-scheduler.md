# ADR-0002: Microtask execution model

- Status: accepted
- Date: 2026-11-13
- Supersedes: none
- Related: [0001 engine baseline](0001-engine-baseline.md), [0003 event loop](0003-event-loop.md),
  [engine patch](../engine-patch.md)

## 1. Context

Node's observable behaviour is defined as much by *when* microtasks run as by what they do.
`process.nextTick` outranks promise reactions, exceptions in a microtask are reported before
the next microtask runs, and an unhandled rejection is reported only after the checkpoint
drains. A runtime that gets these wrong is not "onde"; it is a different language with a
familiar API.

QuickJS is an engine, not a runtime. In quickjs-ng (0.17.0, the pinned baseline) the entire
microtask facility is:

```c
/* quickjs.h */
typedef JSValue JSJobFunc(JSContext *ctx, int argc, JSValueConst *argv);
int  JS_EnqueueJob(JSContext *ctx, JSJobFunc *job_func, int argc, JSValueConst *argv);
bool JS_IsJobPending(JSRuntime *rt);
JSContext *JS_GetPendingJobContext(JSRuntime *rt);
int  JS_ExecutePendingJob(JSRuntime *rt, JSContext **pctx);
```

Internally (`quickjs.c`): a single per-runtime intrusive list, `rt->job_list`. `JS_EnqueueJob`
allocates a `JSJobEntry { ctx, job_func, argc, argv }`, `js_dup`s the arguments, and
`list_add_tail`s it. `JS_ExecutePendingJob` pops the head, calls the C function, frees the args,
and reports success/exception. Promise reactions, `queueMicrotask`, dynamic `import()` and
module-evaluation continuations are all pushed onto that one list by the engine itself.
(`FinalizationRegistry` cleanup callbacks are a job in ng master, but 0.17.0 appears to define
`js_finrec_job` without ever enqueueing it; we do not rely on cleanup callbacks — see
[compat.md](../compat.md).)

That is a correct *specification* microtask queue. It is not a sufficient *host* runtime queue.
This ADR records the gaps, the redesign, and the contract every later component must honour.

### 1.1 What we measured, not assumed

Node ground truth (`node v26.10.0`, darwin-arm64) and quickjs-ng ground truth
(`qjs 0.17.0`) on the same programs. Full sources in §9.

```
# p1: nextTick / promise / queueMicrotask interaction
node:  sync, tick1, tick2, micro1, then1, micro-from-tick
qjs :  sync, (no nextTick), qm1, then1, then2, qm2, qm-from-then2
```

Shared-FIFO ordering for `then` and `queueMicrotask` is **already correct** in quickjs-ng:
both are appended to the same tail. The gaps are everything else.

```
# p2: a microtask throws, after the handler is installed
node:  m1, uncaught: boom, m2, then1          # report happens *between* jobs
# p3: unhandled rejection timing
node:  t1, m1, unhandled: r1, timer           # reported after the queue drains, before timers
# p7: process.exit inside a microtask
node:  t1, m1, exit=0                          # remaining microtasks are dropped
# p8: handler enqueues a microtask
node:  h:x, m2, from-handler                   # handler runs inline; its jobs go to the tail
```

quickjs-ng, unpatched, cannot express any of these: there is no second priority level, no
per-job identity, and the std host loop prints one rejection notice at exit:

```
qjs q3.js  ->  stderr: "Possibly unhandled promise rejection: Error: boom", exit 1
```

## 2. Gap analysis

| # | Requirement (Node) | quickjs-ng 0.17.0 | Consequence for us |
|---|---|---|---|
| G1 | `process.nextTick` strictly outranks promise jobs, re-drained to exhaustion per pass | no such concept; one FIFO | Need a second host queue and a two-pass checkpoint |
| G2 | Per-job identity: async id, trigger id, origin, source location | `JSJobEntry` has `ctx`, `func`, `argc`, `argv` only | No `async_hooks`, no ALS across `.then`, no async stacks, no per-job diagnostics |
| G3 | Observe enqueue/execute | no hook; jobs are created inside `promise_reaction_job` paths | Need the engine patch (§8) for G2; enqueue ordering itself is already spec-correct |
| G4 | Report an unhandled rejection at the end of the checkpoint, once | tracker fires at *settle* (`is_handled=false`) and again at *handle* (`true`); std prints at exit | Host owns a pending-rejection table; defer reporting to checkpoint end; emit `rejectionHandled` on late attach |
| G5 | Explicit checkpoint after every host→JS callback | nothing is implicit; caller loops `JS_ExecutePendingJob` | Need a single owner and explicit checkpoint points |
| G6 | `uncaughtException` distinguished from job origin | `ExecutePendingJob` returns `-1` plus a pending exception in `*pctx` | Catch per job, emit inline, continue draining (C2, C8) |
| G7 | Bounded work, preemption | interrupt handler aborts bytecode with an internal, uncatchable exception | Budget between jobs; interrupt for within-job deadline; treat trip as fatal |
| G8 | Ordering across realms | one queue per runtime, entries carry their `ctx` | Keep a single scheduler; carry `ctx` per job (spec: one microtask queue per agent) |
| G9 | Lifetime | args are `js_dup`ed; `job_list` is not a GC root (refcount only) and is freed in `JS_FreeRuntime` | Host-owned jobs must free values *before* `JS_FreeRuntime`, or leak |
| G10 | `queueMicrotask` shares FIFO with reactions | already true (`js_microtask_job`) | Keep it; do not wrap it |
| G11 | Queued jobs keep their values alive | args are `js_dup`ed, but `rt->job_list` is **not traversed by the cycle collector** (it appears only in init/enqueue/execute/free, never in a mark phase) | In the patched build, job values become real GC roots via a mark hook (§8). Pre-patch, a cyclic graph held only by a pending job is collectable — the same narrow hazard every QuickJS embedder has; our own host jobs root their payloads in a side table |

Two non-gaps worth naming, because they are frequently "fixed" wrongly:

- **Job order within a settle is already spec-compliant.** Reactions are appended in
  registration order at settle time (`fulfill_or_reject_promise`). Do not re-implement.
- **New jobs enqueued by a running job already go to the tail.** Do not make the drain
  restart from the new head (that would starve and reorder; see C1/C5).

## 3. Decision

Three decisions, one model.

**D1. The host owns the queue; the engine owns the job body.**
A scheduler in `ln-sched` is the only component that drains microtasks. It holds an ordered
`VecDeque<Job>`. In the unpatched build, the engine-created variant wraps "call
`JS_ExecutePendingJob` once" and the engine's list stays authoritative for engine-created jobs;
in the patched build (M6), the enqueue hook hands the `JSJob` to the scheduler and the engine's
`job_list` is never used.
Both builds expose the same two queues and the same checkpoint contract, so the policy code
and every test is shared.

**D2. Two queues, three passes, one checkpoint.**

```
                 ┌──────────────────────────────┐
  nextTick ─────▶│ ticks   (priority)           │──┐
                 ├──────────────────────────────┤  │  pass A: drain to exhaustion
  then/await ───▶│ micros  (FIFO, engine order) │◀─┘  pass B: drain to exhaustion
  queueMicrotask │                              │     pass C: if ticks non-empty, goto A
                 └──────────────────────────────┘
                          │
                          ▼
                 flush unhandled rejections (once)
```

**D3. Every semantic that depends on per-job identity is deferred to the engine patch (M6).**
M1–M5 implement the checkpoint model, `nextTick`, rejection reporting and the exception channel
with no engine changes. `async_hooks`/ALS across promise jobs is the *only* thing that
genuinely requires the patch, and it is isolated behind one `Job` field (`async_id`), so nothing
else is reworked when the patch lands.

## 4. Invariants

These are the contract. Every one has a test; violating one is a release blocker.

| # | Invariant |
|---|---|
| I1 | Exactly one owner drains microtasks. No other code path calls `JS_ExecutePendingJob` (or `JS_JobRun`). |
| I2 | A checkpoint never begins inside a checkpoint. Nested requests are no-ops and return `Nested` (matches V8's `MicrotasksScope`). |
| I3 | The microtask queue is strictly FIFO. Jobs enqueued by a running job append to the tail. |
| I4 | `ticks` drains to exhaustion before `micros` in each pass, and is re-checked after `micros` drains. |
| I5 | Between checkpoints, JS runs to completion. No host code re-enters JS to "help it finish". |
| I6 | Checkpoints happen at explicit points only: after each host→JS callback, after top-level evaluation, after each module-evaluation step. Never inside an op. |
| I7 | A throwing job is reported and the drain continues. One bad microtask does not cancel its siblings. |
| I8 | An unhandled rejection is reported exactly once, after both queues are empty. A rejection handled later emits `rejectionHandled`. |
| I9 | Each checkpoint has an optional work budget. On trip: stop, keep queues intact, report fatal, free on teardown. |
| I10 | All queued jobs (and the JS values they hold) are freed before `JS_FreeRuntime`. |
| I11 | No `JSValue` crosses a thread boundary. Only owned plain-Rust payloads do. |
| I12 | JS callbacks never run while the scheduler is inside `poll`; completions are queued, then dispatched as macrotasks. |

## 5. Algorithm

```rust
pub fn checkpoint(&mut self) -> Checkpoint {
    if self.in_checkpoint {                       // I2
        return Checkpoint::Nested;
    }
    if self.stopped {                             // process.exit: no drain, no flush
        return Checkpoint::Stopped { jobs: 0 };
    }
    self.in_checkpoint = true;
    self.checkpoint_start = self.clock.now();
    self.executed = 0;

    loop {
        // pass A: nextTick, to exhaustion (ticks queued here run in this pass)
        while !self.ticks.is_empty() {
            if self.budget_exhausted() { return self.trip_budget(); }   // I9, before pop
            self.run(self.ticks.pop_front().unwrap());                  // I7: no Err
            self.executed += 1;
        }

        // pass B: engine microtasks, to exhaustion, in settle order (I3)
        while !self.micros.is_empty() {
            if self.budget_exhausted() { return self.trip_budget(); }
            self.run(self.micros.pop_front().unwrap());
            self.executed += 1;
        }

        // pass C: a tick queued from a microtask runs only after micros empty (C5)
        if self.ticks.is_empty() { break; }
    }

    self.in_checkpoint = false;
    self.flush_rejections();                      // I8
    Checkpoint::Drained { jobs: self.executed }
}
```

The real implementation carries a stop handle (`Rc<Cell<bool>>`) so `process.exit` can end the
drain between jobs without unwinding through the engine, and a sink mailbox: an
`uncaughtException` handler runs *inside* `Scheduler::run`, when the engine pump that would pick
up its promise jobs has already returned. The sink pushes a fresh pump into the mailbox and the
scheduler appends it to the microtask tail, preserving I3.

`trip_budget` clears `in_checkpoint`, emits [`Event::BudgetExceeded`], and returns with the
queues untouched — the next step is teardown, not retry.

`run(job)`:

1. Set `current_job = job.id` (debug builds; used by diagnostics).
2. Emit `before(async_id)` if async hooks are enabled (M6).
3. Execute the body:
   - `Job::Engine`: one `JS_ExecutePendingJob`. Returns `0` (nothing pending — cannot happen
     unless the engine and scheduler disagree; assert), `1` (ok) or `-1` (exception pending in
     `*pctx`). On `-1`, take the exception, format it, and **emit inline** (C2:
     `uncaught` is printed before `m2`).
   - `Job::Rust`: a closure over owned payload; `Err(e)` is emitted inline the same way.
4. Emit `after(async_id)`; assert the async context stack is back to the job's entry depth.
5. Drop the job, freeing its `JSValue`s (I10).

The budget check happens **before** executing, so a trip leaves the queue in a well-defined
state (job not started). Wall-clock budget is checked every job *and* inside long bytecode runs
via `JS_SetInterruptHandler`; an interrupt surfaces as an exception, which is treated as fatal
rather than JS-catchable (quickjs-ng's interrupt error is internal).

### 5.1 Why pass C exists

Removing it produces this failure (C5):

```js
queueMicrotask(() => { console.log('m1'); process.nextTick(() => console.log('tick-from-m1')); });
queueMicrotask(() => console.log('m2'));
```

Node prints `m1, m2, tick-from-m1`. Without pass C the tick would run between `m1` and `m2`.
With only pass C and no exhaustion in pass A, C1's `tick2` would be delayed behind `micro1`.
Both are in the corpus.

### 5.2 Why `micros` is not re-checked between ticks

A tick that enqueues a promise reaction (C1: `micro-from-tick`) must run that reaction only
after the ticks that were already queued (`tick2`) *and* the microtasks already queued
(`micro1`, `then1`). Pass A runs to exhaustion, then pass B runs the whole microtask queue in
settle order. That is exactly the observed Node order.

## 6. Job events: exceptions and rejections

### 6.1 Exceptions

`SchedEvent::Uncaught { job, origin, error }` is emitted synchronously, at the failing job, while
the checkpoint is still running. The runtime maps it to `process.emit('uncaughtException', err)`:

- listener present: call it (a JS call, inside the checkpoint but not a new checkpoint). Any
  microtask it queues lands at the tail and runs later in the same drain (C8).
- no listener: record fatal, abort the drain, set exit code 1, run `exit` listeners, terminate
  without draining further microtasks.

### 6.2 Rejections

State machine per promise, keyed by a stable identity (`JS_VALUE_GET_PTR` while we hold a `js_dup`):

```
              reject(promise, reason)                flush at checkpoint end
   (absent) ─────────────────────────▶ PENDING ─────────────────────────▶ REPORTED
                                          │                                   │
                                          │ handle(promise)                   │ handle(promise)
                                          ▼                                   ▼
                                       (removed)                     emit rejectionHandled
```

Rules:

- The tracker callback fires at settle with `is_handled=false` and at attach with `is_handled=true`.
  Treat `false` as "candidate", not "unhandled". This is the whole reason for the table.
- `flush_rejections` runs once, after both queues empty (C3: `unhandled` before the timer).
- A rejection created *inside* a job (C11: throwing `then` handler) is flushed at the end of the
  same checkpoint, not at process exit.
- Attach-before-flush removes the candidate silently (C4).
- Attach-after-flush queues `rejectionHandled` for the end of the enclosing checkpoint, after
  the catch reaction has run (C6: `caught:r3` before `rejectionHandled`). Emitting at the
  attach point would print the event before the handler that was just queued.
- We hold the `js_dup` only while the entry exists; the entry is removed on handle, on report
  (the dup is released, identity is kept as `(ptr, generation)` for late `rejectionHandled`), or
  on teardown. Growth is bounded by rejections within one checkpoint.

Default policy with no listeners: print `UnhandledPromiseRejection`, set exit code 1, and stop
at the end of that checkpoint (verified: with no listener, the pending timer never runs).

## 7. Reentrancy and ownership rules

| Rule | Why |
|---|---|
| R1. Only the loop calls `checkpoint()`. | I1, I2. Any other caller creates nested drains or reorders jobs. |
| R2. Ops never pump. Resolving a promise only enqueues; the loop drains. | I5. Pumping from an op runs JS while a native frame is mid-callback. |
| R3. `process.exit` does not drain. | C7: `m2` is dropped. `exit` listeners run, then `_exit`-equivalent teardown. |
| R4. No `JSValue` across threads. | QuickJS values are runtime-local refcounted pointers; `Ctx`/`Persistent` are `!Send`. |
| R5. Explicit GC (`JS_RunGC`) only between jobs or at loop level. | It can run finalizers that enqueue jobs and can call arbitrary JS. Implicit GC still fires on allocation during a job, which is why queued job values must be marked (G11). |
| R6. `JS_UpdateStackTop` after the isolate's thread is (re)established. | `js_check_stack_overflow` compares against a runtime-recorded stack top; a worker thread that differs from the creating thread must refresh it. |
| R7. Never free the runtime while jobs are queued. | I10. Free jobs → free their values → free contexts → free runtime. |

`queueMicrotask` is *not* a host queue. It stays the engine's native global (same FIFO as
reactions). Wrapping it in a Rust job would split the FIFO and break C1.

## 8. What the engine patch buys (M6)

The unpatched design is correct for M1–M5 but cannot attribute a job to an async resource,
because the engine creates `promise_reaction_job` entries itself and the host only sees
"something is pending". Consequences without a patch:

- ALS context is restored around host callbacks (fs, timers, net) but **not** across `await` /
  `.then` chains. Users notice immediately.
- Async stack traces are impossible for promise jobs.
- Diagnostics ("which async resource is keeping the loop alive") are approximate.

The patch (detail in [engine-patch.md](../engine-patch.md)) adds:

1. `JS_SetJobQueueHook(rt, hook, opaque)` — when set, `JS_EnqueueJob` hands the entry to the host
   instead of `rt->job_list`. Backwards compatible: no hook, old behaviour.
2. Opaque `JSJob` handle with `JS_JobRun`, `JS_JobFree`, `JS_JobContext`, `JS_JobTag`.
3. An `int64_t tag` on the promise (`JS_SetPromiseTag`) copied into jobs created while that
   promise settles, so `promise_reaction_job` arrives pre-tagged with our `async_id`.
4. A job mark hook (`JS_SetJobMarkHook`) so host-owned job values are traced by the cycle
   collector, closing G11. Without it, a job that outlives a GC can lose a cyclic argument.

~150 lines of C, no public API removal, upstreamable. The scheduler's `Job` grows one field.

**Rejected alternative:** infer the tag by watching `JS_SetPromiseHook` RESOLVE and assuming the
next enqueued job belongs to the settling promise. That is wrong for a settle with multiple
reactions across contexts and for `thenable` jobs; it would encode a race into the scheduler.

## 9. Conformance corpus

All outputs verified against `node v26.10.0` on 2026-11-13. `crates/ln-sched/tests/ordering.rs`
encodes the policy; the real runtime must pass the same table through the differential harness.

| # | File | Expected (Node) |
|---|---|---|
| C1 | `c01-nexttick-priority.js` | `sync tick1 tick2 micro1 then1 micro-from-tick` |
| C2 | `c02-uncaught-inline.js` | `m1 uncaught:boom m2 then1` |
| C3 | `c03-unhandled-after-drain.js` | `t1 m1 unhandled:r1 timer` |
| C4 | `c04-handled-same-checkpoint.js` | `m2 caught:r2` |
| C5 | `c05-tick-from-microtask.js` | `m1 m2 tick-from-m1` |
| C6 | `c06-late-handler.js` | `unhandled:r3 caught:r3 rejectionHandled` |
| C7 | `c07-exit-drops-queue.js` | `t1 m1` then exit 0 |
| C8 | `c08-handler-queues-microtask.js` | `h:x m2 from-handler` |
| C9 | `c09-await-ordering.js` | `f-start sync f-after then qm` |
| C10 | `c10-microtasks-between-macrotasks.js` | `imm1 m-imm1 imm2 t1 m-t1` (deterministic in our loop) |
| C11 | `c11-then-throw-is-rejection.js` | `m2 unhandled:in-then` |
| C12 | `c12-shared-fifo.js` | `sync qm1 then1 then2 qm2 qm-from-then2` |

Each case has a sibling `.expected` file holding stdout plus an `exit:<code>` line.
`./run.sh` diffs a runtime against them, `RUN=node ./run.sh` proves they still describe Node,
and `REGEN=1 RUN=node ./run.sh` re-records them (never record from onde itself).

The programs, abridged (the files under `test/conformance/microtasks/` are authoritative; each has
an `.expected` recorded from Node):

```js
// C1
process.nextTick(() => { console.log('tick1'); queueMicrotask(()=>console.log('micro-from-tick')); process.nextTick(()=>console.log('tick2')); });
queueMicrotask(()=>console.log('micro1'));
Promise.resolve().then(()=>console.log('then1'));
console.log('sync');

// C2
process.on('uncaughtException', (e) => console.log('uncaught:', e.message));
queueMicrotask(() => { console.log('m1'); throw new Error('boom'); });
queueMicrotask(() => console.log('m2'));
Promise.resolve().then(() => console.log('then1'));

// C3
process.on('unhandledRejection', (r) => console.log('unhandled:', r.message));
Promise.reject(new Error('r1'));
queueMicrotask(() => console.log('m1'));
process.nextTick(() => console.log('t1'));
setTimeout(()=>console.log('timer'), 0);

// C4
process.on('unhandledRejection', (r) => console.log('unhandled:', r.message));
const p = Promise.reject(new Error('r2'));
queueMicrotask(() => { p.catch(e => console.log('caught:', e.message)); });
queueMicrotask(() => console.log('m2'));

// C5
queueMicrotask(() => { console.log('m1'); process.nextTick(() => console.log('tick-from-m1')); });
queueMicrotask(() => console.log('m2'));

// C6
process.on('unhandledRejection', (r) => console.log('unhandled:', r.message));
process.on('rejectionHandled', () => console.log('rejectionHandled'));
const p = Promise.reject(new Error('r3'));
setTimeout(() => p.catch(e => console.log('caught:', e.message)), 0);

// C7
queueMicrotask(()=>{ console.log('m1'); process.exit(0); });
queueMicrotask(()=>console.log('m2'));
process.nextTick(()=>console.log('t1'));

// C8
process.on('uncaughtException', (e) => { console.log('h:'+e.message); queueMicrotask(()=>console.log('from-handler')); });
queueMicrotask(()=>{ throw new Error('x'); });
queueMicrotask(()=>console.log('m2'));

// C9
async function f(){ console.log('f-start'); await null; console.log('f-after'); }
f(); Promise.resolve().then(()=>console.log('then')); queueMicrotask(()=>console.log('qm')); console.log('sync');

// C10
setImmediate(()=>{ console.log('imm1'); queueMicrotask(()=>console.log('m-imm1')); });
setTimeout(()=>{ console.log('t1'); queueMicrotask(()=>console.log('m-t1')); }, 0);
setImmediate(()=>console.log('imm2'));

// C11
process.on('unhandledRejection', e=>console.log('unhandled:'+e.message));
Promise.resolve().then(()=>{ throw new Error('in-then'); });
queueMicrotask(()=>console.log('m2'));
```

## 10. Implementation status

**Implemented through M1.** `crates/ln-sched` is the engine-free implementation of D2 plus the
rejection table, the budget, the stop signal and the sink mailbox. It models a job as an opaque
closure and has no QuickJS dependency. `crates/ln-runtime` is the adapter:

- The engine's job queue is pumped one `JS_ExecutePendingJob` at a time from a single scheduler
  job body ([`Isolate::seed_pump`]). The pump re-arms itself while the engine reports pending
  work, so engine jobs keep their settle order inside pass B.
- Native primitives (`__ln_next_tick`, `__ln_reject`, `__ln_handle`, …) only push owned ids into
  a `Bridge`; every job body drains the bridge into the scheduler after the JS call returns.
  No `JSValue` crosses the scheduler boundary.
- `uncaughtException` is emitted inline from `Scheduler::run`'s event sink. The JS table keeps
  the actual promise/reason values and mints ids, so `unhandledRejection` and
  `rejectionHandled` listeners receive the engine's own objects. After a rejection is reported
  the table drops the reason and holds the promise through a `WeakRef`; the late handler's
  tracker call supplies the strong value again for the deferred `rejectionHandled` event, so an
  unhandled rejection that is never handled does not pin its promise.
- `cargo test --all` covers the policy (21 unit + 13 corpus-derived + 8 runtime/boundary tests) and 33 CLI
  end-to-end tests. `test/conformance/` has 73 recorded cases; `test/differential.sh` runs them
  under Node and onde and compares ordered stdout plus exit code. CI does both, so the
  expectations cannot rot.

## 11. Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep the `JS_ExecutePendingJob` drain loop as the whole model | No `nextTick` priority, no checkpoint boundaries, no budget, no per-job metadata, and every op would have to remember to drain |
| Single queue; implement `nextTick` as a microtask | Ordering diverges (C5) and `nextTick` starvation semantics are lost |
| Implement `nextTick` in JS with a `Promise.then` chain | Same divergence, plus it perturbs the promise job count and `async_hooks` ids |
| Run the microtask drain on a tokio task | JS values are not `Send`; ordering becomes nondeterministic; violates I1 |
| Use rquickjs's `AsyncRuntime::idle` / `Context::async_with` as the loop | It owns a job pump *and* a future spawner; two owners of the queue (I1) and no phase control |
| Patch only the rejection tracker and emulate the rest in JS | Cannot intercept promise reactions to add `nextTick` priority; cannot attribute jobs |
| Wait for upstream job hooks | No timeline; the patch is small, isolated and upstreamable |

## 12. Consequences

- The scheduler is a first-class crate with its own test suite and no engine dependency. Good
  for iteration and for keeping the contract honest.
- One more fork to maintain (M6). Bounded: `quickjs.c` job plumbing plus a handful of
  declarations, with a CI rebase check on every upstream release.
- The runtime's exit paths, worker termination and `process.exit` all have to route through the
  scheduler's teardown. That is a constraint on every component, and it is cheaper than
  discovering leaked jobs in production.
- `async_hooks` is deliberately not promised until M6. Documenting the gap is cheaper than
  shipping an ALS that silently loses context on `await`.
