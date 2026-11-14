# ADR-0006: Handles and events — the streaming half of the I/O protocol

- Status: accepted
- Date: 2026-11-14
- Supersedes: none
- Related: [0003 event loop](0003-event-loop.md), [0005 ops protocol](0005-ops-protocol.md),
  [architecture](../architecture.md) §5, [M4 plan](../m4-plan.md)

## 1. Context

[ADR-0005](0005-ops-protocol.md) describes every host capability as one `Op` in and one `OpDone`
out: a completion settles exactly one promise or callback (O2), and the op holds exactly one loop
ref from submit to settle (O3). That is the right shape for a filesystem call and for
`dns.lookup`: bounded work, one result, done.

M4 adds `net`, `http`/`https` and `tls`, and a TCP socket is not that shape:

- **It lives.** One `connect`, then unbounded `data` events over minutes, then one `close`. There
  is no single "result" to settle.
- **It is bidirectional.** Bytes flow out (`write`, `end`) as well as in, and the outbound side
  needs its own backpressure and completion signal (`drain`).
- **It is read on demand.** `pause()`/`resume()` are user-visible, and ADR-0005 §10 already says
  streaming is pull-based. A socket that reads whenever bytes arrive violates it.
- **It is tunable after the fact.** `setNoDelay`, `setKeepAlive`, `setTimeout` change a live
  connection, so the capability surface is a command channel, not a request.
- **Its lifetime decides loop exit.** A listening server keeps the process alive; a `keepAlive`
  agent socket must not; `unref()` toggles that at runtime. O3's one-ref-per-op cannot express it.

Emulating this with one `Op::Read` per chunk fails on all five, and it would create a new abort
flag, a new loop ref and a new completion per 64 KB — exactly the per-call metadata M6 is meant to
own. M5's `child_process` stdio pipes have the same shape, so whatever M4 locks in, M5 inherits.

## 2. Decision

**A host capability is either an op (bounded, one settle) or a handle (live, many events).**
Ops keep ADR-0005 unchanged. Handles are a second, strictly separate primitive.

1. **A handle is an id plus a task.** One allocator in `ln-runtime` mints every id: JS calls
   `host.nextRequestId()`, and a task that creates a handle itself (an accepted connection) calls
   the `HandleIdSource` closure the runtime handed it. Same sequence, so an id can never collide
   with an id minted on the other thread; `0` means "no handle".

2. **Commands go one way, events the other, both by id.**
   `host.net(id, name, args)` submits a command; it returns `undefined` and throws synchronously on
   invalid arguments, so `server.listen({port: "x"})` fails at the call site like Node.
   Events arrive as `__ln_handle_event(id, name, payload)`, and the payload is plain Rust data
   converted on the isolate thread by the same table-driven conversion the op results use.

3. **Events reuse the completion channel, batched.** A task hands its pending events to the shared
   handle table through its `EventSink` and sends **one** `Completion(id)`. The completions phase
   drains that handle's queue, dispatching each event and checkpointing once after the batch.
   `ln-sched` still sees only `u64`; no event payload enters its type space. At 20k req/s this is
   one wake per batch, not one per read.

4. **Loop refs are per handle, not per event.** A handle takes one external ref when it becomes
   active (`listen`, `connect`); `close` releases it at most once. `unref()` releases it early and
   `ref()` takes it back, both as idempotent booleans on the handle, because `Agent`'s idle pool
   and `server.unref()` both need them. O3 is restated: *at most one ref per live handle, never
   underflowing*.

5. **A handle can be in raw or parsed mode.** Raw mode forwards `data` bytes. `httpAttach(role)`
   puts the connection into parsed mode, where the HTTP state machine consumes the bytes and emits
   message events; `detach` hands the socket back to raw mode for `'upgrade'`/`CONNECT`. This is
   the only reason the HTTP layer does not need its own handle type, and it is why the raw socket
   for `'connection'` and `'upgrade'` is the same JS object.

6. **The HTTP parser runs in Rust, always.** QuickJS has no JIT; a byte-level HTTP parser in
   JavaScript caps throughput well below M4's 20k req/s target, and Node itself parses in C
   (llhttp). The parser is [ADR-0007](0007-http-codec.md)'s sans-io state machine in `ln-http`.

