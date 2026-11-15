# ADR-0008: Threads, workers and child processes

- Status: accepted (M5)
- Date: 2026-11-15
- Supersedes: none
- Related: [0003 event loop](0003-event-loop.md), [0005 ops protocol](0005-ops-protocol.md),
  [0006 handles and events](0006-handles-and-events.md), [M5 plan](../m5-plan.md)

> The permissions model that was pencilled in as ADR-0008 moves to 0009 (1.1), as the decision log
> in [roadmap.md](../roadmap.md#6-decision-log) already allows for.

## 1. Context

M5 is the first milestone with more than one isolate in a process, and the first that spawns other
processes.

QuickJS is single-threaded: a `JSRuntime` and its values belong to the thread that created them,
and `rquickjs` makes that explicit (`Runtime` is `!Send`, a `Ctx` borrows it). M4 already relies on
it: "one isolate is pinned to one thread" (ADR-0003) is why `Isolate` is not `Send` and why no
`JSValue` is stored in a handle slot, a parked queue or a task (H1 in ADR-0006).

M5 has to add two things that H1 and the handles model do not cover:

- **`worker_threads`.** Node gives a worker its own global object, module graph, event loop and
  heap, and runs it on a separate thread. A worker can block its thread without blocking the main
  loop. Two workers must be able to share memory through `SharedArrayBuffer` and synchronize
  through `Atomics`.
- **`child_process`.** A child has three byte streams with independent backpressure, a pid, an exit
  status, and a lifetime that is not the isolate's. Its `exit` and `close` events are ordered
  against each other, and the child must be reaped even when the parent stops listening.

Three engine facts shape the design, all verified against the pinned engine on 2026-11-15
(`rquickjs` 0.14 / quickjs-ng 0.17.0):

1. `SharedArrayBuffer` does not work unless `JS_SetSharedArrayBufferFunctions` is called and the
   engine has `JS_SetCanBlock(rt, true)`; otherwise `new SharedArrayBuffer(n)` fails and
   `Atomics.wait` throws `cannot block in this thread`.
2. The only supported way to move a `SharedArrayBuffer` between two runtimes is the engine's own
   serializer: `JS_WriteObject2(..., JS_WRITE_OBJ_SAB | JS_WRITE_OBJ_REFERENCE, &sab_tab)` on one
   side and `JS_ReadObject2(..., JS_READ_OBJ_SAB | JS_READ_OBJ_REFERENCE, &sab_tab)` on the other.
   The bytecode embeds the raw buffer address, so the two runtimes must share an address space
   (threads in one process, never separate processes).
3. `Atomics.wait`/`notify` work across runtimes in one process: the waiter list and its condition
   variables are process-global in the engine, so a notify on one thread wakes a waiter on another.

## 2. Decision

**A worker is a second `Isolate`, on its own OS thread, inside the same process.** A child process
is an ordinary process with a handle; the two mechanisms stay separate in the runtime because they
are separate at the OS level.

### 2.1 One isolate per thread; workers are nested isolates

`Isolate` already owns an engine, a scheduler, a loop, a module runtime and the host globals. A
worker reuses all of it: the worker thread constructs a new `Engine`, installs `__ln_host` in
worker role, evaluates the same `bootstrap.js`, runs the entry module through the same
`run_file`/`run` path, and drives the same loop. Nothing in `ln-sched`, `ln-engine` or `ln-modules`
learns what a worker is.

Alternatives rejected:

- **Several `Context`s in one runtime.** QuickJS contexts in one runtime share a thread, a GC and
  (by default) the same intrinsics; there is no parallelism, and a blocking worker would block the
  main loop. It would not be `worker_threads`.
- **One shared global heap with locks.** That is a different language runtime. Node does not
  provide it either: workers communicate by messages and shared buffers.

The consequence is that the parent cannot construct the worker's `Isolate`: `Isolate` is `!Send`,
so construction must happen on the worker thread. The only state that crosses is `Send` data:
paths, numbers, `Arc`s, serialized messages and SAB pointers.

### 2.2 The host owns the wakeup, not the worker

The loop blocks in `Reactor::wait`; a worker must wake when a message arrives or a cancel is
requested. The worker's completion channel is therefore created by the parent before the thread
starts and handed to the worker:

```
let (reactor, sender) = ChannelReactor::new();
let child_sender = sender.clone();
std::thread::Builder::new().stack_size(8 << 20).spawn(move || {
    let mut isolate = Isolate::with_channel(config, reactor, sender)?;
    isolate.run_entry(...)
});
// parent keeps child_sender, id and the parked inbound queue
```

`Isolate::new` is `with_channel` with a channel of its own, so the main path does not change. The
parent posts a message by serializing it on the parent isolate thread, pushing the bytes into the
worker's inbound queue, and sending `Completion(worker_id)`; the worker's completion phase drains
the queue, deserializes on the worker isolate thread and calls the JS sink. The reverse direction
uses the same shape with the parent's sender. `ln-sched` still sees only `u64`.

### 2.3 Messages are engine bytecode plus a SAB pointer table

`postMessage` is serialized with the engine's own serializer, not JSON and not a hand-written
structured clone:

```
Serialized {
    bytes: Vec<u8>,          // JS_WriteObject2 output, owned
    sabs:  Vec<SabHandle>,   // one owned ref per pointer in the SAB table
}
```

This is the only payload that crosses a thread and is not plain Rust data, so **H1 is amended**:

> H1′ — no `JSValue` crosses a thread boundary. A worker message crosses as owned bytes plus a
> refcounted `SharedArrayBuffer` pointer table; it is reconstructed into a `JSValue` only on the
> destination isolate thread.

`SabHandle` is an unsafe `Send + Sync` newtype over a process-global allocation. The allocation is
`libc::malloc` plus an atomic refcount header, installed once as
`JSSharedArrayBufferFunctions { sab_alloc, sab_free, sab_dup }` and shared by every runtime in the
process. It is the same model quickjs-libc uses for its own worker implementation. `Rust` panics
must never unwind through the `extern "C"` hooks, so no Rust collection or `Vec` is used inside
them.

Ownership is the subtle part and is fixed here:

- **write:** `JS_WriteObject2` returns a table of borrowed pointers; the message takes one ref per
  pointer with `sab_dup`, then frees the table. The caller's buffers keep their own refs.
- **read:** `JS_ReadObject2` creates each JS buffer with `sab_dup` (verified in
  `js_array_buffer_constructor3`), so after a successful read the receiver releases the message's
  refs by `sab_free`-ing every pointer in the returned table. On a failed read it releases all of
  them too.
- **failure:** any error path frees the byte buffer with the engine allocator and releases every
  SAB ref exactly once. No `Vec::from_raw_parts`, ever.

`transferList`: an `ArrayBuffer` is detached after a successful write (`JS_DetachArrayBuffer`) and
the destination receives a copy; a `SharedArrayBuffer` is already shared and the entry is ignored;
functions and ports are rejected. Zero-copy transfer needs an engine move API and port transfer
needs a port table in the wire format, so both are recorded as D49 rather than half-implemented.

### 2.4 `Atomics` works on every thread

Every runtime gets the SAB functions and `JS_SetCanBlock(rt, true)`. The main thread can therefore
block in `Atomics.wait`, as Node allows. This is a process-wide engine setting and a JS program
that blocks the main thread gets the same stalled loop Node gives it.

### 2.5 Handle families share the ref table, not the code

M5 adds two handle families: `proc` (children and inherited IPC) and `worker`. They join the
completion router after the net table:

```
op → net → proc → worker → ignore
```

The ids come from the single allocator, so a completed id is unambiguous; the router is a sequence
of table lookups, not a type tag. The three bridges share a `RefTable` extracted from
`handles.rs` so that H3 and H4 are implemented once:

- **H3′** — each live child or worker holds at most one external loop ref; `ref`/`unref` are
  idempotent, and `closed`/`exit`/`terminate` releases it at most once.
- **H4′** — after `shutdown`, no event from any family is dispatched and no ref is left behind.

Net handles, proc handles and worker handles never share an event queue or an event payload type;
only the ref bookkeeping is common. That keeps the M4 path untouched apart from the extraction.

### 2.6 A child process is one handle with stream-tagged events

A child is one id and one task. Stdout and stderr are not separate handles: events carry
`{ stream, bytes }`, and `read`/`readStop`/`write`/`drain` take a stream number. One child therefore
holds one loop ref (Node semantics: a live `ChildProcess` keeps the loop alive) and has one place to
order `exit` against `close`.

The task always drives `Child::wait()` to completion, even after the isolate stops listening, so a
child is reaped and cannot become a zombie. Shutdown only gates event delivery. `exit` is emitted
when `wait` returns; `close` after every piped stream reached EOF and `exit` has been emitted. After
`exit`, the task also drains whatever remains in an unread output pipe, so an unread stderr cannot
hold `close` open (Node behaves this way too).

`fork` adds one inherited IPC descriptor on fd 3 with length-prefixed JSON frames (lite-only; D50).
It is a **process-level singleton**, not a fourth handle family: `fork` gives the child exactly one
descriptor, so a reserved completion id (`u64::MAX - 1`) and `host.ipc(name, args)` are enough. The
channel holds one loop ref while it is open. `disconnect` stops the reader immediately but lets the
writer drain queued frames first, so `process.send(value); process.disconnect()` does not drop the
last message.

### 2.7 Signals belong to the main isolate, and termination is cooperative

`process.on("SIGINT")` installs a process-wide handler, so it is only allowed on the main isolate.
`ln-io::signal` creates a tokio signal stream per subscribed signal; delivery becomes a completion,
and JS emits the event. A listener holds one loop ref, as Node's signal watcher does. When the last
listener is removed the runtime stops that stream and restores `SIG_DFL` immediately; a delivery
that races the removal also restores and re-raises, because tokio's handler stays installed for the
life of the runtime. `process.kill` is a synchronous `libc::kill` and throws `ESRCH`/`EPERM` like
Node; `process.cpuUsage` reads `getrusage`.

`worker.terminate()` is cooperative. The parent sets an `Arc<AtomicBool>`, which the worker's
engine interrupt handler already checks alongside the microtask deadline; the loop then stops at the
next bytecode safepoint. There is **no thread kill**: `pthread_cancel` on a thread inside the
engine would corrupt the runtime, and there is no public way to wake another isolate's
`Atomics.wait`. A worker blocked in `Atomics.wait` or a native syscall therefore terminates when
that call returns (D48). A tight JS loop terminates promptly.

## 3. Invariants

| ID | Invariant | Where enforced |
|---|---|---|
| H1′ | No `JSValue` crosses a thread; worker messages cross as bytes + SAB pointers and are reconstructed on the destination isolate thread | `ln-engine::Serialized`, `ln-runtime::workers`; the type is `Send`, a `JSValue` is not |
| H3′ | At most one external loop ref per live child/worker, released at most once, no underflow | `RefTable` |
| H4′ | No event after shutdown, and no ref left behind, for every family | each bridge's `shutdown`, called from `Isolate::finish` and `Drop` |
| W1 | Every SAB ref taken by a message is released exactly once, on success and on every error path | `ln-engine::serialize` unit tests + a 10k-message stress loop |
| W2 | A worker thread never outlives the process's use of its engine; the parent joins or detaches explicitly | `WorkerBridge::shutdown`, `JoinHandle::is_finished` |
| W3 | A child is reaped even when the isolate stops dispatching its events | `ln-io::proc` task always awaits `wait` |

## 4. Rejected alternatives

- **`std::process` + blocking threads instead of tokio for children.** Pipes need non-blocking reads
  and a select over three streams plus commands; doing that with blocking threads is three threads
  per child and a second cancellation model. The pool already exists and `tokio::process` is the
  same dependency, one feature flag.
- **A JSON-only message path for workers.** It would make `SharedArrayBuffer` impossible, lose
  cycles and typed arrays, and be slower than the engine's bytecode for everything except tiny
  numbers.
- **Reusing `net.Socket` for child pipes.** A child pipe is not a socket: no addresses, no
  connection lifecycle, and one command channel for three streams. A small `internal/pipe.js` over
  the proc family is less code than making `net.js` polymorphic over transports.
- **`spawnSync` in M5.** It needs a synchronous wait that blocks the isolate thread while the host
  task runs, plus a second timeout/cancellation story. Node's own CLI code rarely needs it; the
  sync family is recorded as D50 and can arrive with M7's diagnostics work.
- **`pthread_cancel` or `_exit` in the worker thread for `terminate`.** Unsafe with the engine's
  allocator and locks.

## 5. Consequences

Positive:

- Workers reuse the bootstrap, module loader, scheduler and error renderer; there is no second
  runtime to keep in sync, and `worker_threads` behaves like the main isolate by construction.
- `SharedArrayBuffer` and `Atomics` are real, cross-thread and engine-supported, not emulated over
  message passing.
- `child_process` inherits the proven handle/event/completion machinery; the only new work is the
  OS process task and the stream tags.
- Signals, `kill` and `cpuUsage` close M2's `process` placeholders without a new dependency.

Negative:

- The wire format for worker messages is quickjs bytecode, so a worker message is version-locked to
  the binary. In-process only; that is inherent to sharing an address space.
- `terminal` is cooperative: a worker stuck in a native call cannot be aborted (D48).
- Windows is best-effort, as everywhere in 1.0: worker threads work, `fork` and most signals do not.
- The one-id-space router now has four lookups. They are `HashMap`/`RefCell` hits on the isolate
  thread, but the order is load-bearing and is asserted by tests.

## 6. Verification

The engine claims above were verified on 2026-11-15 by a throwaway program against `rquickjs` 0.14:

```
atomics: 42                                   # Atomics.add works with can_block
sab count = 1                                 # JS_WriteObject2 produced one SAB entry
read in B: 7                                  # JS_ReadObject2 reconstructed the typed array
store in B: ok
A sees after B store: 99                      # the two runtimes share memory
wait timeout: timed-out                       # Atomics.wait blocks with a timeout
notify from B: 1
waiter result: Ok("ok")                       # cross-thread notify wakes a waiter
```

The M5 acceptance harness repeats these as permanent tests (`ln-engine` unit tests for the SAB and
serialize paths, `test/proc/atomics.js` for the 8-worker counter and the wait/wake matrix) and adds
the ordering, zombie and termination cases listed in [m5-plan.md](../m5-plan.md) §7.

Final results (2026-11-15): 372 Rust tests, 230/230 conformance cases, 220/220 differential cases,
73/73 JS stdlib suites, and 12/12 M5 acceptance cases. The worker echo path completed 1,000,000
sequential round-trips with zero reordering; eight workers reached exactly 400,000 `Atomics.add`
operations; a cross-thread `Atomics.wait` woke with `"ok"`; `terminate()` on a busy loop reported
exit 1; and `SIGKILL` left no live pid. The implementation notes that differ from this decision's
first draft are recorded in [m5-plan.md](../m5-plan.md) §12.
