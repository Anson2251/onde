# Architecture

## 1. Isolate model

One isolate = one OS thread = one `JSRuntime` + one or more `JSContext`s (realms) + one
scheduler. There is no shared JS heap between threads. A worker is a separate isolate, constructed
on its thread; the only cross-thread channel is a queue of owned Rust payloads plus a waker. A
worker message is engine-serialized bytes plus a refcounted `SharedArrayBuffer` pointer table,
reconstructed into a `JSValue` on the destination thread; no `JSValue` itself crosses (ADR-0008
§2.3).

```
         ┌─────────────────────── isolate thread ───────────────────────┐
         │  ln-runtime::Isolate                                         │
         │    ├─ ln-engine::Runtime   (JSRuntime, contexts)             │
         │    ├─ ln-sched::Scheduler  (ticks, micros, timers, events)    │
         │    ├─ module cache / loader                                   │
         │    └─ op registry                                            │
         └───────────────▲──────────────────────────────┬───────────────┘
                         │ completions (owned payloads) │ spawn async ops
                         │                              ▼
         ┌───────────────┴────────────────────── ln-io tokio pool ──────┐
         │ fs, dns, tcp, tls, child_process, http internals             │
         └──────────────────────────────────────────────────────────────┘
```

Why not one thread per connection or tokio inside JS: QuickJS values are refcounted pointers
owned by a runtime, `Ctx`/`Persistent` are `!Send`, and the interrupt/stack bookkeeping is
per-thread. Moving JS execution across threads would require `JS_UpdateStackTop` discipline on
every hop and would make microtask ordering nondeterministic. The offload pool keeps that
boundary at exactly one place: `OpDone` messages.

## 2. Crate graph

```
ln-cli ──▶ ln-runtime ──┬─▶ ln-sched           (pure policy, no engine)
                        ├─▶ ln-engine ──▶ ln-sys (bindgen, vendored quickjs-ng)
                        ├─▶ ln-modules          (resolution, no engine)
                        ├─▶ ln-io ──▶ ln-http   (net/TLS, child processes, signals)
                        ├─▶ ln-crypto
                        └─▶ js/                 (bootstrap + node: modules)

ln-io, ln-http, ln-crypto ──▶ ln-error          (Node error model, no deps)
```

| Crate | Owns | Must not |
|---|---|---|
| `ln-sched` | queues, checkpoint, timers, loop driver, events | know about QuickJS, allocate per job where avoidable |
| `ln-engine` | `JSRuntime`/`JSContext` lifetime, value handles, class registry, promise hooks, interrupt/cancel, the `Job::Engine` adapter, the process-global `SharedArrayBuffer` allocator and cross-isolate serialization | contain Node semantics |
| `ln-runtime` | bootstrap, the engine's resolver/loader callbacks, host primitives, op/handle/proc/worker registries, event→JS mapping, the worker thread lifecycle | call `execute_pending_job` directly |
| `ln-modules` | CJS/ESM resolution, `package.json` maps, file URLs, CJS named-export scan | know about QuickJS, read a `JSValue`, decide runtime policy |
| `ln-io` | fs syscalls, the tokio offload pool, net transports (TCP/Unix/TLS) with their connection tasks, child processes with pipes/IPC, and signal delivery; `Op` and handle execution | hold a `JSValue`, call into JS, decide HTTP or Node policy |
| `ln-http` | HTTP/1.1 framing: head parsing, chunked codec, limits, the peer's keep-alive intent | own a socket, depend on tokio, decide JS-visible policy |
| `ln-crypto` | hash/HMAC/HKDF state and random generation | do I/O, depend on `tokio`, hold a `JSValue` |
| `ln-error` | `NodeError`, errno→code and message tables, argument-error constructors | know about QuickJS or any runtime policy |
| `js/` | the user-visible Node API where JS is expressive enough | reach into engine internals |

The `ln-sched`/`ln-engine` split is the whole point: policy is testable without FFI, and the FFI
adapter is thin enough to review.

## 3. Boot sequence

1. Parse CLI with `clap` (derive), build `Config` (memory cap, stack size, module roots,
   permissions). The CLI stays thin on purpose: argument handling is library work, and no
   runtime semantics are allowed to live in `ln-cli`.
