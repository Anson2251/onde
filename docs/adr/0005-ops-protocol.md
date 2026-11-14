# ADR-0005: Ops protocol

- Status: accepted
- Date: 2026-11-13
- Supersedes: none
- Related: [0002 scheduler](0002-microtask-scheduler.md), [0003 event loop](0003-event-loop.md),
  [architecture](../architecture.md) §5, [M3 plan](../m3-plan.md)

## 1. Context

M3 adds the first host capabilities that are not timers: filesystem calls and hashing. They differ
in two ways that matter to the loop:

- Some must be **synchronous** (`readFileSync`, `statSync`, `createHash().update()`), because Node's
  API is synchronous and scripts depend on the ordering that implies.
- Some must be **asynchronous** (`readFile`, `fs.promises.readFile`), because blocking the isolate
  thread on a slow disk would stall timers and microtasks.

QuickJS values are `!Send` and owned by one runtime, and [ADR-0003](0003-event-loop.md) already
fixed the shape of the answer: I/O runs on a tokio pool, completions return to the isolate thread
as owned payloads, and the loop stays deterministic. What was open is the *protocol*: how an op is
described, submitted, cancelled, completed, and how its result becomes a JS value without ever
handing a `JSValue` to another thread.

## 2. Decision

**One `Op` value per capability, executed either inline or on the pool; completions carry an id,
not a payload.**

1. **Ops are plain data.** `ln_io::Op` is an enum with owned fields (`PathBuf`, `Vec<u8>`,
   `u32`/`i32`). `Op::execute(&self, abort: &AtomicBool) -> Result<OpValue, NodeError>` is the
   single implementation of a filesystem call. The sync `fs` forms call it on the isolate thread;
   the async forms hand it to the pool. There is no second code path to keep in sync.
2. **`OpValue` is plain Rust.** `Unit`, `Fd(i32)`, `Count(u64)`, `Bytes(Vec<u8>)`, `Text(String)`,
   `Stat(Stat)`, `Dir(Vec<DirEntry>)`. Conversion to JS happens on the isolate thread only.
3. **Completions are payload-free.** The pool parks `OpDone` in the isolate's op table (keyed by
   `RequestId`) and then sends the id through the existing wakeup channel
   (`ln_sched::CompletionSender`). `ln-sched::Completion` stays a `u64`; `OpDone` never enters
   `ln-sched`'s type space and `ln-io` never depends on `ln-sched`. The dispatch order is:
   take slot → settle promise or invoke callback → checkpoint.
4. **The JS surfaces are derived from one core, not from each other.**
   `js/lib/internal/fs.js` validates and normalizes arguments and calls the host once per op.
   `js/lib/fs.js` (sync + callback) and `js/lib/fs-promises.js` are thin mappings over it. The
   promise surface is not `promisify(fs)`; see compat D35.
5. **Sync and async have different error delivery.** The sync forms throw; the callback forms throw
   synchronously on invalid arguments but deliver syscall failures to the callback; only the promise
   forms reject. A callback is invoked from the completion dispatch, never from a promise reaction:
   a throw from the callback goes to `uncaughtException` (Node behaviour) and must not become an
   `unhandledRejection`.
6. **Pending ops keep the loop alive.** `submit` takes a loop ref (`Driver::ref_external`); taking
   the slot in the completion phase releases it. Without this, a script that awaits I/O would exit
   at the first idle check.
7. **Cancellation is cooperative.** Each op carries an `Arc<AtomicBool>`. An `AbortSignal` listener
   calls `host.cancelOp(id)`, which sets the flag. The pool checks it before executing and after the
   syscall returns; an op that created a resource closes it before reporting `OpDone::Aborted`. A
   completion that races the abort is ignored: the promise settles once, with `ABORT_ERR`.
   A syscall already in progress is not interrupted — Node does not interrupt it either.
8. **Threading rules.** `ln-io` and `ln-crypto` never depend on `ln-engine`/`rquickjs`. The sink is
   `Arc<dyn Fn(OpDone) + Send + Sync>`; `OpDone` is `Send` by construction. A compile-fail test in
   `ln-runtime` asserts that an op payload cannot contain a `JSValue`.
9. **No eager pool.** The tokio runtime is created on the first async op and reused for the process
   (`OnceLock<Result<Pool, io::Error>>`). Cold start keeps the M0 envelope; `--io-threads` maps to
   `max_blocking_threads`.
10. **Backpressure is pull-based.** Streaming reads request a bounded chunk, and the JS stream asks
    for the next chunk only when its consumer is ready (`Readable._read`), so a fast producer cannot
    run ahead of a slow consumer.

## 3. Invariants

| ID | Invariant |
|---|---|
| O1 | No `JSValue`, `Persistent`, `Ctx` or `Context` is ever stored in an `Op`, `OpValue`, `OpDone` or the pool |
| O2 | A completion settles exactly one promise or invokes exactly one callback, exactly once |
| O3 | Every async op holds exactly one loop ref from submit until its slot is taken |
| O4 | An aborted op that opened an fd closes it; no completion is delivered after shutdown |
| O5 | Callback and promise paths share the same op table and the same checkpoint, so ordering does not depend on the surface used |
| O6 | Synchronous ops never wait on the pool and never need the loop |

## 4. Alternatives considered

- **Generic JSON op dispatch** (`host.call("fs.readFile", {...})`): one binding instead of ~30, but
  it turns every call into a parse/allocation and moves argument validation to the wrong side of
  the boundary. Rejected.
- **Widen `Completion` to carry the payload**: fewer moving parts at the dispatch site, but it
  forces `ln-sched` to know `OpDone` (or to be generic) and breaks the "policy crate knows nothing
  about I/O" rule. Rejected; the id table is one uncontended lookup.
- **`util.promisify` the callback surface**: cannot express `open`→`FileHandle`, loses the
  multi-value result of `read`/`write`, hangs on `exists`, and turns callback throws into rejections.
  Rejected; see compat D35.
- **A tokio task per op with `async fn` in `ln-io`**: more state machines for no gain, because the
  underlying fs calls block anyway. Rejected for M3; `spawn_blocking` is the right primitive.
- **libuv/mio on the isolate thread**: already rejected by ADR-0003.

## 5. Consequences

- The op protocol is testable without an engine: `ln-io` unit tests call `execute` directly, and
  the runtime can feed a fake `OpDone` into the op table.
- Two surfaces (`fs`, `fs/promises`) cannot drift on error codes or syscall semantics, because both
  end at the same `NodeError`.
- The `RequestId` table is the only shared mutable state between the pool and the isolate; the lock
  is uncontended because the pool only parks before waking.
- M4's sockets and M5's child processes implement the same protocol with more `Op` variants; the
  difference is that their results stream instead of completing once, which the pull-based rule
  already anticipates.