7. **Outbound request/response heads are serialized in JS.** `writeHead`/`setHeader` must throw at
   the call site, and the bytes Node sends are the bytes the user authored. JS produces the head,
   Rust parses it only far enough to learn the body framing (content-length vs chunked) and frames
   the body. Therefore no Rust header model exists on the output path, `rawHeaders` is trivially
   exact on input, and header case is never re-serialized.

8. **hyper is rejected.** hyper 1.x can preserve header case through its `ext` header maps, so case
   is not the blocker. The blocker is ownership: hyper consumes the connection and owns its
   lifecycle, while Node's `http` API requires the user to own it (`'connection'`, `'upgrade'`,
   `CONNECT`, `socket.setNoDelay`, half-close, `destroy`). Fighting that with `hyper::upgrade`
   adds an indirection per connection and still leaves `rawHeaders` and per-socket tuning outside
   the model, for ~8 extra crates. `httparse` + our own FSM keeps the socket ours and the parser
   testable without sockets.

9. **TLS is a transport wrapper, not a new protocol.** `rustls` sits between the socket and both
   modes; ALPN is fixed to `http/1.1`; the JS surface is `tls.connect`/`tls.createServer` plus
   `https`, with `rejectUnauthorized`, `ca`, `servername` and `getPeerCertificate` (subset).
   `TLSSocket` internals, session reuse and renegotiation are out of M4 and recorded as
   divergences.

## 3. Invariants

| ID | Invariant |
|---|---|
| H1 | No `JSValue`, `Persistent`, `Ctx` or `Context` is stored in a command, an event, a handle slot or a task |
| H2 | Every event is dispatched exactly once, in task order; `closed` is last and exactly once |
| H3 | A handle's loop ref count is 0 or 1 and never underflows; `close` releases it at most once |
| H4 | No event is delivered for a handle after `closed`, and no event is delivered after shutdown |
| H5 | A command is addressed to an existing handle; an unknown id is ignored, never a panic |
| H6 | A handle in parsed mode emits no `data`; bytes already read past a head are handed over with `upgrade` (or as the first `data` after `detach`) and never parsed twice |
| H7 | A task never blocks the async worker: every wait is an await point, and every buffer is bounded |

## 4. Alternatives considered

- **One op per read/write** (keep ADR-0005 as the only primitive): uniform, but it re-creates
  per-chunk metadata, cannot express `pause`/`drain` without a second table anyway, and makes the
  loop-exit refcount depend on how many reads happen to be in flight. Rejected.
- **A widened `OpDone` carrying `data` payloads** (stream events through the op table): no new
  primitive, but the op table is keyed by a one-shot request and `take` removes the slot; a
  streaming handle would need a second lifetime anyway. Rejected as the worst of both.
- **hyper + rustls** (risk register R5's original mitigation): see §2.8. Rejected.
- **A JS HTTP parser**: closest to Node's own layering, but no JIT. Rejected on the 20k req/s
  criterion.
- **`mio` on the isolate thread** (libuv's model, readiness callbacks into JS): already rejected by
  ADR-0003; it also makes the microtask checkpoint depend on kernel readiness order.
- **One OS thread per connection**: 10k connections would be 10k threads and 10k stacks. Rejected.

## 5. Consequences

- `ln-io` gains a second execution mode: long-lived async tasks on the same tokio runtime, next to
  `spawn_blocking` for fs. The pool stays one process-wide, lazily created singleton; socket tasks
  are non-blocking and do not consume `--io-threads` (which still bounds fs/DNS blocking work).
- The runtime gains a handle table next to the op table, and `lib.rs`'s completion dispatch grows a
  second arm (`handle` vs `op`). The `Completion` type does not change.
- M5's `child_process` stdio and the eventual `process.stdin` handle reuse this protocol, with a
  `readable`/`writable` flag instead of a socket.
- Timeouts inside a task are real-time and emit a `timeout` event; they never fire a JS timer, so
  `ln-sched`'s fake clock stays the only authority on timer ordering. A test that scripts
  completions still never sleeps.
- `http`'s JS surface is a `Readable`/`Writable` pair over the M3 stream layer, so backpressure,
  `pipe`, `pipeline` and `addAbortSignal` work without new machinery.
- The cost is a second protocol to review. It is deliberately shaped like the first: one id, one
  name, one args array, one settle point, so the review is a diff against ADR-0005 rather than a
  new design.