2. Create `JSRuntime`; set memory limit, max stack size, GC threshold, interrupt handler.
3. Spawn/attach isolate thread; `JS_UpdateStackTop`; `JS_SetCanBlock(true)` if workers are enabled.
4. Create the main context; install the host primitives and the fd table (`Buffer`, `FileHandle`,
   `Stats`, `Dirent` and, from M4, `Socket`/`Server` stay JavaScript; a socket is a handle over
   `ln_io::net`, not an engine class).
5. Install `ln-engine` hooks: job adapter, promise rejection tracker (M1), interrupt deadline
   for the checkpoint budget (M1).
6. Evaluate `js/bootstrap.js` (bytecode snapshot in M7). It defines `console`, `process`,
   globals, and registers native modules. Bootstrap runs through the normal loop, so its
   microtasks obey the same rules — no special "before the loop" phase.
7. Resolve the entry point. ESM: compile, link, evaluate, and let the loop settle the TLA
   promise. CJS: read, wrap, execute.
8. Checkpoint after evaluation, then run the loop until the refcount reaches zero or
   `process.exit` is called.
9. Shutdown: `beforeExit` (when the refcount reaches zero) → `exit` listeners → drop queued
   jobs → free contexts → free runtime.

Step 6 is deliberately not "eval and ignore". Bootstrap failures must produce a Node-shaped
error and a non-zero exit, and bootstrap-registered timers must behave like user timers.

## 4. Engine boundary

`ln-engine` exposes a narrow safe API:

```rust
pub struct Runtime { /* JSRuntime, memory caps, hooks */ }
pub struct Context { /* JSContext */ }
pub struct Value<'js> { /* RAII JSValue */ }
pub struct Persistent<T> { /* rooted across turns */ }

impl Runtime {
    pub fn new(cfg: &Config) -> Result<Self>;
    pub fn set_job_sink(&mut self, sink: JobSink);          // patched build
    pub fn pump_one(&mut self) -> PumpOutcome;              // unpatched build
    pub fn set_async_hooks(&mut self, hooks: Option<AsyncHooks>);
    pub fn set_rejection_tracker(&self, tracker: impl Fn(...)); // M1: settle/attach events
    pub fn set_interrupt_deadline(&self, deadline: Option<Instant>); // M1: budget guard
    pub fn run_gc(&mut self);
    pub fn memory_usage(&self) -> MemoryUsage;
}
```

Rules at this boundary:

- Every `JSValue` is wrapped and dropped deterministically; no raw handles in `ln-runtime`.
- Calls that can throw return `Result<Value, Exception>`; the exception is converted to a
  `CaughtError` (message, stack, name) at the boundary, never stored as a pending engine
  exception across statements.
- `ln-engine` never decides when to drain. It exposes `pump_one`/`JobSink`; `ln-sched` decides.
- The unpatched and patched builds implement the same `JobSink` trait so `ln-sched` has no
  `cfg` branches.

## 5. Ops protocol

Every host capability is an op. Two kinds:

**Sync op** — runs on the isolate thread and never waits on external readiness. It may block on a
syscall exactly as Node's sync APIs do (`readFileSync` of a large file is not fast, and must not
be made async), and it may call back into JS.

```rust
fn op_fs_stat_sync(cx: &mut OpCtx, args: &[Value]) -> Result<Value> {
    let path = args.at(0).to_str()?;                 // validated, converted at the boundary
    let st = std::fs::metadata(path).map_err(|e| cx.error("ENOENT").from_io(e, "stat", path))?;
    Ok(cx.stats(st))
}
```

**Async op** — validates args, returns a promise, and posts work to `ln-io`:

```rust
fn op_fs_read_file(cx: &mut OpCtx, args: &[Value]) -> Result<Value> {
    let op = Op::ReadFile { path: args.0, abort: cx.abort_flag() };
    let promise = cx.new_promise();                  // resolve/reject functions stored by id
    let id = cx.ops().submit(op, promise.id());      // ln-io::spawn, Send payload
    cx.set_abort_hook(id);
    Ok(promise.into_value())
}
```

When the pool finishes it parks the result in the op table and sends only the id:

```rust
enum OpDone { Ok { id: RequestId, value: OpValue }, Err { id: RequestId, error: NodeError },
             Aborted { id: RequestId } }
```

