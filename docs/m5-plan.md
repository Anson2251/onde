# M5 implementation plan — processes and threads

This is the working contract for M5. [roadmap.md](roadmap.md#m5--processes-and-threads-4-w) says
*what* ships; this page says *where* it lives, *how* the host boundary works, and what is
deliberately left out. The structural decisions are [ADR-0008](adr/0008-processes-and-threads.md).

Status: **complete on 2026-11-15.** The implementation followed this contract; WP0–WP7 all
landed. §12 records the outcome, the deviations taken during implementation, and the numbers the
acceptance harnesses produced. The plan was written against the M4 tree (`87864d4`) and the pinned
engine (`rquickjs` 0.14 / quickjs-ng 0.17.0).

M5 adds three user-visible modules — `child_process`, `worker_threads`, `readline` — and three
host capabilities they need: child processes with pipes, one isolate per OS thread with shared
memory, and signal delivery. It is the first milestone where the runtime has **more than one
isolate in one process**, which is the part worth designing carefully.

The plan is ordered so the highest-risk piece (cross-isolate shared memory) is proven before any
API surface is built on it.

## 1. What ships, in one table

| Area | Ships | Does not ship (documented) |
|---|---|---|
| `child_process` | `spawn`, `exec`, `execFile`, `fork`; stdio `pipe`/`ignore`/`inherit`/fd; `stdin`/`stdout`/`stderr` as streams; `kill(signal)`; `pid`, `exitCode`, `signalCode`, `killed`; events `spawn`/`exit`/`close`/`error`; `exec` `timeout`/`maxBuffer`/`killSignal`; `shell`; `cwd`/`env`/`argv0`/`detached`/`unref`; `fork` IPC `send`/`message`/`disconnect` | `spawnSync`/`execSync`/`execFileSync`; IPC with a real `node` child; `stdio: "ipc"` outside `fork`; `windowsHide`/`windowsVerbatimArguments`; promise-returning variants (use `util.promisify`) |
| `worker_threads` | `Worker`, `isMainThread`, `parentPort`, `workerData`, `threadId`, `MessageChannel`/`MessagePort`, `receiveMessageOnPort`, `markAsUntransferable`, `getEnvironmentData`/`setEnvironmentData`; `postMessage` with structured values, `SharedArrayBuffer` and `transferList`; `terminate`, `ref`/`unref`, events `online`/`message`/`messageerror`/`error`/`exit`; `eval: true`, `argv`, `workerData` | transferring `MessagePort`s between threads; `resourceLimits`; worker `stdout`/`stderr` capture; sharing `process.env` (`SHARE_ENV`); `BroadcastChannel` |
| `readline` | `createInterface`, `Interface`, line/close/pause/resume/history, `question`, `prompt`, `setPrompt`, `write`, async iteration, `emitKeypressEvents`, `cursorTo`/`moveCursor`/`clearLine`/`clearScreenDown`, `readline/promises` | raw-mode key-by-key editing and history arrows (blocked by D38, `tty.setRawMode` is a flag) |
| `process` | `cpuUsage()`, `kill(pid, signal)`, `on("SIGINT"/"SIGTERM"/"SIGHUP"/"SIGQUIT"/"SIGUSR1"/"SIGUSR2")`, `removeAllListeners` restoring the default disposition, `process.send`/`message`/`disconnect`/`connected` in a forked child | `SIGCHLD`, `SIGWINCH`, `SIGSTOP`/`SIGCONT` listeners; `process._kill` internals; signal handling on Windows beyond `SIGTERM`/`SIGKILL` |

## 2. Crate and file changes

```
ln-engine ── + sab.rs, serialize.rs, cancel token        (unsafe stays here)
ln-io     ── + proc.rs (spawn/pipes/kill/IPC framing), signal.rs
ln-runtime ─ + proc.rs, workers.rs, signals.rs, host/{proc,worker,signal}.rs
             ~ handles.rs: extract the shared loop-ref table
             ~ lib.rs: Role, external channel, completion routing, worker entry
             ~ modules.rs: embed the new JS modules
ln-modules ─ ~ builtin.rs: child_process, worker_threads, readline, readline/promises
js/        ─ + lib/child_process.js, lib/internal/pipe.js
             + lib/worker_threads.js, lib/internal/worker.js, lib/internal/ipc.js
             + lib/readline.js, lib/readline-promises.js
             ~ bootstrap.js, lib/process.js
```

No new crates and no new external dependencies. `ln-io` grows two modules because it already owns
the only tokio runtime (ADR-0003); `child_process` and signals are syscalls like the ones it
already houses. `tokio` gains the `process` and `signal` features. `libc` (already a dependency on
Unix) provides `kill`, `getrusage`, `sigaction` and the default-disposition re-raise.

The alternative — a new `ln-proc` crate — was rejected: it would either need its own tokio runtime
(violating the one-runtime rule) or depend on `ln-io` for the pool, which is a worse dependency
edge than one more module in the crate that means "syscalls".

## 3. The host boundary

The M4 shape is kept: a JS id minted by `host.nextRequestId()`, a command entry point per family,
events delivered back through `__ln_<family>_event(id, name, payload)`. M5 adds two handle
families and one singleton service, and extends the completion router in `run_loop`:

```
Completion(id) → op table       (ADR-0005, as today)
               → net handle     (ADR-0006, as today)
               → proc handle    (new: child processes and inherited IPC)
               → worker handle  (new: worker threads)
               → ignore          (stale completion after shutdown)
```

One id space, four tables. The benchmark is not a fifth family: signals are a singleton with no
per-handle id (they are addressed by signal number).

### 3.1 Shared loop-ref bookkeeping

`handles.rs` currently owns `live`, `refs`, `shutting_down` and the H3/H4 rules. Copying that into
three bridges would copy the two subtlest invariants in the runtime. Extract a `RefTable`:

```
RefTable {
    live: RefCell<HashSet<HandleId>>,
    refs: RefCell<HashSet<HandleId>>,
    shutting_down: Arc<AtomicBool>,
    driver: Rc<RefCell<Driver>>,
}
```

`HandleBridge` (net), `ProcBridge` and `WorkerBridge` each hold one `RefTable` and their own
parked-event map. `activate`/`release`/`shutdown` keep their current meaning, so H3 (at most one
ref per live handle) and H4 (no event after shutdown) are implemented once. The three parked maps
are separate so the router's `take` calls stay simple.

### 3.2 `host.proc(id, name, args)` — child processes (ADR-0008 §4)

One child process is one handle id. Its pipes are **not** separate handles: the event carries the
stream, which keeps one loop ref per child (as in Node) and makes the child's `exit`/`close`
ordering a property of one task.

| `name` | `args` | notes |
|---|---|---|
| `spawn` | `program, args[], cwd, env, stdio[3], detached, argv0` | `env` is a flat `[key, value, ...]` array or `null` (inherit the isolate's snapshot); `stdio` entries are `"pipe"`, `"ignore"`, `"inherit"`, or a number. Returns immediately; a missing program is an async `error` event, as in Node |
| `write` | `stream, Uint8Array` | `stream` is `0`; queued in order, `drain` when the queue empties |
| `end` | `stream` | drops the write half; the child sees EOF |
| `read` | `stream, maxChunk` | pull one chunk (≤ 64 KiB), ignored while one is in flight for that stream |
| `readStop` | `stream` | `pause()` for one stream; the other keeps flowing |
| `kill` | `signal` | `libc::kill` on Unix; tokio's `start_kill`/`TerminateProcess` on Windows |
| `ref` / `unref` | — | loop refcount, idempotent |
| `send` / `disconnect` | `Uint8Array` / — | `fork` IPC only; see §3.5 |

Events, through `__ln_proc_event`:

| `name` | payload |
|---|---|
| `spawn` | `{ pid }` |
| `data` | `{ stream: "stdout" \| "stderr", bytes }` |
| `end` | `{ stream }` |
| `drain` | `{ stream }` |
| `exit` | `{ code: number \| null, signal: string \| null }` |
| `close` | `{ code: number \| null, signal: string \| null }` |
| `error` | a real JS `Error` with `code`/`errno`/`syscall`/`path` |
| `message` | `{ bytes }` — one complete IPC frame; JS parses the JSON |
| `disconnect` | — |

`exit` is emitted when `wait` returns; `close` after all piped streams have reached EOF **and**
`exit` has been emitted. That is Node's rule and it is the one most likely to regress, so it gets
its own conformance case.

The Rust task (one per child, `tokio::select!` loop) owns the `Child`, the three pipes and the
command receiver. It always drives `Child::wait()` to completion so the child is reaped even when
the isolate shuts down (no zombies); shutdown only stops event delivery. A command addressed to a
finished child is ignored, not an error (H5).

### 3.3 `host.worker(id, name, args)` — worker threads (ADR-0008 §3)

| `name` | `args` | notes |
|---|---|---|
| `spawn` | `filename, evalSource \| null, workerData, argv` | main isolate only; serializes `workerData` on the calling isolate and starts the thread |
| `postMessage` | `value, transferList` | serializes on the calling isolate; `transferList` entries are detached after a successful write |
| `terminate` | — | sets the worker's cancel flag and wakes its loop |
| `ref` / `unref` | — | loop refcount, idempotent |
| `threadId` | — | not a command; it is part of the spawn result |

Events, through `__ln_worker_event`:

| `name` | payload |
|---|---|
| `online` | `{ threadId }` |
| `message` | the reconstructed JS value (the host converts the serialized bytes before calling JS) |
| `messageerror` | `{ message }` |
| `error` | `{ name, message, stack, code }` — the worker's uncaught error, reconstructed as a JS `Error` by the JS layer |
| `exit` | `{ code }` |

The worker side speaks the same protocol with the id the parent assigned. Its config carries the
id, so `parentPort.postMessage` is `host.worker(parentId, "postMessage", ...)`. In worker role the
host routes `postMessage`/`terminate` straight to the outbound sender instead of looking the id up
in a table (the worker's own worker table is empty); in main role it looks the worker up in
`WorkerBridge`. A worker has no child handles of its own to route: its completions are its own.

Message delivery is asynchronous in both directions, like Node: each serialized message is parked
on the receiving side and sends one completion, and the receiving loop drains that id's queue in
order, reconstructing each value on its isolate thread and checkpointing once per batch. Per
sender/receiver pair the order is therefore FIFO, which is what the echo harness asserts.

### 3.4 Signals and the `process` additions

`host.signal(signum, on)` subscribes/unsubscribes the **main** isolate only (workers cannot install
process-wide handlers; Node throws `ERR_WORKER_UNSUPPORTED_OPERATION` there). `ln-io::signal`
creates one tokio signal stream per subscribed signal and forwards each delivery through a
completion; `__ln_signal(signum)` dispatches it to JS, which emits `process.emit("SIGINT")`.

The default disposition is restored when the last JS listener is removed, and when a signal
arrives with no listener: the Rust side calls `signal(sig, SIG_DFL)` then `raise(sig)`, because
tokio's signal driver keeps its process-wide handler installed for the life of the runtime. This
is the only way `process.on("SIGINT")` followed by removal behaves like Node again.

`host.kill(pid, signum)` is a thin synchronous `libc::kill` (Windows: `TerminateProcess` for
`SIGTERM`/`SIGKILL`, `ERR_UNSUPPORTED_OPERATION` otherwise). `host.cpuUsage()` reads
`getrusage(RUSAGE_SELF)` and returns `{ user, system }` in microseconds; this closes D22 as far as
the main process is concerned.

### 3.5 `fork` IPC

`fork` is `spawn(current_exe, [module, ...args], { stdio: ["pipe","pipe","pipe","ipc"] })` with one
extra piece: the IPC channel. On Unix the parent creates a `UnixStream` pair, passes one end as
fd 3 (`Stdio::from(OwnedFd)`) and sets `ONDE_IPC_FD=3`; the child's `bootstrap.js` sees the env
var, calls `host.ipc(attach, fd)` and installs `process.send`/`channel`/`connected`.

Frames are `u32` little-endian length + UTF-8 JSON. This is **not** Node's wire format (Node uses
newline-delimited JSON with a `cmd` envelope), so a onde `fork` child cannot talk to a real `node`
parent: `fork` always spawns `current_exe`, so in practice both ends are onde, and this is recorded
as a divergence. A JSON payload that fails to parse is a `messageerror` on the child and an `error`
on the parent. `serialization: "advanced"` is accepted and still uses JSON (divergence).

The `ipc` capability is a proc-family handle: `host.ipc(id, "attach", [fd])`, commands
`read`/`send`/`disconnect`/`ref`/`unref`, events `message`/`disconnect`/`closed` through a
dedicated `__ln_ipc_event`. It is created only in a forked child, so a normal `onde` process pays
nothing.

### 3.6 Engine primitives (`ln-engine`, `EN1`–`EN4`)

All of this is unsafe FFI, so it lives in `ln-engine` and nowhere else. The spike on 2026-11-15
verified every one of these against the pinned engine:

- **EN1 — `SharedArrayBuffer` allocator.** Install a process-global
  `JSSharedArrayBufferFunctions` with an atomic refcount header before the buffer, allocated with
  `libc::malloc` (no Rust allocator and no unwinding across `extern "C"`). Install it on **every**
  runtime, main and worker.
- **EN2 — `JS_SetCanBlock(rt, true)`** on every runtime, so `Atomics.wait` works on the main thread
  too. Without it the engine throws `TypeError: cannot block in this thread`.
- **EN3 — `serialize`/`deserialize`.** `JS_WriteObject2(JS_WRITE_OBJ_SAB | JS_WRITE_OBJ_REFERENCE)`
  and `JS_ReadObject2(JS_READ_OBJ_SAB | JS_READ_OBJ_REFERENCE)`. The result is owned bytes plus a
  vector of SAB pointers, wrapped in `Serialized { bytes: Vec<u8>, sabs: Vec<SabHandle> }`.
  `SabHandle` is an unsafe `Send`/`Sync` newtype; the memory is process-global and refcounted, and
  mutation is synchronized by the JS program through `Atomics`, exactly Node's contract.
- **EN4 — lifetime rules** (the highest-risk part of M5; ADR-0008 §3.3):
  - writer: after `JS_WriteObject2`, `sab_dup` every pointer in the returned table (the message owns
    one ref), then free the table;
  - reader: `JS_ReadObject2` takes one ref per SAB through the allocator; after a successful read,
    `sab_free` every pointer in the returned table (the message's ref), and on a failed read free
    all of them as well;
  - the writer's data buffer is freed with the engine allocator, never `Vec::from_raw_parts`.

Also exposed: `Engine::detach_buffer(value)` (`JS_DetachArrayBuffer`, for `transferList`),
`Engine::set_cancel(Arc<AtomicBool>)` and `Engine::cancelled()` for worker termination, and a
`worker_thread_stack_size()` helper (8 MiB; QuickJS checks the native stack, and a std thread's
default is smaller than the main thread's).

`Engine::new()` keeps installing the interrupt handler; it now trips on `deadline || cancel`.

## 4. Worker lifecycle

A worker is a **nested `Isolate` on its own thread**, not a second context in the parent's runtime.
That reuses the bootstrap, scheduler, module loader, loop and error renderer unchanged, gives real
parallelism, and keeps "one isolate is pinned to one thread" true (ADR-0008 §2). The cost is that
the parent cannot construct the worker's `Isolate`: `Isolate` is `!Send`, so the thread constructs
it itself.

The one piece the parent must own is the completion channel, so it can wake the worker when a
message or a cancel arrives. `Isolate` therefore grows an external-channel constructor, with the role passed separately because
`WorkerRole` owns serialized bytes and is not `Clone`:

```
Isolate::new(config)                            // today: makes its own ChannelReactor
Isolate::with_channel(config, reactor, sender, role)   // new: used by the worker thread
```

```
enum Role { Main, Worker(WorkerRole) }
struct WorkerRole {
    handle: HandleId,            // the id the parent minted
    thread_id: u32,
    entry: WorkerEntry,          // File(PathBuf) | Eval(String)
    argv: Vec<String>,
    worker_data: Serialized,     // already serialized on the parent
    inbound: Arc<Mutex<VecDeque<InboundMessage>>>,
    outbound: CompletionSender,  // the parent's loop
    cancel: Arc<AtomicBool>,
}
```

Worker startup, in order: create the engine (SAB + can-block + cancel installed), install
`__ln_host` with the worker role, evaluate `bootstrap.js` (which eagerly loads
`internal/worker.js` and registers the message sink), emit `online` to the parent, evaluate the
entry (`run_file` or `run` for `eval: true`), then drive the normal loop.

`terminate()`: set the cancel flag, send a wake completion. The engine interrupt handler trips on
the next bytecode check, which unwinds the current job like a budget hit; the loop stops, runs the
worker's own `exit` listeners, releases its handles, and reports `exit { code: 1 }` to the parent.
A worker blocked in a native call or in `Atomics.wait` sees the flag only when it returns — recorded
as a divergence (Node can terminate a worker in `Atomics.wait`).

The parent keeps `JoinHandle`s. On shutdown it cancels every worker, then waits up to 250 ms for
`is_finished()`; a worker still stuck is left detached (the process is exiting anyway). This keeps
the "no leaked thread/handle" guarantee testable without hanging on a stuck worker.

## 5. JavaScript surface

- `child_process.js` — Node's argument normalization (`spawn(file, args, options)` and
  `spawn(command, options)`), `ChildProcess` as an `EventEmitter` with `stdin`/`stdout`/`stderr`
  stream properties, `exec`/`execFile` buffering and callback shapes, `fork` with IPC. Uses
  `internal/pipe.js`, a `Readable`/`Writable` pair over one proc handle and one stream number
  (pull-based `_read`, `readStop` on pause, `drain` on write).
- `worker_threads.js` — `Worker` (EventEmitter), `parentPort` (`MessagePort`), `MessageChannel`,
  `MessagePort`, `receiveMessageOnPort`, `isMainThread`, `threadId`, `workerData`, environment data.
  The ports and their queues live in `internal/worker.js`, which `bootstrap.js` loads eagerly in a
  worker so an early `postMessage` is not lost.
- `readline.js` — line-oriented `Interface` over any `Readable`/`Writable`; `readline/promises` is a
  20-line wrapper. No raw-mode editing (that is `tty`'s D38 gap, not readline's).
- `process.js` — `send`/`message`/`disconnect`/`connected` wired to `internal/ipc.js` when
  `ONDE_IPC_FD` is present; signal listener registration on `on`/`removeListener`; the existing
  `cpuUsage` zeroes replaced by the new host call.
- `bootstrap.js` — role installation; the three new event entry points; `__ln_signal`; eager
  `internal/worker` / `internal/ipc` in the matching role.

## 6. Work packages

Interfaces are **extend, don't rename**. WP0 is a gate; WP1–WP3 are the risky half; WP4–WP6 can be
developed in parallel once WP0 lands; WP7 is the acceptance gate.

| WP | Work | Files | Done when |
|---|---|---|---|
| **WP0** ✅ | *Engine primitives (gate).* SAB allocator, `SetCanBlock`, serialize/deserialize + ownership, detach, cancel, 8 MiB workers. ADR-0008. | `ln-engine/src/{lib,sab,serialize}.rs`, `docs/adr/0008-*.md` | two engines on two threads share a `SharedArrayBuffer` and see each other's `Atomics.store`; wait/notify across threads returns `ok`; a function fails to serialize; no leak in a 10k-message stress loop |
| **WP1** ✅ | *Worker core.* `Role`, `Isolate::with_channel`, thread spawn/join, parent completion routing, `WorkerBridge`, worker entry, `terminate`, `ref`/`unref`, error/exit reporting. | `ln-runtime/src/{lib,workers,host/worker}.rs` | a worker runs a file, prints, exits with a code; `terminate()` stops a busy loop; uncaught error → `error` then `exit 1`; no threads or refs left after shutdown |
| **WP2** ✅ | *Worker messaging.* `postMessage` both ways, SAB sharing, `transferList` (ArrayBuffer detach), `workerData`, `MessageChannel`/`MessagePort`, `messageerror`, environment data. | `ln-runtime/src/workers.rs`, `js/lib/worker_threads.js`, `js/lib/internal/worker.js` | echo round-trips preserve order; a SAB counter incremented from 8 workers is exact; transferring an ArrayBuffer detaches the source; `MessageChannel` delivers in-thread |
| **WP3** ✅ | *`ln-io::proc`.* Spawn/pipes/kill/wait, stdio modes, env/cwd, detached, exit/close ordering, IPC framing. | `ln-io/src/proc.rs`, `ln-io/Cargo.toml` | Rust tests spawn `/bin/sh -c 'echo hi'`, pipe stdin to EOF, kill a sleeper, reap on shutdown; IPC frame codec round-trips and rejects oversized frames |
| **WP4** ✅ | *`child_process` API.* Host family, proc bridge, `internal/pipe.js`, `spawn`/`exec`/`execFile`/`fork`, all events and `ChildProcess` fields. | `ln-runtime/src/{proc,host/proc}.rs`, `js/lib/child_process.js`, `js/lib/internal/pipe.js` | `spawn` stdout/stderr/stdin match node byte-for-byte; `exit` before `close`; `exec` maxBuffer/timeout; `fork` round-trips JSON both ways; `kill("SIGTERM")` reports `signal` |
| **WP5** ✅ | *Signals and `process` additions.* `ln-io::signal`, signal bridge, `process.on` wiring, default disposition, `kill`, `cpuUsage`; `process.send`/`message` in a forked child. | `ln-io/src/signal.rs`, `ln-runtime/src/{signals,host/signal}.rs`, `js/lib/process.js`, `js/bootstrap.js` | `SIGTERM` delivered to a JS listener; removing the listener restores default termination; `process.kill(child.pid, "SIGKILL")` works; `cpuUsage` is non-zero and monotonic |
| **WP6** ✅ | *`readline`.* Line interface, prompts, history, async iterator, ANSI helpers, `readline/promises`. | `js/lib/readline.js`, `js/lib/readline-promises.js` | piped input produces the same lines/order as node; `question` resolves; async iterator ends on close |
| **WP7** ✅ | *Acceptance.* `test/proc` harness, conformance corpus, worker echo (1M locally, 20k in CI), atomics matrix, zombie check, node↔onde interop, docs (compat, internals, README, roadmap), divergences D48–D53. | `test/proc/*`, `test/conformance/{child_process,workers,readline}/**`, `docs/*` | the three roadmap exit criteria are green on macOS and Linux; M1 corpus unchanged; `fmt`/`clippy -D warnings`/`cargo test --all` green |

Dependency notes:

- WP0 is a hard gate for WP1/WP2. WP3 has no dependency on WP0 and can start immediately.
- WP4 depends on WP3 (proc service) and shares `RefTable` with WP1, so extract `RefTable` first
  (small, mechanical) to avoid a merge conflict between the two bridges.
- WP5's `fork` half depends on WP4's spawn; the signal half is independent.
- WP6 is independent of everything and is the natural parallel task when M5 is staffed by more than
  one engineer.

## 7. Tests and acceptance

### 7.1 The roadmap's exit criteria, and where each is proven

| Criterion | Harness |
|---|---|
| Worker echo: 1M round-trips, no reordering | `test/proc/worker-echo.js` — every message carries a monotonic sequence number, the worker echoes it, the parent asserts `seq === expected`; `WORKER_ECHO_FULL=1` runs 1M, CI runs 20k. Prints `round-trips` and messages/sec |
| 8-worker `Atomics.add` counter is exact; `Atomics.wait` blocks and wakes | `test/proc/atomics.js` — 8 workers × 50k increments with `Atomics.add` on one SAB, parent asserts exactly 400k; a waiter blocks on 0 and a worker stores 1 + `Atomics.notify`; asserts the waiter returns `"ok"` and not `"timed-out"` |
| `child_process` interop green on macOS and Linux; zombie-free on `kill -9` | `test/proc/run.sh` — node↔onde spawn matrix, stdio/exit/close ordering, shell quoting, `fork` IPC, then a `kill -9` case that checks `ps -o stat=` shows no `Z` and that `kill(pid, 0)` reports `ESRCH` |

### 7.2 New harnesses and corpus

```
test/proc/
  run.sh                 # the M5 acceptance entry point
  fixtures/              # child/worker scripts, shared by node and onde
  child-process.js       # spawn/exec/execFile/fork matrix, node vs onde
  ordering.js            # spawn/exit/close/stdin-EOF ordering
  signals.js             # kill, signal names, default disposition, zombie check
  worker-echo.js         # ordering + throughput
  atomics.js             # shared counter + wait/notify
  terminate.js           # busy loop, idle worker, exit codes
  readline.js            # piped input through readline.Interface
```

- **Conformance** (`test/conformance/`): `child_process/` (~10 cases: echo, argv, env, cwd, exit
  codes, signals, shell quoting, fork IPC), `workers/` (~10: message ordering, workerData, SAB,
  terminate, errors, eval), `readline/` (~5: lines, prompt, history, close, async iterator). Each
  case is a script plus a `.expected` recorded from `node v26.10.0`, and the differential harness
  runs it against both. Worker timing is kept out of expectations by making all output ordered by
  construction (sequence numbers, not wall-clock).
- **Rust units**: `ln-engine` SAB/serialize/cancel; `ln-io` proc spawn/pipe/kill/reap and the IPC
  frame codec; `ln-runtime` worker lifecycle, ref accounting, signal dispatch with a fake sink.
- **Interop**: `onde` spawns `node` and `node` spawns `onde`; `fork` is onde→onde (documented).
  Worker tests do not need node interop (threads are internal), but the same fixture runs under
  node in `test/proc` where the API is shared.

### 7.3 Regression gates

- `./test/conformance/run.sh` (all existing cases) still byte-identical; `RUN=node` still green.
- `./test/differential.sh` count grows; no existing case is skipped.
- `cargo test --all`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`.
- Cold start: `onde -e '1+1'` unchanged (worker/proc/signal pools are lazy, like the M4 service).
- `./test/net/run.sh` still green (the completion router changed, so net is the first regression
  suspect).

## 8. Divergences to record (D48–D53)

| ID | Divergence | Why |
|---|---|---|
| D48 | `worker.terminate()` cannot interrupt a worker blocked in `Atomics.wait` or a native syscall; it takes effect when that call returns. Intra-worker JS (`while(true)`, a long loop) is interrupted at the next bytecode check | QuickJS has no way to wake another isolate's `Atomics` waiter; termination is cooperative (ADR-0008 §5) |
| D49 | `transferList` supports `ArrayBuffer` (the source is detached and the destination gets a **copy**) and ignores `SharedArrayBuffer`; functions/`MessagePort`s are rejected. Ports cannot be transferred between threads | zero-copy transfer needs an engine detach-with-move API; port transfer needs a port table in the wire format. Both are 1.1 work |
| D50 | `child_process`: no `spawnSync`/`execSync`/`execFileSync`; `fork` IPC is length-prefixed JSON and cannot talk to a real `node` parent; `stdio: "ipc"` outside `fork`, `windowsHide`/`windowsVerbatimArguments` and the `serialization: "advanced"` mode are accepted and ignored; on Windows `kill` maps to `TerminateProcess` | the sync forms need a second, blocking spawn path and a different cancellation model; IPC is internal to onde |
| D51 | Signals: catchable set is `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT`/`SIGUSR1`/`SIGUSR2`; no `SIGCHLD`/`SIGWINCH`/`SIGSTOP` listeners; Windows only `SIGTERM`/`SIGKILL`; workers cannot install process signal handlers | tokio's signal set plus the default-disposition re-raise covers the signals a CLI actually uses; stopping/continuing needs `sigprocmask` control that crosses the loop |
| D52 | `readline`: line-oriented; no raw-mode key-by-key editing, history arrows or terminal width detection. `tty.setRawMode` remains a flag (D38), so the terminal stays in canonical mode | the raw-mode gap is in `tty`, not `readline`; fixing it is a `termios` change with its own milestone |
| D53 | Workers: `resourceLimits` ignored (accepted), no `stdout`/`stderr` capture options, no `SHARE_ENV`, `getHeapStatistics()` reports the process engine heap, worker `error` is reconstructed from `{name, message, stack, code}` rather than being the same object | no per-worker memory cap until M7's `JS_SetMemoryLimit` wiring; an `Error` cannot cross isolates, so its data does |
| D22 | *Amended*: `process.cpuUsage()` now returns real `getrusage` values for the current process; it does not report per-thread usage and does not reset | closes the M2 placeholder for the main process |
| D34 | *Amended*: `process.env` mutations still do not reach the OS environment, but they **are** inherited by `child_process` children, because the JS layer passes `process.env` explicitly (the host clears and sets the child environment) | this is what npm-style tools expect |

## 9. Performance

M5 has one performance target (worker echo) and no throughput target for `child_process`. The number
that matters is message cost, and it is dominated by engine serialization:

- `test/proc/worker-echo.js` reports round-trips/sec for 20k and 1M messages. Baseline is measured
  on the target machine, not promised in advance; the acceptance bar is **ordering**, plus no
  unbounded growth in RSS across the run.
- The echo harness keeps payloads small (a number and a short string) so the result measures the
  transport, not the encoder. A second row with a 1 KiB `Uint8Array` measures the copy.
- `workerData`, `postMessage` and environment data all serialize on the isolate thread; no message
  is queued as a `JSValue` (H1).

## 10. Risks

| ID | Risk | Mitigation | Trigger to act |
|---|---|---|---|
| W1 | SAB lifetime bug (use-after-free across isolates) | the ownership rules in §3.6 are the only places `sab_dup`/`sab_free` are called; unit tests assert the refcount around each; a 10k-message stress loop with GC pressure; `cargo test` under ASan is not available, so the rules are reviewed line by line | any crash/refcount assertion in the stress loop |
| W2 | Worker termination leaves threads or refs behind | `RefTable` + parent `JoinHandle` list; shutdown test asserts no live threads (via a test-only counter) and zero refs | a hung test or a growing thread count |
| W3 | `fork` fd-3 inheritance is fragile (macOS/Linux) | WP4 timebox 2 days; fall back to `fork` unsupported on the failing platform and record it in D50 | `fork` fails on either CI platform |
| W4 | Signal tests interfere with the CI runner | signals only in `test/proc/signals.js`, never in unit tests; the harness uses its own child processes and restores default dispositions | a test run that receives a stray `SIGINT` |
| W5 | `exit`/`close` ordering regressions under load | dedicated conformance cases and a stress loop with 100 children | any ordering failure |
| W6 | Completion-router regression (net/http) | router order is op → net → proc → worker, so net ids are found before the new tables; the M4 harness runs in CI | any M4 case failure |
| W7 | QuickJS stack overflow on 8 MiB threads for deep recursion | worker threads use an 8 MiB stack; a recursion test in `test/proc` | overflow in a realistic script |

## 11. Decisions taken here that need a second opinion

1. **Worker = nested isolate, not shared context.** ADR-0008 §2. It is the only way to get real
   parallelism, and it reuses the loop and bootstrap. The cost is that the parent cannot construct
   the worker's isolate; the channel-first constructor is the interface change.
2. **Process = one handle with stream-tagged events**, not three pipe handles. Fewer ids, one ref
   per child (Node semantics), one task for exit/close. The cost is per-stream in-flight state in
   Rust and `readStop`/`drain` needing a stream argument.
3. **SAB via engine serialization**, not a custom serializer. It is the only way to pass a
   `SharedArrayBuffer` across isolates; the wire format is engine-internal, so worker messaging is
   version-locked to the binary (same process, so this is free).
4. **`fork` IPC over fd 3 with length-prefixed JSON**, onde-only. It matches Node's API shape,
   not its wire format; documented as D50.
5. **Signals limited to the six that matter**, with default-disposition re-raise. A smaller surface
   that behaves correctly beats a table of names that silently do nothing.

## 12. Outcome (2026-11-15)

Everything in §1 ships. The exit criteria and the gates that prove them:

| Gate | Result |
|---|---|
| Rust tests | **372** across the workspace, green (`cargo test --all`) |
| Conformance corpus | **230/230** under onde, **220/220** re-validated under node (`RUN=node`), 10 divergence cases onde-only |
| Differential harness | **220/220** byte-identical stdout + exit code (node vs onde) |
| JS stdlib suites | **75/75** under node and onde |
| M5 acceptance (`test/proc/run.sh`) | **12/12** (six scripts, each under node and onde) |
| Worker echo | **1,000,000** round-trips, zero ordering failures, ~23k/s under onde on this machine (node: ~168k/s) |
| 8-worker counter | **exactly 400,000** with `Atomics.add`; `Atomics.wait` woke from a worker's `notify` |
| Termination | busy worker → `exit 1`, parent process exits, no leaked thread/ref |
| Zombie-free | after `SIGKILL`, `process.kill(pid, 0)` throws `ESRCH` (the task reaps) |
| Cold start | release `onde -e '1+1'`: **12.16 ms** median (limit 14); `require("http")`: **21.00 ms** (limit 25) |
| Hygiene | `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo deny` CI job unchanged |

Things that changed from the plan while implementing, all deliberate:

1. **The forked child's IPC channel is a singleton, not a proc-family handle.** `fork` gives the
   child exactly one inherited descriptor, so `IpcBridge` uses a reserved completion id
   (`u64::MAX - 1`) and `host.ipc(name, args)` instead of a fourth handle table. It still holds one
   loop ref while the channel is open.
2. **`ln-io::proc` gained two things WP4 needed:** `spawn_with_ipc_child` (the child end is
   `dup2`'d onto fd 3 in `pre_exec`, and `ONDE_IPC_FD` is exported) and `IpcSession` (the child-side
   reader/writer). The WP3 module deliberately stopped at handing both ends back; §6 said WP4
   owned the fd plumbing, and that is where it landed.
3. **IPC disconnect flushes before closing.** `process.send(...); process.disconnect()` was dropping
   the last frame until the writer was made to drain its queue before shutdown. The acceptance
   `fork` case caught it.
4. **`close` drains output the caller never read.** Node emits `close` after `exit` even when no
   one listened to stderr; the task now reads what remains in the OS pipe after `exit` so EOF (and
   therefore `close`) cannot be held hostage by an unread stream.
5. **A spawn failure reports `close(-errno)`, not `close(null)`.** Node 26 emits `-2` for ENOENT;
   the JS layer now passes the negated `errno` through.
6. **`parentPort` is unref'd until it is started.** An active listener (or `onmessage`/`start()`)
   takes the worker's own loop ref; `unref()`/`close()` releases it. That is why a worker with only
   `console.log` exits and a worker with `parentPort.on("message")` stays alive.
7. **Signal listeners hold a loop ref, and removing the last one restores `SIG_DFL` immediately**
   (the plan described restoring on the next delivery). Both match Node: a process with a signal
   listener runs until the signal arrives, and removing listeners makes the signal default again.
8. **`process.cpuUsage(previous)` subtracts**, like Node; `process.kill` throws `ESRCH`/`EPERM`
   rather than returning false (only `child.kill` returns a boolean).
9. **`getEnvironmentData` is per isolate**, not process-wide (recorded in D53). Worker-to-worker
   sharing needs the same serializer as messages and was not worth another capability.

Known limits recorded as divergences: no `spawnSync` family, onde-only `fork` IPC, no
`MessagePort` transfer between threads, `resourceLimits` ignored, cooperative `terminate`, and
line-oriented `readline` (D48–D53 in [compat.md](compat.md)).
