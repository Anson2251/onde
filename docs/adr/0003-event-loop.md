# ADR-0003: Event loop and I/O offload

- Status: accepted
- Date: 2026-11-13
- Related: [0002 scheduler](0002-microtask-scheduler.md), [architecture](../architecture.md)

## 1. Context

Node's loop has phases (timers → pending → poll → check → close) and libuv underneath. A
QuickJS isolate cannot share libuv's model directly: JS values are runtime-local, the engine
has no `poll` integration, and any I/O completion must come back to the isolate thread to touch
JS. Meanwhile the engine has no timers at all, so the loop must own them.

Two broad options:

- **A. Everything on the isolate thread, mio for readiness.** Full control over phases and
  ordering, but every protocol (TLS, DNS, HTTP) has to be written against a manual state
  machine, and blocking-pool work needs its own thread pool anyway.
- **B. Isolate thread runs a deterministic loop; I/O is offloaded to a tokio pool and returns as
  owned completions.** Most of the hard protocol work reuses mature async crates; the JS side
  sees only "a completion arrived".

## 2. Decision

**B.** The isolate thread never does blocking I/O and never awaits. It owns timers and the
microtask scheduler, and blocks in exactly one place: waiting for the next completion or timer
deadline.

```
loop {
    // 1. timers due now (snapshot taken at phase entry)
    for t in timers.due_snapshot() { run_callback(t); checkpoint(); }

    // 2. completions that arrived (the "poll" substitute)
    for c in completions.drain(MAX_PER_TURN) { dispatch(c); checkpoint(); }

    // 3. immediates queued so far (the "check" substitute)
    for i in immediates.snapshot() { run_callback(i); checkpoint(); }

    // 4. exit check
    if refs == 0 {
        emit(beforeExit);
        checkpoint();
        if revived { continue; }
        emit(exit, code);
        return code;
    }

    // 5. block until the next timer deadline or a completion; the only blocking point
    completions.wait_timeout(next_deadline());
}
```

Rules:

- Timers are a heap keyed `(deadline, seq)` in `ln-sched`, not tokio timers. The loop computes
  its own timeout. `setTimeout` clamps to 1 ms (Node), `setInterval` reschedules from the
  deadline, immediates are a FIFO.
- A timer due list is snapshotted at phase entry: timers scheduled during the timers phase run
  in the next turn (Node behaviour, and it prevents self-rescheduling starvation).
- Completions are macrotasks. They are never executed from inside `poll`; they are queued,
  dispatched, and each is followed by a checkpoint.
- `MAX_PER_TURN` is a fairness knob (default: unlimited, Node-like). Under sustained I/O, timers
  can starve exactly as they can in Node; `--max-completions-per-turn` bounds it for embedders.
- Signals (`SIGINT`, `SIGTERM`) arrive through the same channel from a `signal-hook` thread, so
  signal handlers are ordinary macrotasks and cannot interrupt JS mid-instruction.
- Worker message ports and `MessageChannel` also arrive as completions. There is one wakeup
  primitive (the channel) and one waker.

## 3. Why not mio on the isolate thread

Not a performance argument — a scope argument. Readiness-based networking forces us to write
TLS, DNS, HTTP parsing and connection pooling as manual state machines on top of a
non-blocking reactor, which is where most of the 6-week M4 estimate would go. `tokio` +
`rustls` + `hyper` already solve that, and their work is `Send` by construction. The cost is
that Node's exact `poll`-phase ordering is approximated, which we document and test.

The offload pool is created lazily and is shared by all isolates in the process. It has no
access to JS: its API takes owned payloads and returns owned payloads.

## 4. Reference counting and exit

The loop counts live handles and pending requests:

| Keeps the loop alive | Does not |
|---|---|
| active timers (unless `unref`ed) | finished timers |
| listening sockets, open connections | closed sockets |
| pending async ops | completed ops |
| immediates | drained immediates |
| `ref`ed message ports | `unref`ed ports |

Zero refs → `beforeExit` (which may schedule work and revive the loop) → next turn → `exit`
listeners → teardown. `process.exit(code)` skips `beforeExit`, drains nothing (ADR-0002 §6),
runs `exit` listeners synchronously, and returns.

## 5. Divergences from Node (documented, tested)

| Area | Node | lite-node | Why |
|---|---|---|---|
| Phase order | timers → pending → poll → check → close | timers → completions → immediates → block | no libuv readiness set; completions stand in for poll |
| `setTimeout(0)` vs `setImmediate` at top level | nondeterministic in practice | whichever phase sees its work first: a timer is due only once `now >= deadline`; a 1 ms timer created in the same turn is not due yet, so its immediate runs first — the same rule Node effectively follows | no libuv polling; the due-time rule is explicit and testable |
| Close callbacks | dedicated phase | dispatched as completions | no separate close queue; ordering still `close` after `error`/`end` |
| `fs.watch` | inotify/FSEvents/kqueue | polling watcher in 1.0, native events 1.1 | scope |
| `setInterval` drift | no compensation | no compensation | matches Node default |
| Threadpool size | `UV_THREADPOOL_SIZE` | `--io-threads` (tokio blocking pool) | different pool, same idea |

The ordering corpus in ADR-0002 §9 is the contract for everything the loop controls. These
divergences are outside that corpus and are asserted explicitly in `test/conformance/loop/`.

One sub-case is worth naming because Node's own result is timing-dependent: a `setTimeout(0)`
created inside `process.nextTick` (before the loop starts) can run before or after a top-level
`setImmediate` in Node, depending on how much wall time the tick took. lite applies the due-time
rule above, so the immediate runs first. j2-style programs in Node flip between both orders; the
corpus only contains cases where Node is stable.

## 6. Testability

- `Clock`: fake clock drives timers and budgets; no `sleep` in unit tests.
- `Reactor`: the trait has three implementations in `ln-sched`: `ChannelReactor` (the real
  `mpsc` completion channel whose sender is the waker), `FakeReactor` (scripted completions, so
  "a completion arrives during a timer callback" is a deterministic test), and `Sleeper` (sleep
  only, for embedders that never register I/O). M1's runtime already blocks on the channel.
- Real-I/O tests run in a separate integration suite with an explicit ordering tolerance only
  where Node itself is tolerant.
- `--trace-events` emits one trace event per phase and per callback, which makes ordering bugs
  visible in `chrome://tracing` instead of in printf logs. (M7.)

M1 implementation notes: the driver (`ln-sched/src/driver.rs`) owns timers, immediates,
completions and the refcount. The heap is keyed `(deadline, seq)` and lazily cancelled; it is
compacted when stale nodes outnumber live timers so a create/clear loop stays flat (measured
3.57 MB vs 3.41 MB baseline across 200k cycles). `beforeExit` is emitted once per idle period; a
timer or immediate scheduled by the handler revives the loop, while a `nextTick` or microtask
does not (verified against Node), because those run inside the checkpoint that precedes the
exit decision.

## 7. Consequences

- The loop is ~300 lines of deterministic policy with no async runtime dependency. That is a
  large reviewability win and the reason the scheduler contract can be enforced.
- All I/O correctness risk is concentrated in `ln-io`, behind a payload-only boundary
  (`OpDone`), which is also where the `hyper`/`rustls` decision lives.
- Node's phase-exact behaviour is not promised. The promise is: the documented ordering corpus
  and the compat matrix, both tested.