The loop drains the completion channel, takes the slot for that `RequestId`, settles the stored
resolve/reject function (or invokes the callback form directly), then runs a checkpoint. The
completion itself is payload-free, so `ln-sched::Completion` stays a `u64` and `OpDone` never
appears in `ln-sched`'s type space. A pending async op holds a loop ref
(`Driver::ref_external`) and releases it when its slot is taken, so a script awaiting I/O cannot
exit early. `OpValue` is plain Rust (bytes, strings, numbers, lists); it converts to JS on the
isolate thread. There is no path for a `JSValue` to be sent.

Cancellation: each async op holds an `AbortRegistration`. `AbortSignal` firing sends
`OpCancel { id }` into the pool; the future is dropped at its next await point; the JS promise
is rejected with `AbortError`; the completion is ignored if it races.

Backpressure: ops that stream (fs read/write, socket read/write) are pull-based — the JS side
asks for the next chunk only when the consumer is ready, so the pool never runs ahead.

### Handles

An op is bounded work that settles once. A socket is not: it lives, emits events, takes commands,
and its lifetime decides whether the loop can exit. M4 therefore adds a second primitive next to
the op table ([ADR-0006](adr/0006-handles-and-events.md)), and M5's stdio pipes reuse it.

```rust
// ln-io::net — the handle protocol. Ids come from the same sequence as op ids.
pub type HandleId = u64;

enum Command { Listen(..), Connect(..), Read { max: u32 }, ReadStop, Write { data: Vec<u8> },
               End, Destroy, Detach, HttpAttach { role, limits }, HttpHead { bytes },
               HttpBody { bytes }, HttpEnd { keep_alive: bool }, SetNoDelay(bool), .. }

enum Event { Listening { local }, Connection { handle, remote }, Connected { local, remote, alpn },
             Data { bytes }, End, Drain, Timeout, Error { error }, Closed { had_error },
             Http(ln_http::Event), ClientError { error } }
```

- Commands go out through `host.net(id, name, args)`; events come back through
  `__ln_handle_event(id, name, payload)`. Both carry only ids and plain Rust data; the conversion
  to JS happens on the isolate thread.
- The task parks events per handle and wakes the loop with **one** `Completion(id)`, so
  `ln-sched` stays unaware of handles. The completion phase drains the handle's queue and
  checkpoints once per batch.
- Loop refs are per handle, not per event: one ref while listening or connected, released exactly
  once on `close`/`unref`, which is what makes `server.listen()` keep the process alive and an
  idle `Agent` socket not.
- A handle is in raw mode (`data`) or parsed mode (`request`/`response`/`body`, driven by
  `ln-http`); `detach` hands the socket back to raw mode for `'upgrade'` and `CONNECT`. This is
  why the raw socket in `'connection'` is the same object the HTTP layer reads from.

### Processes, workers and signals

M5 adds two more handle families and one singleton:

- **proc** — one child process is one id and one task; its three pipes are stream-tagged events,
  so the child holds one loop ref and `exit`/`close` ordering lives in one place. Commands go
  through `host.proc(id, name, args)`, events through `__ln_proc_event`.
- **worker** — a worker is a nested `Isolate` on its own thread. The parent creates the worker's
  completion channel, keeps a sender to wake it, and parks events for `__ln_worker_event`.
  `postMessage` values are engine-serialized bytes plus a SAB pointer table; the worker
  reconstructs them on its thread.
- **signals and the forked child's IPC** are process-level, not per-entity: signals use a reserved
  completion id and a token sink per signal, and a forked child has exactly one IPC descriptor, so
  it too uses a reserved id rather than a fourth table.

The completion router is therefore: reserved ids (IPC, signals) → ops → net handles → proc →
worker. Every id comes from the one `RequestIdAllocator`, so the order is only a lookup
convenience, not a type tag.

## 6. Module system

The full decision record is [ADR-0004](adr/0004-module-system.md). The implementation split:

- **`ln-modules`** owns resolution: the CJS `require` algorithm (extension and `index` lookup,
  `main`, `type`), ESM resolution (no extension search, directory errors), `exports`/`imports`
  maps with condition ordering and subpath patterns, file-URL conversion, and the CJS
  named-export scan. It has no engine dependency, so its tests run without QuickJS.
- **ESM** is native. `ln-runtime` implements `Resolver`/`Loader` for QuickJS: it turns a
  resolution into a canonical module name (`file:///abs/x.js` or `node:path`), reads the source,
  fills `import.meta` (`url`, `filename`, `dirname`, `main`, `resolve`), and returns a declared
  module. Dynamic `import()` goes through the same loader and settles through the job queue.
