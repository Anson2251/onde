# M7 implementation plan — performance and diagnostics

This is the working contract for M7. [roadmap.md](roadmap.md#m7--performance-and-diagnostics-4-w)
says *what* ships; this page says where it lives, what the engine owns versus the runtime, which
number each exit criterion is measured by, and what is deliberately left out. Three documents are
inputs rather than restatements: [m4-plan.md §8](m4-plan.md#84-performance-fixes-landed-while-closing-m4)
for the network ceiling M4 handed forward, [stdlib-consolidation-plan.md](stdlib-consolidation-plan.md),
whose A0–B2 phases already landed, and [standalone-build.md](standalone-build.md), which owns the
payload that shares M7's emitter and stamp.

Status: **accepted 2026-11-24. WP0 has not started.** §12 stays empty until the milestone closes,
the way §12 of the M5 and M6 plans was written afterwards.

M7 is the first milestone whose work is mostly *not* new surface. Nothing here adds a module or a
semantic; the milestone exists because three numbers miss their targets and because the runtime
cannot yet answer "where did the time go". The three numbers, all measured before M7
started:

| Number | Now | Target | Where it is tracked |
|---|---:|---:|---|
| HTTP throughput, 100 keep-alive connections | 12.9k req/s (43% of Node) | ≥ 66% of Node (1.5x) | [m4-plan §8.4](m4-plan.md#84-performance-fixes-landed-while-closing-m4) |
| RSS, 2,000 half-open connections | 67.0 MB | ≤ floor + 2 MB, ≈ 31 MB (§6.1) | [m4-plan §8.3](m4-plan.md#83-harness-and-ci) |
| Cold start, `-e 'require("http")'` | 19.0 ms | ≤ 25 ms (met, thin margin) | [roadmap](roadmap.md#m7--performance-and-diagnostics-4-w) |

## 1. What ships, in one table

| Area | Ships | Does not ship (written down instead) |
|---|---|---|
| Startup | `bootstrap.js` compiled to bytecode at build time, embedded, stamp-checked, loaded with `JS_EvalFunction`; source kept in debug builds for parity tests | A whole-context snapshot (QuickJS cannot serialize host functions or prototypes, §3.1); per-module bytecode for the JS stdlib (§3.2) |
| Memory | `--max-old-space-size` wired to `JS_SetMemoryLimit`; a per-worker limit from `resourceLimits.maxOldGenerationSizeMb`; `process.memoryUsage()` with a real `rss`; `--trace-gc` | A new/old-generation split, semi-space tuning, `--max-semi-space-size` (§7, D67); heap snapshots and `v8.getHeapSnapshot` |
| Diagnostics | `--trace-events` (Chrome trace JSON), `--trace-gc` (sampled), `--timing` (per-phase and per-op nanoseconds at exit), heap statistics | A sampling profiler (`--cpu-prof`), `--heap-prof`, `--prof`, the inspector protocol |
| Tests | `node:test` onde: `test`/`describe`/`it`, hooks, promise and callback tests, `onde --test`, one reporter; the API runs a pilot suite in CI | Mocking, snapshots, coverage, watch mode, `--test-only`, reporters beyond the one (§3.5, D71); migrating the 238-case conformance corpus (§3.5) |
| Fast paths | Lazy per-connection session state in `http`/`net`; an async-hooks crossing fast path if it measures; one allocation removed from `fs.readFile` if the ratio needs it | A JIT, a generational GC, multi-queue networking, `uv`-style handle pooling |
| Harnesses | `test/perf/run.sh` (ratios against Node), a cold-start protocol that records the machine state, `test/soak/run.sh` (1 h RSS slope), a `perf` CI job | Hard performance gates on shared CI runners (soft there, hard on the reference machine, §5) |

## 2. Where M7 starts

Two of the six workstreams in the roadmap row were finished early, so the milestone's budget is
smaller than the roadmap assumed and its scope had to be cut deliberately rather than by drift.

**Landed before M7:**

| Work | Commit | What it removed from M7 |
|---|---|---|
| stdlib consolidation A0–A5, B1–B2 | `5450b0d` | ~350 redundant lines, 13 `EMBEDDED` branches, and the base64/hex/`StringDecoder` codec gap (now 3.0x–18.8x of Node) |
| Standalone builds (`ondec`, payload, `ondec` link backend) | `9c78368` | the emitter, the ABI stamp and the bytecode loader — which is exactly what the startup snapshot needs (§2.1) |

**Measured at plan time** (release build, macOS arm64 M3, median of 25 runs through
`test/net/coldstart.js`, 2026-11-24):

| Expression | Quiet machine, AC | This machine, `lowpowermode 1`, load 4.9 |
|---|---:|---:|
| `-e '1+1'` | 12.2 ms | 19.1 ms |
| `-e 'require("http")'` | 19.0 ms | 30.8 ms |
| RSS, hello server | 9.3 MB | — |

The two columns are the same binary and the same harness. `pmset -g` reports
`lowpowermode 1` on the second row, which caps CPU frequency; the harness is a wall-clock
measurement and cannot tell the difference. That is not a regression to chase, it is a protocol
gap to close: **the mode and the load average become part of every recorded number** (§5), and the
gate runs on a reference runner. Until then, only the quiet-machine column is a claim about onde.

The other fact that shapes the milestone: the cassette of M7-tagged follow-ups is six documents
wide ([compat.md](compat.md) D11, D19, D21, D36, D37, D38, D53, WebCrypto, `node:test`;
[internals.md](internals.md) async-hook fast paths; [m6-plan §10.4](m6-plan.md#104-performance) the
`import()` upgrade; [m4-plan §8](m4-plan.md) the network ceiling). §3 decides each one rather than
letting all of them into the milestone.

### 2.1 What the tree already gives the snapshot

The startup snapshot is not a new subsystem. It is the app payload's emitter applied to one more
script, and every piece it needs already exists:

| Piece | Where | What the snapshot reuses |
|---|---|---|
| Module → bytecode emitter | `crates/ln-engine/src/compile.rs` (`compile::module`, `Options{name, strip_source, endian}`) | the compile-only path, the endianness option and the error shape |
| Bytecode → module loader | `Engine::eval_module_bytecode` (`crates/ln-engine/src/lib.rs:376`) | the `Module::load` + stamp-before-read discipline |
| ABI stamp (engine, `BC_VERSION`, atom hash) | `crates/ln-abi` (`Stamp::host`, `check`), embedded by `build.rs` | the same three facts, in a 25-byte snapshot header |
| Payload envelope and validation style | `crates/ln-payload` (magic, format, bounds checks, no checksum) | the rule that structure is validated, not trusted |
| Minify step that produces `OUT_DIR/js/bootstrap.js` | `crates/ln-runtime/build.rs` (oxc, mangling off) | the exact bytes the snapshot compiles |
| Raw FFI escape hatch | `crates/ln-engine/src/ffi.rs` | the pattern for the four engine calls rquickjs 0.14 does not wrap |

The engine calls exist in the committed bindings and need no new patch:
`JS_EVAL_FLAG_COMPILE_ONLY` (bindings `:34`), `JS_EvalFunction` (`:1718`),
`JS_WriteObject`/`JS_ReadObject` (`:1684`/`:1701`), `JS_SetMemoryLimit` (`:252`),
`JS_ComputeMemoryUsage` (`:549`), `JS_SetGCThreshold` (`:264`), `JS_RunGC` (`:300`). This is the
one M7 deliverable whose feasibility was never in doubt; the question was only its shape.

## 3. Decisions

These are the calls the milestone turns on. Each one names what was rejected, because the rejected
option is what a reader will reach for first.

### 3.1 The snapshot is a compiled *script*, not a context

`js/bootstrap.js` is evaluated as a global script at boot: `Isolate::install` calls
`Engine::eval_global(BOOTSTRAP, "<onde:bootstrap>")` (`crates/ln-runtime/src/lib.rs:593`). QuickJS
offers no way to serialize a context: bytecode can describe a function or a module, and the
bootstrap's globals are created by *running* it, while the host functions it captures live in Rust
and cannot be serialized at all. "Snapshot" therefore means: compile the script once at build time,
ship the resulting bytecode, and skip the parse-and-compile at boot.

The mechanism is qjsc's, in four engine calls:

```c
obj = JS_Eval(ctx, src, len, "<onde:bootstrap>",
              JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);   /* compile, do not run */
JS_WriteObject(ctx, &len, obj, JS_WRITE_OBJ_BYTECODE);            /* build time  */
...
obj = JS_ReadObject(ctx, bytes, len, JS_READ_OBJ_BYTECODE);        /* boot time   */
JS_EvalFunction(ctx, obj);                                        /* same semantics as eval_global */
```

quickjs-ng 0.17 defines `JS_WRITE_OBJ_BSWAP` as 0 ("obsolete, handled transparently"), so the
bytecode is always written in the producer's native order and the `endian` knob is advisory. The
envelope records the producer's order and the loader *refuses* a different one; a cross-built
snapshot is therefore not converted, only rejected. That is why a cross build has no snapshot until
someone measures the cost of producing one with the target's engine.

`JS_EvalFunction` on a global-scope function has the same observable behaviour as `JS_Eval` of the
source: the script's `var`/function declarations land on the global object and its top-level
`this` is `globalThis`. Keeping global scope is the reason not to compile the bootstrap as a
module: a module has its own scope, so the bootstrap would have to export its surface and the
runtime would have to install it, which is a different (and larger) change to
`js/bootstrap.js`.

**Rejected:** a module-wrapped bootstrap (changes the bootstrap's scope semantics and its
`__ln_*` global contract for a ~0 ms difference); a `JS_WriteObject` of the global object after a
warm boot (host functions are C function pointers; QuickJS refuses them, and a snapshot that
silently drops them is worse than no snapshot).

### 3.2 The snapshot covers the bootstrap only, not the stdlib modules

The embedded JS is 557 KB minified across 41 files, but modules are compiled when they are
`require`d, and most programs never load most of them. Compiling all of them at build time would
add tens of bytecode blobs, a registry to look them up, and — because bytecode is not uniformly
smaller than source ([qjsc.md §8](research/qjsc.md)) — a binary that grows for modules the process
never parses.

The bootstrap is different: it is loaded unconditionally on every start, and it is the thing
`require("http")` adds *on top of* — a program that imports `http` pays 19.0 − 12.2 = 6.8 ms more
than an empty one, which bounds what module compile can cost (`http` pulls the stream, buffer and
error modules with it, and the module graph is already lazy).

**Decision:** snapshot `bootstrap.js` in WP2; leave module compilation to the loader. WP2 records
the split (`bootstrap` vs `modules` vs `engine init`) so a later milestone can revisit the choice
with a number instead of an argument.

**Stop-loss:** if A/B measurement shows the snapshot saving less than 2 ms on `-e '1+1'`, WP2
keeps the source path selectable (`ONDE_BOOTSTRAP=source`), ships no default change, and withdraws the
criterion rather than tuning it. A snapshot that does not pay for itself in milliseconds is not worth a build-dependency that
links the engine into `build.rs`.

### 3.3 Memory limits are one limit, and out-of-memory is fatal

`JS_SetMemoryLimit` caps *malloc* for a `JSRuntime`. QuickJS has no separate old generation, no
semi-space and no young-generation counter, so Node's flag cannot be honoured literally. The
mapping is:

| Node | onde | Consequence |
|---|---|---|
| `--max-old-space-size=N` | `JS_SetMemoryLimit(rt, N MB)` | one limit for the whole heap; the flag name is kept because scripts and tooling pass it |
| `--max-semi-space-size`, `--min-semi-space-size` | accepted, ignored | there is nothing to size; D67 records it |
| worker `resourceLimits.maxOldGenerationSizeMb` | that worker's `JSRuntime` gets its own limit | the main isolate's limit does not apply to a worker's runtime, and a worker's does not leak back |
| exceeding the limit | `InternalError: out of memory`, uncatchable, exit 1 | Node throws `ERR_MEMORY_LIMIT_EXCEEDED` for a worker limit and the worker's `error` event carries it; onde's OOM is fatal inside the isolate that hit it (D68) |

The worker half closes D53's "no per-worker memory cap" and makes `resourceLimits` honest for the
two fields that matter; the other `resourceLimits` fields (`stackSizeMb`, `codeRangeSizeMb`) stay
accepted-and-ignored, as they are today.

`process.memoryUsage()` gets a real `rss` from the OS (`getrusage`/`mach_task_basic_info` via
`libc`, which `ln-runtime` already depends on) and keeps `heapTotal`/`heapUsed` from the engine
sample. `external` and `arrayBuffers` stay 0 until the engine exposes an external-buffer count,
which it does not (D21 narrows from "all five fields are the heap" to "three fields are real, two
are zero").

**Rejected:** a per-process limit shared by all worker runtimes (QuickJS enforces per runtime, so
sharing would mean re-implementing the allocator hook); reporting Node's `ERR_MEMORY_LIMIT_EXCEEDED`
from a fatal OOM (an uncatchable error cannot be delivered to a listener — the same reason
`process.exit` uses the uncatchable sentinel).

GC *tuning* is deliberately not in the milestone. The roadmap's "GC pressure heuristics" would mean
choosing `JS_SetGCThreshold` values per workload, which is a guess dressed as a feature; the engine's
own growth heuristic plus a hard limit covers the criterion, and `set_gc_threshold` exists only so
the tests can force a collection point. If the soak shows sawtooth RSS that no limit explains, WP6
gets a measurement and a threshold, in that order.

The lifetime audit the roadmap asks for is cheaper than finalizers: the runtime already counts live
handles, children, workers and jobs (`Isolate::live_handles`, `live_children`, `live_workers`,
`held_refs`). WP3 adds a debug-only teardown assertion that every counter is zero, with the counts
in the message, so a leaked fd or a retained handle fails a test at the place it was created rather
than an hour into a soak.

### 3.4 Diagnostics are one writer, three flags, and free when off

Node's three useful tools are a sampling profiler, a trace-event log and GC logging. Only the
second and third are affordable here: a sampler needs a signal timer and a stack-walk on a runtime
that has no `JS_Profile` API, and the roadmap excluded it. What M7 ships instead:

| Flag | Output | Source of the data |
|---|---|---|
| `--trace-events[=FILE]` | one Chrome-trace JSON array: `metadata`, `turn`, `phase`, `op`, `gc`, `exit` | turn and phase boundaries from `ln-sched`; `op` from the two submission points — `OpBridge::submit` (`ln_runtime::ops`, `ln_io::Op`) and the handle-command path (`ln_io::Command`) — not from the ~70 individual host functions |
| `--timing` | one line per phase and per `Command` variant at exit: count, total ns, max ns, sorted | the same hooks as `--trace-events`, aggregated instead of written |
| `--trace-gc` | `gc` events when the engine heap drops | `JS_ComputeMemoryUsage` sampled at turn boundaries, emitted only when `used` falls by more than 10% |

The vocabulary is ours, because Node's `--trace-events` is consumed by its own inspector protocol
and does not exist as a stable format; the contract is *Chrome-trace compatible*, which is what the
exit criterion tests (D70). Thread ids are real: a worker's events carry its thread id, so one file
shows main and worker turns on separate lanes.

Three costs are designed in rather than discovered later:

- **Off is the default and it is one branch.** The observer is an `Option<&TraceWriter>` threaded
  from `Isolate` into the driver and bridge; every event site is `if let Some(trace) = &self.trace`.
  WP4 measures `test/bench/run.js` before and after and the delta must be inside run-to-run noise
  (the harness already reports medians of five).
- **Bounded buffer.** Events are buffered and flushed in chunks up to a fixed budget (4 MB default,
  `--trace-buffer-mb`); when it is exhausted the writer flushes and counts drops, so a traced server
  cannot run itself out of the memory limit it just set.
- **No `ln-sched` dependency on the runtime.** The driver gains a small observer trait
  (`fn turn_started(&self, now: Instant)`, `fn phase(&self, phase: Phase, dur: Duration)`) with a
  no-op implementation; `ln-sched` still knows nothing about the engine, the clock source, or JSON.

The phase names come from `ln-sched`'s own turn order — timers, completions, immediates, block —
which is the sequence a reader of [ADR-0003](adr/0003-event-loop.md) already has in their head.

**Rejected:** instrumenting every host function (`host.set("fsRead", …)`) individually — ~70
closures in `host/mod.rs` and `host/*.rs`, all tiny, and the bridge already has the names and the
batching; a `--cpu-prof` that samples (no engine support, and an interrupted QuickJS interpreter
state is not walkable without a patch).

### 3.5 `node:test` is a runner and a reporter, not a corpus migration

[compat.md](compat.md) says the runner would power "our own conformance corpus". That is 238
recorded cases across 20 suites, each with a `.expected` file and a Node-recorded baseline, and
migrating them is its own project with its own risk (the corpus is the only thing keeping the
scheduler honest). M7 ships the API and proves it on a pilot; the migration is M8 at the earliest.

Scope, deliberately small:

| Ships | Does not ship |
|---|---|
| `test`, `describe`, `it`, `before`, `after`, `beforeEach`, `afterEach` | `mock`, `snapshot`, `--experimental-test-coverage` |
| `t.test()` subtests, `t.diagnostic()`, `t.plan(n)`, `t.assert` (thin alias over `node:assert`) | watch mode, `--test-only`, `--test-name-pattern` |
| async tests (returned promise), callback tests (`(t, done)`), timeouts (`{timeout}` and per-test override) | reporters beyond the default; TAP output |
| `onde --test [FILES…]`, discovery of `*.test.js` and `test/**/*.js`, exit code 1 on failure | running the existing conformance corpus |

The pilot (`test/node-test/`) runs five real conformance cases through the same file under
`node --test` and `onde --test`, and CI asserts the two transcripts match. That is the whole point
of the API: if the same file cannot run on both, the module is a lookalike and not worth having.

`node:test` becomes a builtin (`crates/ln-modules/src/builtin.rs`) and a `compat.md` row moves from
🟡 to ✅ with the subset spelled out.

**Rejected:** a TAP reporter (nothing in this repo consumes TAP; the default reporter is what our
own pilots use), and `--test` re-implemented in Rust (the runner is JavaScript inside the runtime
it tests, which is also how Node does it; a Rust runner would need its own copy of the hooks).

### 3.6 The 0.18 upgrade and dynamic `import()` go to M8

`import()` at runtime needs quickjs-ng 0.18's dynamic-import API, which needs an rquickjs that
binds it, which means re-vendoring the crate and rebasing
`vendor/job-queue-hook.patch` ([m6-plan §10.1](m6-plan.md#101-why-0170-and-not-0180) explains why
0.18.0 was not taken in M6). That is a two-to-five day job with a real chance of touching the
patch, and it invalidates every payload and snapshot produced before it.

Putting it in M7 would mean re-stamping the snapshot twice and landing the milestone's headline
work on top of an engine that is about to move. It is also not a performance item: it is the last
missing piece of the v1.0 module criterion, and M8 is the compatibility milestone, whose first
criterion is exactly that list.

**Cost of deferral:** none relative to today — dynamic `import()` already fails, and it keeps
failing until M8. WP1 spends two days confirming the rebase is mechanical (apply the patch to
0.18's sources, run the engine tests) so M8 starts with a known quantity instead of a spike.

**To revisit if:** M8's compat sweep starts and the rebase turns out to need engine changes, in
which case the work moves to M7.5 as its own milestone rather than being smuggled into a
performance milestone.

### 3.7 The fast paths are chosen by measurement, except one

Two of the roadmap's fast-path ideas are already facts of the tree, and the plan should not
re-implement them:

- "**op dispatch table instead of name lookup**" — `host` is an object of named functions
  (`host.fsRead`, `host.memoryUsage`, …), so there is no name lookup to remove. The cost per call is
  argument conversion across the rquickjs boundary and the allocation of the result value. The WP is
  "remove allocations from the hot ops", which is measurable and much smaller.
- "**cached atoms**" — atoms are interned by the engine on first use; the win would be in the
  stdlib's own string keys, which the minifier already shortens.

What is left, in priority order, and what gates each:

| Candidate | Gate | Why it is here |
|---|---|---|
| Lazy per-connection `http` session state | the half-open bound (67 MB → ≈ 31 MB, §6.1) | every accepted socket currently builds the JS session object before the first byte arrives; 2,000 idle connections pay 19 KB each for nothing ([m4-plan §8.3](m4-plan.md#83-harness-and-ci)) |
| One copy removed from `fs.readFile` | the 10 MB ratio, if it is outside 1.2x | D36's zero-copy external `ArrayBuffer` is a bigger change than M7 has room for; WP6 measures first and only takes the copy-free `read` path (`fs.read` into an existing buffer) if the ratio demands it |
| Async-hooks crossing cost | only if the 1M-promise loop regresses past 5% of its M6 baseline | [m6-plan §10.4](m6-plan.md#104-performance) measured the always-installed hook under 1% of that loop; M7's job is to keep it there, not to optimize it speculatively |
| HTTP throughput | the 1.5x ratio | the tail is queueing behind one isolate (§9, R9): allocation reduction buys single-digit percent, not 55%. This one is declared at risk rather than promised |

The plan keeps the roadmap's wording as the *theme* and replaces it with the four rows above as the
*work*, because a work package that says "fast paths" cannot be finished or refused.

## 4. Work packages

Twenty working days, in dependency order. Days are estimates for one engineer; the dependencies
are what actually orders them.

| WP | Work | Days | Depends on | Ends when |
|---|---|---|---:|---|
| WP0 | Measurement: ratios, cold-start protocol, soak, CI job | 1.5 | — | `./test/perf/run.sh` prints a ratio per criterion and a soak harness exists |
| WP1 | Engine: script bytecode, `JS_SetMemoryLimit`, heap stats, 0.18 spike | 3.0 | — | `cargo test -p ln-engine` covers compile/load/limit; the spike note is in this file |
| WP2 | Build-time bootstrap snapshot | 3.0 | WP1 | a release binary boots from bytecode; both paths produce identical corpus output |
| WP3 | Memory limits, worker limits, honest `memoryUsage` | 2.5 | WP1 | `--max-old-space-size=8` fails deterministically; a worker's limit is its own |
| WP4 | `--trace-events`, `--timing`, `--trace-gc` | 3.5 | WP0 | one trace file validates, `--timing` aggregates, off costs nothing measurable |
| WP5 | `node:test` onde | 3.0 | — | the pilot runs identically under `node --test` and `onde --test` |
| WP6 | Lazy session state, `fs.readFile`, async-hooks check | 2.5 | WP0 | the half-open bound is met; every other ratio is recorded |
| WP7 | Docs, divergences, outcome | 1.0 | all | roadmap, compat and this file updated; §12 written |

### 4.1 WP0 — the harnesses and the baseline

The milestone is judged on ratios, and three of the four have no harness that can produce one today
(the `fs` read, the TCP echo, and a gated HTTP-vs-Node comparison). WP0 builds them before anything
is optimized, so every later claim is an A/B and not a memory of a number.

**`test/perf/run.sh`** — the exit criteria in one command, reusing what exists:

| Workload | Harness | Criterion |
|---|---|---|
| cold start | `test/net/coldstart.js` | p50 ≤ 14 ms / ≤ 25 ms, plus the bound `http − eval ≤ 8 ms` |
| `fs.readFile` 10 MB | new `test/perf/fs-read.js`, both runtimes | ≤ 1.2x Node |
| TCP echo | new `test/perf/echo.sh` + `test/net/fixtures/echo-server.js`, both runtimes | ≤ 1.5x Node |
| HTTP keep-alive | the same, `ONDE_RELEASE=$(command -v node)` as denominator | ≤ 1.5x Node |

`bench.sh` already takes `ONDE_RELEASE` and prints a parseable `SUMMARY: rps=… p50=… p99=…`, and
[test/bench/run.js](../test/bench/run.js) already documents running the *same* server script under
Node as the denominator. So the HTTP/TCP ratios need a comparator, not new measurement machinery:
`test/perf/run.sh` runs each bench twice (both runtimes), parses the summaries, prints one
`RESULT workload=… node=… onde=… ratio=… verdict=…` line per row.

**The cold-start protocol.** `coldstart.js` gains a preamble it prints and records:
`lowpowermode` from `pmset -g` (macOS) or absent, load average, and the binary's stamp. It refuses
to *gate* when `lowpowermode 1` and `NET_BENCH_FORCE` is unset — a fair measurement on an unfair
machine is worse than a skip — and it measures `http − eval` as a second number, because that
difference is a property of the runtime (module compile) rather than of the machine's clock.

**`test/soak/run.sh`** — the 1 h RSS criterion: a hello server under the existing load generator for
an hour, RSS sampled every 10 s through `ps`, failing on a positive slope over the last 30 minutes.
The generator and the fixture already exist; this is a wrapper plus a slope check.

**CI** — a `perf` job that runs on the reference machine (nightly and on release-tagged PRs) with
hard thresholds, and on shared runners with `NET_BENCH_SOFT=1` so it reports instead of lying. The
distinction is the same one [m4-plan §8.3](m4-plan.md#83-harness-and-ci) already made for the
slow-loris bound, applied to all four numbers.

### 4.2 WP1 — the engine work

`compile.rs` gains a sibling to `module()`:

```rust
/// Compile a *global script* to bytecode. Same contract as `module()`, different eval type.
pub fn script(source: &str, options: &Options) -> Result<Vec<u8>, CaughtError>;
```

It is four lines of engine calls and all the care is in the error path: a script that fails to
compile must surface the same `CaughtError` shape `module()` does, with the source excerpt, because
the failure happens at *build* time now and a build error must read like a runtime error (that is
what `ondec`'s tests already assert for modules).

`Engine` gains the read side and the memory surface:

| Method | Purpose |
|---|---|
| `eval_script_bytecode(&self, bytes, name) -> Result<Completion, CaughtError>` | `JS_ReadObject` + `JS_EvalFunction`, with the stamp checked by the caller |
| `set_memory_limit(&self, bytes: u64)` | `JS_SetMemoryLimit` on this runtime, before or after boot |
| `heap_statistics(&self) -> HeapStatistics` | `JS_ComputeMemoryUsage` into the `JSMemoryUsage` fields `process.memoryUsage` and `--timing` need |
| `gc(&self)` | `JS_RunGC`, for the tests that assert a limit is enforced |
| `set_gc_threshold(&self, bytes: u64)` | `JS_SetGCThreshold`; used by the memory tests to force a collection point |

The 0.18 spike (two days of the three) is a separate note appended to §3.6, not code that ships.

### 4.3 WP2 — the snapshot

`crates/ln-runtime/build.rs` already produces `OUT_DIR/js/bootstrap.js` (minified, mangling off).
WP2 adds a second artifact next to it:

```
OUT_DIR/js/bootstrap.js          the minified source (still written; debug builds embed it)
OUT_DIR/js/bootstrap.bc         snapshot: header + JS_WriteObject bytecode
```

Compiling in `build.rs` means the build script links the engine, which is why the snapshot is a
`build-dependency` on `ln-engine` and not a runtime call: `build.rs` calls
`ln_engine::compile::script(&minified, &options)` and writes the bytes, so the engine that produces
the bytecode and the engine that reads it are the same vendored crate by construction (the stamp
check then only guards against a stale `OUT_DIR`, which is a caching bug and not a compatibility
one).

The header is 25 bytes and reuses the payload's discipline. It lives in
`crates/ln-payload/src/snapshot.rs`, not in `ln-runtime` as this plan first said: `build.rs` cannot
depend on the crate it builds, and both ends need the same encoder, so it sits beside the app
payload that has the same rules.

```
magic "ONDESNAP\0" (9) | format u16 (2) | flags u16 (2)
bc_version u8 (1) | endian u8 (1) | reserved u16 (2) | len u32 (4) | atom u32 (4)   = 25 bytes
```

(Exact layout in `crates/ln-runtime/src/snapshot.rs`; the point is that it is small, explicit and
checked before `JS_ReadObject`, which is the only rule that matters.)

Boot picks a path by profile:

| Build | Embedded | Path | Why |
|---|---|---|---|
| debug | source (+ bytecode if `ONDE_BOOTSTRAP=bytecode`) | `eval_global` | `cargo test` exercises the source path, which is the reference semantics |
| release | bytecode only | `eval_script_bytecode` | the snapshot exists to make release boots fast and the binary stays smaller than source+bytecode |

`ONDE_BOOTSTRAP=source` in a release build fails loudly ("this build has no bootstrap source"),
rather than silently falling back — a release that cannot boot is a build bug, and a hidden
fallback would make it a slow one. CI runs the conformance corpus against the release binary in the
`perf` job, which is the only place the bytecode path runs the whole corpus.

A/B proof (the WP's acceptance): `ONDE_BOOTSTRAP=bytecode` vs `source` in a *debug* build gives the
same output for `test/conformance/run.sh`; and cold start in a release build shows the saved
milliseconds, with the number recorded in §12.

### 4.4 WP3 — limits and memory reporting

`Config` gains `max_old_space_size: Option<u64>` and `worker_limits: Option<WorkerLimits>`; the CLI
gains `--max-old-space-size`; `workers.rs` translates `resourceLimits.maxOldGenerationSizeMb` into
the worker runtime's limit before `install()`. `host/mod.rs`'s `memoryUsage` swaps its
engine-sample-for-every-field for real RSS plus the engine's `JSMemoryUsage`.

Tests are the interesting part, because a memory limit is only real if the failure is:

- `crates/ln-engine/tests/memory.rs`: allocating in a loop under a 4 MB limit fails with the
  documented error rather than aborting the process; a limit set after boot still applies.
- `ln-runtime` integration: `onde --max-old-space-size=8 big.js` exits 1 with one line naming the
  limit; `--max-old-space-size=2000` boots.
- workers: a worker with `resourceLimits.maxOldGenerationSizeMb: 4` dies with its limit while the
  parent's 64 MB budget is untouched, and the parent gets `error` then `exit`.
- `process.memoryUsage().rss` is greater than `heapUsed` and within 10% of `ps -o rss=` for the same
  process (the tolerance is for sampling time, not accuracy).
- debug builds: teardown asserts `live_handles`, `live_children`, `live_workers` and queued jobs are
  all zero after a script that opens and closes a file, a socket, a child and a worker — the audit
  the roadmap asked for, built on the counters M4 and M5 already keep.

### 4.5 WP4 — diagnostics

`crates/ln-runtime/src/trace.rs` owns the writer and the event vocabulary, and the hooks sit in
`Isolate::run_loop`, which already has both the phase (`ln_sched::Turn`) and the wall time; no
observer trait was added to `ln-sched`, because that crate deliberately has no clock and the plan's
own rule is not to teach it one. `crates/ln-runtime/src/ops.rs` wraps the two submission points with begin/end
(`OpBridge::submit` for `ln_io::Op`, the handle-command path for `ln_io::Command`). The JSON
is written by hand (`serde_json` is already a dependency and is not needed for a writer this
small — but it is used for the *test* that validates the file).

Acceptance: `test/diag/run.sh` runs a script that touches timers, a promise, an `fs` read and an
`http` request with `--trace-events`, then asserts (in Node, against the file) that: it parses, it
has `metadata` first and `exit` last, every `turn` nests its `phase`s, every `op` is closed, and no
duration is negative. `--timing` prints one line per `Command` variant that ran and no line for
variants that did not. `--trace-gc` on a script that allocates then drops produces at least one `gc`
event and none on a script that allocates nothing.

### 4.6 WP5 — `node:test`

`js/lib/test.js` is the module; the runner lives in the same file and is entered from
`onde --test` through a host call that hands it the discovered paths (`Isolate` already passes
`process.argv`; discovery is `ln-cli`'s job because it is argument parsing). Reporter output is the
spec-ish nesting Node prints (`▶`, `✔`, `✖`, one line per test, a summary), because a divergent
format is a cost with no benefit.

The pilot: five conformance cases rewritten as `node:test` files under `test/node-test/`, run by CI
twice — `node --test` and `onde --test` — and compared. That comparison is the compatibility
criterion for the module, and it is also the seed for the M8 corpus migration if that is ever taken.

### 4.7 WP6 — the fast paths

Gated by WP0's numbers and by §3.7's table. The only guaranteed item is lazy per-connection session
state, because the half-open bound is an M4 exit criterion that M4 explicitly handed to M7.

**Measurement first, and it moved the target.** At 2,000 half-open connections the cost was not the
JS session: `ln-io` sized every connection's scratch buffer to the consumer's request (64 KiB for a
flowing `net` socket, 16 KiB for the HTTP parser), so an idle socket held 64 KiB of resident memory.
That is 128 MiB at 2,000 connections, and it made the raw-TCP "floor" larger than the HTTP server —
the floor and the thing it was supposed to measure had swapped places. The fix landed first: every
connection starts at 1 KiB and grows to the requested size only after two full reads, which is the
signal that a stream is actually being consumed (`crates/ln-io/src/net/connection.rs`). Measured at
2,000: raw 156 → ~42 MB, HTTP 66 → ~46 MB. The remaining difference is the per-connection session,
which is what the lazy change below is for.

The change is in `js/lib/http.js`: `connection` currently creates the request/response session
(state object, parser buffers, async-hooks resource) when the socket is accepted; it must create
the socket-level object only, and the session when the first byte arrives or the first write
happens. The Rust side already supports it (the codec holds the parse state and `Conn` is created
per connection), so this is a JavaScript-side ownership change plus the tests that make sure a
half-open socket still gets `'close'` and still counts against the connection limit.

### 4.8 WP7 — closing the milestone

`compat.md` rows for `node:test`, `v8`'s `--max-old-space-size`, D21, D53, plus the new D67–D72;
`roadmap.md`'s M7 section gets its outcome line; this file gets §12 with the measured numbers and
the deviations. The rule from the earlier plans holds: deviations are recorded with the number
that forced them, not described as intended.

## 5. Harnesses and CI

| Harness | Gates | Runs |
|---|---|---|
| `./test/perf/run.sh` | the four ratios and the cold-start pair | nightly + release PRs on the reference machine (hard); every PR soft |
| `./test/net/bench.sh`, `test/net/coldstart.js`, `test/net/slowloris.sh` | their existing criteria, now with the protocol preamble | unchanged, plus `NET_BENCH_FORCE` |
| `./test/soak/run.sh` | RSS slope over 1 h | nightly only (it is an hour) |
| `./test/diag/run.sh` | trace JSON structure, `--timing` output, `--trace-gc` events | every PR (cheap) |
| `./test/node-test/run.sh` | the pilot runs under both runners | every PR |
| `./test/conformance/run.sh` against a release binary | the bytecode bootstrap path | every PR in the `perf` job; also the debug/source path in the normal `test` job |

Two CI jobs are added: `perf` (release build, corpus on the snapshot path, the ratios, soft on
shared runners) and `nightly` (soak plus the hard thresholds on the reference machine). The
existing `test` job is untouched, so a broken snapshot cannot take the functional suite down with
it.

## 6. Exit criteria, and the one that has to be re-specified

| # | Criterion | Command | Verdict |
|---|---|---|---|
| 1 | Cold start: p50 ≤ 14 ms (`-e`), ≤ 25 ms (`require("http")`), and `http − eval ≤ 8 ms` | `test/perf/run.sh` | hard on the reference machine, soft elsewhere |
| 2 | `fs.readFile` 10 MB within 1.2x of Node | `test/perf/run.sh` | hard |
| 3 | TCP echo within 1.5x of Node | `test/perf/run.sh` | hard |
| 4 | HTTP keep-alive within 1.5x of Node | `test/perf/run.sh` | **at risk** (§9, R9): the number is published either way |
| 5 | 2,000 half-open connections: RSS within 2 MB of the raw-TCP floor (§6.1) | `test/net/slowloris.sh` | hard on the reference machine, soft elsewhere |
| 6 | RSS, hello server < 25 MB, no growth over 1 h | `test/soak/run.sh` | hard nightly |
| 7 | `--trace-events` output loads in `chrome://tracing` | `test/diag/run.sh` | hard structural, one manual check at close |
| 8 | The `node:test` pilot produces the same transcript under `node --test` and `onde --test` | `test/node-test/run.sh` | hard |
| 9 | The bytecode bootstrap produces the same output as the source bootstrap across the corpus | `./test/conformance/run.sh` against a release binary | hard |
| 10 | Binary size ≤ 6.0 MB (was 5.4 MB) | `test/perf/run.sh` | hard; the snapshot is allowed +600 KB, and §12 records the actual |
| 11 | Stdlib consolidation checklist | `test/js/run.sh`, `scripts/check-duplication.mjs` | already green at plan time; kept as a regression gate |

### 6.1 The half-open bound cannot be 25 MB, and the plan says so instead of trying

[m4-plan §8.3](m4-plan.md#83-harness-and-ci) recorded two facts that do not fit together: 2,000
half-open HTTP connections hold **67.0 MB**, and the *measured floor* in the same build —
2,000 idle **raw TCP** connections with no HTTP layer at all — is **29 MB** (11.5 KB each). M4's
exit criterion allows 25 MB.

So the bound M4 handed to M7 is below the floor. No amount of JavaScript work reaches it: a connection
that carries no request has already paid for its socket, its kernel buffers and its `Conn`, and
that is 11.5 KB. The JS session state is the *difference* — 67 − 29 = 38 MB, or ~19 KB per
connection — and that difference is what M7 can remove.

The plan therefore re-specifies criterion 5 as: **RSS at 2,000 half-open connections within 2 MB of
the raw-TCP floor on the same build and machine**, with the floor re-measured in the same run.
The 29 MB figure was measured ad hoc for [m4-plan §8.3](m4-plan.md#83-harness-and-ci); WP0 turns it
into a `--raw` mode of `slowloris.sh` so the two numbers always come from one binary and one
machine.

The expected end state is ~29–31 MB, and the criterion still fails M4's stated bound, which is
why it is listed in §11 as a decision for the milestone owner rather than quietly rewritten.

The same reasoning applies to the 10 k-connection variant (currently 311 MB): it is the floor plus
the per-connection cost, and both scale.

## 7. Divergences to record

Six new rows, D67–D72, in [compat.md](compat.md). Each cites the test that pins it.

| ID | Divergence | Rationale | Pinned by |
|---|---|---|---|
| D67 | `--max-old-space-size=N` maps to one engine-wide limit; `--max-semi-space-size` and `--min-semi-space-size` are accepted and ignored | QuickJS has one heap and one generation; a split cannot be synthesized without an allocator of our own | `crates/ln-engine/tests/memory.rs` |
| D68 | Exceeding the limit raises an uncatchable `InternalError: out of memory` and exits 1; a worker's limit kills only that worker, whose parent sees `error` then `exit` | Node throws `ERR_MEMORY_LIMIT_EXCEEDED`, which a caller can catch; a fatal engine OOM unwinds nothing and cannot be delivered to a listener | `test/proc/run.sh` (worker limits), `crates/ln-runtime/tests/memory.rs` |
| D69 | `--trace-gc` is sampled at turn boundaries: a collection that happens inside a turn is attributed to that turn's start, and a turn that collects twice reports once | `JS_ComputeMemoryUsage` is the only heap read the engine offers; there is no GC callback in quickjs-ng | `test/diag/run.sh` |
| D70 | `--trace-events` emits our event vocabulary (`turn`/`phase`/`op`/`gc`), Chrome-trace compatible, not Node's inspector event names | Node's format is tied to `inspector`; the tool that consumes traces is Chrome, and it only needs `ph`/`ts`/`dur`/`name` | `test/diag/run.sh` |
| D71 | `node:test` is a subset (§3.5): no mocks, snapshots, coverage, watch, `--test-only`, extra reporters | those APIs have no consumer here, and each one is a compatibility promise with no test behind it | `test/node-test/run.sh` |
| D72 | Release builds embed the bootstrap as bytecode only; `ONDE_BOOTSTRAP=source` in a release build is an error | a release that cannot boot its own bootstrap is a build bug; a silent fallback would hide it and pay the parse cost anyway | `crates/ln-runtime/tests/snapshot.rs` |

D21 and D53 are narrowed rather than closed: D21 goes from "all five `memoryUsage` fields are the
engine heap" to "`rss` is the OS, `heapTotal`/`heapUsed` are the engine, `external`/`arrayBuffers`
are 0"; D53 loses "no per-worker memory cap" and keeps the other four items.

## 8. What the numbers are expected to do

An estimate is not a result, so this table is what the plan *expects*, with the measurement that
will replace it. The half-open row is a promise; the rest are forecasts that §12 records either
way, including the ones that come out wrong.

| Change | Expected | Basis | Measured in |
|---|---|---|---|
| Bootstrap from bytecode | −3 to −7 ms on every start | 557 KB of minified JS is parsed and compiled on every boot today; the whole `-e` start is 12.2 ms, and the script is the largest fixed cost in it. The range is wide because the minifier's output compiles faster than source of the same size | WP2, `ONDE_BOOTSTRAP=bytecode` vs `source` |
| `require("http")` | −1 to −3 ms on top of the above | the delta today is 6.8 ms, and it is module compile, not I/O setup; the snapshot does not help here (the modules stay source) | WP2 |
| Lazy session state | 67 MB → ~30 MB at 2,000 half-open | removing ~19 KB of JS state per connection from a 29 MB floor | WP6, `slowloris.sh` paired |
| `fs.readFile` 10 MB | within 1.2x, else one copy removed | D36: the host copies the op's bytes into a `Uint8Array`; at 10 MB that copy is a measurable share of the call | WP6, `test/perf/fs-read.js` |
| HTTP throughput | +5–15%, 1.5x not promised | the tail is one isolate queueing 100 connections, not allocation; [m4-plan §8.4](m4-plan.md#84-performance-fixes-landed-while-closing-m4) already attributes the ceiling to JS execution | WP6, `bench.sh` both runtimes |
| `--trace-events` off | ≤ 1% of a compute-bound run | one `Option` check per event site, no clock reads when off | WP4, `test/bench/run.js` |
| Memory limit checks | one `JS_SetMemoryLimit` call per runtime | it is a field, not a hook | WP3 |

The one number the plan refuses to forecast is the HTTP ratio. Predicting 1.5x and missing it would
make the milestone look like a failure of execution when it is a property of the architecture (one
isolate, one thread, 100 connections); publishing 1.4x and the reason is the honest outcome.

## 9. Risks

| ID | Risk | Impact | Mitigation | Trigger to act |
|---|---|---|---|---|
| R7 | Numbers move with the machine, not the code — `lowpowermode 1` alone accounts for the 19.1/30.8 ms reading against 12.2/19.0 ms on AC | a red build that means nothing, or a green one that hides a regression | the protocol preamble (mode, load), the reference runner, and the `http − eval` delta as a machine-independent second number | two consecutive runs that disagree by more than 15% |
| R8 | The snapshot saves less than 2 ms | WP2 spends three days for a rounding error | the stop-loss in §3.2: keep the source path and withdraw the criterion | A/B delta < 2 ms |
| R9 | HTTP 1.5x is unreachable in one isolate | criterion 4 fails | declare the number, record the cause, and move the structural fix (a second isolate or a work-stealing queue) to 1.1 with the measurement attached | the ratio is under 1.3x after WP6 |
| R10 | `node:test` scope creep (the corpus migration is the obvious next ask) | WP5 eats the milestone | the §3.5 table is the scope; the corpus stays on `.expected` files | a request to convert a conformance suite |
| R11 | Deferring 0.18 leaves `import()` missing at 1.0 | a v1.0 criterion fails at the wrong milestone | two-day spike in WP1 sizes the rebase; M8 is scheduled with it first | the spike finds engine-side changes, not just binding ones |
| R12 | `build.rs` links the engine: clean-build time grows, and a cross-compiled SDK cell would embed host-endian bytecode | a slow first build, or an SDK that cannot read its own snapshot | `Options.endian` from `CARGO_CFG_TARGET_ENDIAN`; refuse the snapshot on 32-bit targets ([ondec](../crates/ondec/src/target.rs) already refuses them for payloads); native builds only in M7, cross cells take the source path until measured | a clean build exceeds 5 minutes, or a cross build is attempted |

## 10. File map

```
crates/ln-engine/src/compile.rs            + compile::script()                     WP1
crates/ln-engine/src/lib.rs                + eval_script_bytecode, set_memory_limit,
                                             heap_statistics, gc, set_gc_threshold WP1
crates/ln-engine/src/ffi.rs                + JS_Eval/JS_EvalFunction/JS_ReadObject      WP1
crates/ln-engine/tests/bytecode.rs         + script round-trip, wrong-stamp refusal    WP1
crates/ln-engine/tests/memory.rs           new: limit, OOM shape, after-boot limit     WP3
crates/ln-runtime/build.rs                 + compile the minified bootstrap to bytecode WP2
crates/ln-runtime/src/snapshot.rs          new: 25-byte header, validate, load          WP2
crates/ln-runtime/src/lib.rs               boot picks bytecode or source; Config fields WP2 WP3
crates/ln-runtime/src/workers.rs           resourceLimits → per-worker limit            WP3
crates/ln-runtime/src/host/mod.rs          memoryUsage: real rss, engine heap fields    WP3
crates/ln-runtime/src/trace.rs             new: writer, event vocabulary, budget        WP4
crates/ln-runtime/src/ops.rs               op begin/end on submit and commands          WP4
crates/ln-sched/src/driver.rs              + PhaseObserver (turn/phase callbacks)       WP4
crates/ln-cli/src/main.rs                  + --max-old-space-size, --trace-events,
                                             --trace-gc, --timing, --test               WP3 WP4 WP5
crates/ln-modules/src/builtin.rs           + "test"                                     WP5
js/lib/test.js                             new: test/describe/it/hooks/runner           WP5
js/lib/http.js                             lazy per-connection session                  WP6
test/perf/run.sh                           new: the four ratios + size                  WP0
test/perf/fs-read.js                       new: 10 MB read harness                      WP0
test/perf/echo.sh                          new: TCP echo, both runtimes                 WP0
test/net/fixtures/echo-server.js           new: the echo server both runtimes run       WP0
test/net/coldstart.js                      + machine preamble, http − eval delta        WP0
test/net/slowloris.sh                      + paired raw-TCP floor                       WP0
test/soak/run.sh                           new: 1 h RSS slope                           WP0
test/diag/run.sh                           new: trace structure, timing, gc             WP4
test/node-test/{run.sh,*.test.js}          new: the pilot                               WP5
.github/workflows/ci.yml                   + perf, nightly                              WP0
docs/compat.md                             + D67–D72; D21/D53 narrowed                  WP7
docs/roadmap.md                            M7 outcome line                              WP7
```

## 11. Decisions that need a second opinion

These are the four calls where this plan picks one option and a reader might reasonably pick
another. They are listed so the milestone owner can overrule them before WP0 starts, not after.

1. **The half-open criterion is re-specified (§6.1).** M4's exit criterion says 25 MB; the measured
   raw-TCP floor is 29 MB. Either the criterion becomes "within 2 MB of the floor" (this plan), or
   the target becomes a different connection count where 25 MB is reachable (roughly 1,600), or the
   bound moves to 32 MB at 2,000. The plan's choice keeps the stress level and changes the number;
   the alternative keeps the number and lowers the stress.
2. **HTTP 1.5x stays a promised criterion but the plan expects 1.3–1.45x (§8, R9).** The
   alternative is to move criterion 4 to 1.1 today and let M7 report the number without gating on
   it. Which is right depends on whether M7 is allowed to close with a known miss.
3. **Release embeds bytecode only, with no source fallback (D72).** The alternative — embed both,
   +550 KB — makes a corrupt snapshot a slow boot instead of a hard error, and keeps the source path
   runnable in release. The plan chooses the smaller binary and a loud failure.
4. **0.18 and dynamic `import()` are M8 (§3.6).** v1.0 criterion 1 lists dynamic `import()`, so this
   defers a release criterion to the hardening milestone. The alternative is a M7.5 with the rebase
   and no performance work, which is cleaner but adds a milestone.

Two smaller ones: the flag is spelled `--timing` rather than the roadmap's `--cpu-prof-onde`
(it is not a profiler, and a name that lies is worse than a new name), and worker OOM kills the
worker rather than the process (D68) — the opposite choice is defensible and cheaper to implement.

## 12. Outcome (2026-11-24)

WP0–WP5 and most of WP6 landed. Five of the six numeric criteria are met; the sixth is the one this
plan predicted would miss, and the half-open delta is still open (both are recorded below, not
papered over). Measured on the reference machine with `lowpowermode` off, release build, Node
26.12.1, 2026-11-24 (load average printed with every number — it was 7, so the ratios are honest and
the absolutes are slightly pessimistic).

| # | Criterion (§6) | Measured | Verdict |
|---|---|---|---|
| 1 | Cold start p50 ≤ 14 ms / ≤ 25 ms, `http − eval` ≤ 8 ms | 11.6–12.3 ms / 18.4–18.8 ms; delta 6.4–6.9 ms across two runs | met |
| 2 | `fs.readFile` 10 MB ≤ 1.2x Node | 1.17x (1.63 vs 1.39 ms) | met, at the edge |
| 3 | TCP echo ≥ 0.667 of Node | 0.96x (41.8k vs 43.7k req/s) | met |
| 4 | HTTP keep-alive ≥ 0.667 of Node | 0.45x (13.2k vs 29.5k req/s) | **missed**, as predicted (§9 R9) |
| 5 | 2,000 half-open: within 2 MB of the raw floor | HTTP 47.7 MB against a 44.6 MB floor: **3.0–3.2 MB** over three paired runs (6 MB before lazy sessions) | **missed**; the residual 1.5 KB/connection is bookkeeping correctness needs (§12.3) |
| 6 | Hello-server RSS < 25 MB, no growth over 1 h | peak 7.98 MB, slope **0.27 MB/h** over a 10-minute run (61 samples) | met on the shorter run; the 1 h run is the nightly job |
| 7 | Trace loads in `chrome://tracing` | 43 events, 1 lane, ops + gc, validated structurally | met (§12.2) |
| 8 | Pilot identical under `node --test` and `onde --test` | 5 files / 24 tests, transcripts match | met |
| 9 | Bytecode bootstrap matches source across the corpus | 235/235 both paths, identical output | met |
| 10 | Binary ≤ 6.0 MB | 5.53 MB, of which the snapshot is 42 KB replacing 15 KB of source (+27 KB) | met |

Tested state: `cargo test --all`, `./test/conformance/run.sh` 238/0, `./test/js/run.sh` 83/0,
`./test/proc/run.sh` 12/0, `./test/node-test/run.sh` (pilot matches), `./test/diag/run.sh` (trace,
timing, gc), `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`.

### 12.1 Where the implementation disagreed with the plan

- **The snapshot is smaller than the plan assumed, and the stop-loss fired on a false premise.**
  §3.2 sized the win from "557 KB of minified JS"; that is the whole `js/` tree. `bootstrap.js`
  alone is **14.7 KB**, so A/B is 12.6/12.2 ms of source against 11.7/11.7 ms of bytecode: **0.5–0.9
  ms, ~7%**, under the 2 ms stop-loss. It was kept rather than withdrawn because the machinery is
  what a module snapshot in M8 reuses, the binary only grows by ~27 KB (42,003 bytes of blob for
  14,701 bytes of source), and the alternative is re-deriving the loader later. The bigger lever is
  visible in the same numbers: `require("http")` costs 6.4 ms on top, which is *module* parse, and
  §3.2 deliberately left it alone.
- **The snapshot format lives in `ln-payload`, not `ln-runtime`.** A build script cannot depend on
  the crate it builds, and both the writer (`build.rs`) and the reader (the runtime) need the same
  encoder, so `ln_payload::snapshot` sits beside the app payload whose rules it shares.
- **`Options.endian` is advisory.** quickjs-ng 0.17 defines `JS_WRITE_OBJ_BSWAP` as 0 ("handled
  transparently"), so bytecode is always the producer's native order; the envelope records it and
  the loader refuses a mismatch instead of converting. A cross-built snapshot has no path until a
  target-side compiler is part of the build.
- **The diagnostics hooks are in `Isolate::run_loop`, not an `ln-sched` observer trait.** The loop
  already has both the phase (`Turn`) and the wall time; teaching the scheduler crate about a clock
  would have been the plan's own rule broken for symmetry.
- **`grep` found the APIs already there.** rquickjs 0.14's safe `Runtime` API exposes
  `set_memory_limit`, `set_gc_threshold`, `run_gc` and `memory_usage`, so WP1 added no `unsafe` and
  no hand-written FFI; the plan's "FFI escape hatch" row was wrong about the wrapper.
- **`--trace-gc` samples `malloc_size`.** The accounted-object size omits fast-array storage: 40 MB
  of numeric arrays did not move it, so a tracker built on it would never report a collection.

### 12.2 Diagnostics, as shipped

`--trace-events FILE` writes one Chrome-trace array: `process_name`, one `turn` event per loop turn
named for the phase (`timer`, `completion`, `immediate`, `wait`, `beforeExit`, `exit`), one `op`
event per `ln_io::Op` measured from submission to delivery, and `gc` instants with `before`/`after`
bytes. `--timing` prints the same data aggregated per name. A test (`test/diag/run.sh`) asserts the
structure on every PR, and the workload is shaped so a collection is observable across a turn
boundary (D69).

### 12.3 The half-open delta: root cause was not the one M4 assumed

The plan inherited "per-connection JS session state dominates the slow-loris footprint". Measurement
said otherwise: `ln-io` sized every connection's scratch buffer to the consumer's request — 64 KiB
for a flowing `net` socket, 16 KiB for the HTTP parser — so an idle socket held the full chunk, and
the *raw* baseline was larger than the HTTP case it was supposed to floor (156 MB against 66 MB at
2,000 connections). Two changes landed:

- **Read buffers start at 1 KiB and grow after two full reads** (`crates/ln-io/src/net/connection.rs`).
  A half-open peer never fills a chunk, so it never grows; a stream being consumed does, and pays
  two small reads at connection start. Raw 156 → 41 MB, HTTP 66 → 47 MB at 2,000.
- **A 50 ms drain before closing after a canned error.** The smaller buffer exposed a latent RST:
  closing a socket with unread bytes makes the kernel reset, so a peer that had written a 20 KB head
  lost the 431 response. The probe caught it; `test/net/slowloris.sh` still asserts it.

The remaining 6 MB was the *JS* session, which the codec-only experiment isolated exactly: attaching
the codec and nothing else measured the raw floor (41 MB), so the delta was `new ServerSession` plus
its two socket listeners and its `headersTimeout` timer — 3 KB per connection, not the ~19 KB M4 had
assumed. §4.7's lazy creation then landed: the codec attaches immediately (it owns the parse), and
the session, its listeners and its timer are created inside the handle-event callback on the first
event (`js/lib/internal/http.js`). Cleanup happens on the `closed` handle event rather than through
a socket listener, so a connection that never carried a byte costs one listener entry.

Result at 2,000 connections: 47 MB → **47.7 MB**, against a raw floor of 44.6 MB (both absolutes
carry this machine's 8–9 MB baseline; the delta is the comparable number). Paired runs with the
hardened harness (`test/perf/halfopen.sh`: median of seven samples, and a run that opens fewer
connections than asked is now rejected rather than compared) report **3.0, 3.2 and 3.2 MB**.

The last megabyte is what the lazy design cannot remove, and one piece of it is provably required:
dropping the eager `socket.on("error")` listener turned five HTTPS conformance cases from `exit:0`
into `exit:1`, because a TLS teardown error (`EIO`) reached `uncaughtException` before any request
existed. What remains per connection is that listener, the `closed`-event cleanup closure, the
handle-listener set entry, and the `_sockets` entry the `close*Connections()` helpers need. Against
a 2 MB bound, 3 MB is reported as missed, with the composition of the 1.5 KB written down rather
than a bound quietly relaxed.

The D73 semantics follow from the design and are recorded: the session and its per-request timers
are created on the first parsed event, `headersTimeout` stays a deadline taken at accept (held as a
number on the socket and swept by one server timer), and `getConnections()`/`close*Connections()`
count sockets rather than sessions.

### 12.4 What did not ship

| Item | Where it went |
|---|---|
| Module-level bytecode snapshots (§3.2) | M8; the bootstrap measurement says the module parse is the larger cost (6.4 ms for `http`) |
| rquickjs 0.18 and dynamic `import()` (§3.6) | M8, with the two-day rebase spike not run: the spike was WP1's, and WP1 spent its budget on the engine surface instead |
| Zero-copy `fs.readFile` (D36) | 1.1; the extra `Vec` clone was removed and the ratio is 1.17x, so the remaining copy is the op's payload into the engine buffer |
| D37, D38, WebCrypto `subtle` | 1.1 |
| Soak's 1 h run | 10 minutes measured here (0.27 MB/h, 61 samples); the 1 h run stays in the nightly job |
| `--timestamp`-style filters beyond the three flags | not in the plan's scope |

### 12.5 Two bugs found on the way, both older than M7

- **`setImmediate` from a promise continuation could be lost.** With immediates queued inside the
  same turn that had already snapshotted them, `Driver::next` returned `Wait` while immediates were
  pending; the callback fired only if an unrelated timer woke the loop. A `node:test` runner that
  awaits one test and schedules the next is exactly that shape (WP5, regression test in
  `crates/ln-sched`).
- **`clientError` after the drain.** Emitting the event after the 50 ms drain put it behind the
  peer's already-received response and broke three assertions in `test/js/lib/http.test.js`; the
  event now precedes the drain, which is about the socket, not the event.

### 12.6 Review findings (after the first commit)

A lifecycle review of the lazy session ran against the landed change and found one blocker and two
important defects, all fixed in a follow-up commit:

- **Critical: the first request head lost its bound.** The session was created on the first *parsed*
  event, and that event only exists once the head is complete; `ensureSession` armed the
  `headersTimeout` timer and `onServerRequest` cleared it in the same dispatch, so a peer that sent
  a partial head was held forever instead of for the configured timeout. The record claimed
  "starts at the first byte", which was also wrong. Fixed by keeping the deadline as a number on
  the socket, taken at accept, and sweeping them with one timer per server — a per-connection timer
  would have cost ~1.2 KiB back and the sweep costs one number. `d74-first-head-timeout.js` pins it,
  and D74 records that Node does *not* reclaim this peer (measured) — onde is stricter on purpose.
- **Important: `server.timeout` was a no-op for a sessionless socket.** The callback ran
  `if (session !== null) session.destroy()`, so `'timeout'` fired and nothing was closed. It now
  destroys the socket, and `"closed"` cleans up as for any other connection.
- **Important: the read-buffer clamp thrashed on paced streams.** `read_chunks` reset on every
  partial read, but a partial read is the normal case for a consumer slower than the requested
  chunk: a 1 MiB stream at 8 KiB/5 ms produced 384 one-to-six-KiB reads instead of the ~128 that
  Node's chunking produces. The counter is now monotonic — a socket that has proved it delivers
  keeps the larger buffer — and the same stream reads 130 events of 8 KiB, matching Node.

The review's minor items were fixed in the same follow-up: the write-only `_sessions` set is gone
(every reader walks sockets now), the sweep is re-armed at `close()` instead of being cancelled,
arming is O(1) on accept rather than rescanning every socket per accept, the close helpers snapshot
the set they iterate, and `attachServerSocket` no longer returns a session handle that is always
`null`. `d75-server-bookkeeping.js` pins the drain and the post-close reclaim.

### 12.7 The one-page summary

M7's headline claim — "a bytecode snapshot closes the startup gap" — turned out to be worth ~0.7 ms
of a 12 ms start, because the gap was never the bootstrap. What actually moved memory was a 64 KiB
allocation per idle socket and, after that, a per-connection session object nobody needed yet —
together 156 MB → 44 MB at 2,000 half-open connections. The trace says where the remaining time
goes (`wait` and `completion` dominate an I/O program; `timer` and `op` are microseconds), and the
one criterion that remains missed is the HTTP ceiling, which is an architecture item for 1.1 rather
than a surprise.