- **CJS** is a JavaScript loader (`js/lib/loader.js`): cache, module records, `require.resolve`,
  `require.cache`, `require.main`, `module.paths`, JSON loading, the builtin registry. Rust
  contributes one primitive, `host.evalCjs`, which compiles the Node wrapper with the real
  filename (stack traces) and calls it with `this === module.exports`.
- **Interop** is generated source evaluated by the engine: ESM importing CJS gets
  `default = module.exports` plus the statically scanned names; builtins get the same facade over
  `__ln_builtin_exports`; JSON becomes a parsed `default` export. CJS importing ESM is a clear
  `ERR_REQUIRE_ESM`; `import()` is the supported direction.
- `node:` builtins are plain embedded sources in `js/lib/`; the registry in
  `crates/ln-runtime/src/modules.rs` is the single list. Import attributes are parsed and
  accepted (JSON does not require one; see compat D18).

## 7. Timers and handles

`ln-sched` owns a binary heap keyed by `(deadline, seq)`, plus a separate `setImmediate` FIFO.
Handles are refcounted for exit purposes (`ref`/`unref`). Node's 1 ms clamp is applied at
schedule time; `setInterval` reschedules from the deadline, not from execution (documented
divergence: no drift compensation, same as Node's default). Cancelled and rescheduled timers
are removed lazily, and the heap is compacted when stale nodes outnumber live ones, so a
create/clear loop does not grow RSS (M1 exit criterion).

The heap is a data structure in `ln-sched`, not a tokio timer: timers must be inspectable
("what is keeping the loop alive"), deterministic under a fake clock, and independent of the
offload pool.

## 8. Error model

One Rust error type crosses every boundary:

```rust
pub struct NodeError {
    pub code: &'static str,        // ENOENT, ERR_INVALID_ARG_TYPE, ...
    pub syscall: Option<&'static str>,
    pub path: Option<PathBuf>,
    pub errno: Option<i32>,
    pub message: String,
    pub cause: Option<Box<NodeError>>,
    pub aggregate: Vec<NodeError>,
}
```

It converts to a JS `Error` with `code`, `errno`, `syscall`, `path` and a Node-shaped stack.

M3 moves this into the engine-free `ln-error` crate so `ln-io` and `ln-crypto` can produce the
same type without depending on each other or on the engine; `ln-runtime` owns the conversion to
`js::Error`. `ln-modules::ResolveFailure` keeps its own shape until a later pass — resolution
errors have a message and a code but no `errno`/`syscall`/`path`.

Uncaught errors are formatted by the runtime (not the engine): `file:line`, source excerpt,
caret, stack. That formatter is a small, testable crate-level function and is what makes CLI
errors feel like Node's. It also compensates for the CommonJS wrapper's line-1 column shift, as
Node's own renderer does.

## 9. Determinism and test seams

- `Clock` trait: real or fake. Timers and budgets go through it. All `ln-sched` tests use a fake.
- `Reactor` trait: real (completion channel) or fake (scripted completions). Ordering tests
  script the interleaving, so they never sleep.
- `OpDone` ordering is explicit; tests assert the dispatch order, not wall-clock timing.
- Integration tests that need real I/O are marked `#[ignore]`-free but ordered tolerantly where
  Node itself is nondeterministic; the scheduler corpus (ADR-0002 §9) is not tolerant.
- `--trace-events` records scheduler phases as Chrome trace events, so ordering bugs have a
  visual artifact instead of a printf hunt.

## 10. Memory and performance principles

- One `JSRuntime` allocation per isolate, reused across entry evaluations where possible.
- Atoms and property keys cached in `ln-engine` rather than rebuilt per call.
- `Buffer` is a `Uint8Array` subclass over a `Vec<u8>` (or an external slice) — no copy on
  `readFile`, no per-byte JS calls.
- Bootstrap + stdlib compiled to bytecode at build time; cold start is dominated by relocation,
  not parsing.
- Avoid `format!`/`String` in hot paths; op argument conversion is by-reference where possible.
- GC is cooperative: thresholds tuned per workload class, `--max-old-space-size` maps to
  `JS_SetMemoryLimit`, and OOM is fatal with a Node-shaped message (not a JS-catchable throw).
