# onde roadmap

Goal: a Node-shaped runtime on quickjs-ng, in Rust, that is **small, sub-15 ms cold-start, and
semantically honest** about the parts of Node it claims to support.

This document is the plan of record. Milestones are ordered by dependency, not by excitement.
Each has a verifiable exit criterion; "done" means the criterion is green in CI, not that the
code exists.

---

## 0. Definition of v1.0

v1.0 ships when all of the following hold:

| # | Criterion |
|---|---|
| 1 | `lite script.js`, `lite -e`, `lite --eval`, ESM + CJS, TLA, dynamic `import()` |
| 2 | `process`, timers, `fs` (sync/cb/promises), `path`, `url`, `events`, `util`, `assert`, `buffer`, `os`, `string_decoder` |
| 3 | `net` + `http`/`https` (server and client), TLS via rustls, `dns.lookup` |
| 4 | `child_process` and `worker_threads` (incl. `SharedArrayBuffer` + `Atomics`) |
| 5 | `async_hooks` + `AsyncLocalStorage` correct across `await`, `.then`, timers, I/O |
| 6 | Cold start < 15 ms, RSS < 25 MB on a hello-world HTTP server |
| 7 | 600+ Node conformance tests green; zero known ordering divergences in the scheduler corpus |
| 8 | macOS + Linux x86_64/aarch64 first-class; Windows best-effort |
| 9 | Publishable binaries + install script; docs for every supported module |

Explicit non-goals for 1.0: N-API/native addons, `vm`, `cluster`, `inspector`,
`Intl` (beyond what we can afford), `WebAssembly`, `fetch` (candidate for 1.1).

---

## 1. Milestone map

| ID | Theme | Outcome | Effort (eng-weeks) | Depends on |
|---|---|---|---|---|
| M0 | Bootstrap | workspace, engine binding, `lite -e '1+1'` | 1.5 | — |
| M1 | **Scheduler & tick model** ★ | Node-compatible microtask/tick semantics, timers, loop | 3 | M0 |
| M2 | Modules + core stdlib | CJS/ESM, `process`, JS stdlib tier 0 | 4 | M1 |
| M3 | I/O core | op bridge, `fs`, Node errors, onde streams, `crypto` base | 5 | M2 |
| M4 | Network | `net`, `dns`, `http`/`https`, TLS | 6 | M3 |
| M5 | Processes & threads | `child_process`, `worker_threads`, shared memory | 4 | M3 |
| M6 | **Engine patch + async context** ★ | host-owned job queue, `async_hooks`, ALS everywhere | 4 | M1, M2 |
| M7 | Performance & diagnostics | bytecode snapshot, profiling, memory caps, async stacks | 4 | M4, M6 |
| M8 | 1.0 hardening | compat sweep, docs, packaging, release | 2.5 | all |
| M9 | Permissions model | deny-by-default `--allow-*` for fs/net/child_process/env, and the gate FFI uses | 1.5 | M8 |
| M10 | Native interop (FFI) | `onde:ffi`: `dlopen`, `libffi`, structs, callbacks, JSON codecs | 4 | M8, M9 |

Total for 1.0 ≈ **34 eng-weeks**. One engineer: ~8 months. Three engineers: ~4 months wall-clock
with the parallelization in §4. The 1.1 milestones, M9–M10, add ~5.5 eng-weeks after the release.

---

## M0 — Bootstrap and decisions (1.5 w)

**Status: complete on 2026-11-13.**

Shipped: `ln-engine` (rquickjs 0.14 + one-step job pump, no async runtime), `ln-runtime`
(JS bootstrap for `console`/`process`, scheduler-driven drain, uncaught-error renderer),
`ln-cli` (`lite`), plus 18 CLI end-to-end tests and 5 renderer unit tests. `cargo fmt`,
`cargo clippy -D warnings` and `cargo test --all` are green.

First numbers on this machine (release): 1.8 MB binary, ~13 ms per `lite` invocation
(20 runs, `-e '1+1'`). M7's target is < 15 ms with the HTTP stack imported, so the engine budget
is intact and the remaining startup cost is process + bootstrap, not parsing.

Deviations from the plan below, all deliberate:

- `console` and `process` are implemented in the JS bootstrap (moved to `js/bootstrap.js` in M2)
  on top of two host primitives (`__ln_write`, `__ln_exit`) rather than in Rust. This is the
  shape the architecture wants (Node surface in JS, syscalls in Rust) and it kept M0 small.
- `lite -e` printed the completion value with JavaScript `ToString`, so objects printed as
  `[object Object]` until `util.inspect` landed in M2 (now `util.inspect` is used for
  objects).
- `process.nextTick`, timers and unhandled-rejection reporting are explicitly M1. A microtask
  that throws is fatal in M0 (no `uncaughtException` dispatch yet), and an unhandled rejection
  is silently ignored rather than mis-reported.
- ESM is a syntax error; classic scripts only, as specified.
- `ln-cli` parses arguments with `clap` 4 (derive). The CLI is a delivery mechanism, not the
  product: argument parsing, help and usage errors are exactly the kind of edge-case-heavy code
  we should not be writing by hand while the runtime semantics are unfinished.
- `process.exit` unwinds with QuickJS's **uncatchable-error** bit on an `Error` object, so a
  script's `try { ... process.exit() } catch` cannot observe the exit as a failure and `finally`
  blocks do not run, matching Node. M0–M4 used a catchable string sentinel; M5 replaced it once
  the engine bit was confirmed (`test/conformance/loop/l10-exit-uncatchable`). The engine interrupt
  is used for the `--microtask-timeout` budget, not for `process.exit`.

**Build**

- Cargo workspace with the crate graph from [architecture.md](architecture.md).
- `ln-engine` on `rquickjs` 0.14 (which tracks quickjs-ng) with a **hand-rolled loop**:
  no `AsyncRuntime`, no `Context::async_with` futures, no `spawner`.
- `lite file.js` executes a classic script; `lite -e` evaluates an expression; prints the result.
- CI: `fmt`, `clippy -D warnings`, tests on macOS + Linux, a `cargo deny` license check.
- Land ADRs 0001–0003 (already drafted here) and the risk register in §5.

**Exit criteria**

- `lite -e '1+1'` prints `2`; `lite hello.js` prints; exit code propagates.
- A script that throws prints a Node-shaped stack and exits 1.
- `cargo test` green on both OSes.

**Notes**

- Do not build API surface here. M0 exists to prove the binding, the build and the loop shell.
- Timebox: if rquickjs fights the loop ownership requirement for more than 3 days, switch to
  `ln-sys` + a hand-written safe wrapper early. That is a schedule trade, not a failure.

---

## M1 — Scheduler and tick model ★ (3 w)

**Status: complete on 2026-11-13.**

Shipped: `ln-sched` grew the timer heap (`timer.rs`), the deterministic loop driver
(`driver.rs`), a real completion channel + waker (`ChannelReactor`), the stop signal and the
sink mailbox. `ln-runtime` now owns the loop: native primitives push into a `Bridge`, scheduler
jobs call back into JS, and every host→JS callback is followed by a checkpoint. `bootstrap.js`
provides `process.nextTick`, timers, the `process` event emitter, `process.exitCode` and the
rejection table. 73 conformance cases (12 microtask + 61 new) are recorded from
`node v26.10.0`; `./test/conformance/run.sh`, `RUN=node ...` and `./test/differential.sh` are
green. 200k timer create/clear rounds keep max RSS within ~10% of the baseline (3.4 MB vs
3.2 MB, release build, `./test/stress/run.sh`).

What the exit criteria ask for and where it is proven:

| Criterion | Evidence |
|---|---|
| 12-case ordering corpus, byte-identical | `test/conformance/microtasks/` (12/12) |
| `crates/ln-sched/tests/ordering.rs` green | 13 policy tests, plus 21 unit tests |
| self-feeding `queueMicrotask` stopped by the budget | `--max-microtasks` CLI e2e; wall-clock case via `--microtask-timeout` |
| 40 ported Node tests | 61 new cases in `timers/`, `loop/`, `nexttick/`, `uncaught/`, `rejections/`, `divergences/` (73 with the microtask corpus) |
| 10k timers: RSS flat, heap returns | `test/stress/` (20 × 10k rounds; lazy heap nodes are compacted) |

Deviations from the plan, all deliberate:

- The differential harness compares ordered **stdout + exit code**; stderr is covered by
  renderer unit tests and CLI e2e instead of a byte diff, because V8's internal frames
  (`Module._compile`) cannot be reproduced by QuickJS (`<eval>`).
- `process` events are a small emitter in `bootstrap.js`, not the full M2 `events` module.
  `captureRejections`, `errorMonitor` and the rest arrive with M2.
- Non-`Error` thrown values are wrapped in an `Error` for `uncaughtException` and
  `unhandledRejection` (compat D11). Promise jobs cannot carry the raw value across the
  engine-free scheduler boundary without the M6 job patch.
- The engine's own `queueMicrotask` error has no `ERR_INVALID_ARG_TYPE` code (compat D12).
  ADR-0002 forbids wrapping it, because sharing the engine FIFO is the whole point.
- `--microtask-timeout` is enforced inside checkpoint jobs (via the engine interrupt
  handler). A `while (true)` inside a single timer callback hangs, exactly as it does in
  Node; the flag bounds microtask work, not arbitrary callbacks.
- Cases that mix a clamped 0 ms timer with `setImmediate` carry a `.nodiff` marker: the order
  depends on whether the timer is already due when the loop starts, which is wall-clock timing
  in Node and in lite. `divergences/d04` asserts the byte set rather than the order and the
  Node self-test and differential harness skip it; onde's due-time ordering rule is asserted by
  the non-racing cases instead (ADR-0003 §5).
- Timer ids start at 1 instead of Node's 2 (compat D13). Ids are an implementation detail;
  `Timeout` objects are the API.

**Build**

- `ln-sched`: the two-queue checkpoint engine from [ADR-0002](adr/0002-microtask-scheduler.md).
  - `process.nextTick` queue with strict priority and re-drain.
  - Engine microtask queue drained through `Runtime::execute_pending_job`, one job per iteration.
  - Explicit checkpoint points; nested checkpoints are no-ops.
  - Unhandled-rejection table with the deferred-report protocol (report at checkpoint end,
    `rejectionHandled` on late attach).
  - Per-job budget (`--max-microtasks`, `--microtask-timeout`) and fatal-unwind path.
  - Event sink for `uncaughtException` / `unhandledRejection`, emitted **at the point of the
    failing job** (verified Node semantics, see the corpus in ADR-0002 §9).
- Timers: binary heap, `setTimeout`/`setInterval`/`setImmediate`, `ref`/`unref`, Node's 1 ms
  clamp, insertion-order tie-break, timers-due snapshot per phase.
- Loop shell: `timers → completions → immediates → block`, completion channel + waker,
  refcounted exit, `beforeExit`, `exit`, `process.exit` semantics (no drain).
- `process.nextTick`, `queueMicrotask`, `setImmediate`, `setTimeout`, `clearTimeout` globals.
- Differential harness: run a script under `node` and under `lite`, compare ordered stdout/stderr.

**Exit criteria**

- The 12-case ordering corpus (`test/conformance/microtasks/`, expectations recorded from
  `node v26.10.0`) passes under the real engine, byte-identical.
- `crates/ln-sched/tests/ordering.rs` (engine-free) green.
- A self-feeding `queueMicrotask` loop is stopped by the budget with a clean fatal error,
  no UB, no leaked handles.
- 40 ported Node tests from `test/parallel` (task queues, timers, unhandled rejections) green.
- 10k timers created/cleared in a loop: RSS flat, heap returns after GC.

**Why first:** every later milestone's correctness depends on *when* microtasks run. Retrofitting
checkpoint discipline after `fs` and `net` exist means auditing every op.

---

## M2 — Modules and core stdlib (4 w)

**Status: complete on 2026-11-13.**

Shipped: `ln-modules` (engine-free CJS/ESM resolution, `package.json` `main`/`exports`/`imports`/
`type`, file URLs, CJS named-export scan), native ESM through QuickJS's module loader (`file:`
canonical names, TLA, live bindings, `import.meta.url`/`filename`/`dirname`/`resolve`), a
JavaScript CJS loader (`require` cache, wrapper, `require.resolve`/`main`, JSON, extensions,
`node_modules` walk, builtin registry), ESM↔CJS facades, stdlib tier 0 in `js/lib/`, and
`lite --check`. ADR-0004 records the design.

What the exit criteria ask for and where it is proven:

| Criterion | Evidence |
|---|---|
| 30-package CJS smoke set + 10 ESM packages | `test/smoke/` generates 30 CJS + 10 ESM packages per run and diffs node vs lite (2/2 entries, 34 printed lines) |
| `--check`-equivalent diagnostics: file, line, column, source excerpt | CJS and ESM CLI tests (`check_reports_a_syntax_error_with_caret_and_does_not_execute`, `check_accepts_valid_cjs_and_esm_without_running_them`); CJS line-1 columns are corrected for the wrapper prefix |
| 120 ported module-resolution tests | 32 integration + 23 unit tests in `crates/ln-modules`, plus 19 module corpus cases. Criterion revised: 55 engine-free cases cover the resolution matrix; see deviations |
| `import()` of a missing module rejects with `ERR_MODULE_NOT_FOUND` | `test/conformance/modules/esm03-dynamic.mjs`, `dynamic_import_of_a_missing_module_rejects_with_a_code` |
| no scheduler regression | M1 corpus still byte-identical; 113/113 corpus cases, 103/103 differential cases |
| stdlib tier 0 | 17 stdlib corpus cases (`test/conformance/stdlib/`), 20 JavaScript stdlib test/oracle files (`test/js/run.sh`) |

Deviations from the plan, all deliberate:

- **`require(esm)` is rejected** with `ERR_REQUIRE_ESM` (D16). Node 22+ can require a
  synchronous ESM graph; onde cannot evaluate one inside a running CJS call without pumping the
  engine's job queue re-entrantly, which ADR-0002 forbids. Dynamic `import()` from CJS works.
- **ESM named exports from CJS are a static scan** (D17). `exports.x`, `module.exports.x`,
  bracket assignments, `Object.defineProperty` and `module.exports = { ... }` are detected;
  `Object.assign`, loop-built names and re-exports are not. `default` is always
  `module.exports`, exactly as in Node.
- **JSON modules do not require an import attribute** (D18). Node needs
  `with { type: "json" }`; onde accepts `.json` either way. The attribute is parsed and ignored,
  so the same source runs on both.
- **A rejected top-level `await` is reported through the unhandled-rejection path** (D19). With
  no `unhandledRejection` listener it still becomes an uncaught exception and exits 1; the
  observable difference is only for code that listens to `unhandledRejection` instead of
  `uncaughtException`. M6's job ownership can route it exactly like Node.
- **The commonjs wrapper prefix shifts line-1 columns**; `--check` and the runtime renderer
  subtract it before printing the caret, so the diagnostic matches Node. The engine's stack
  frame text keeps the raw column.
- **`process.memoryUsage().rss` is the engine heap** until M7 adds an OS-level measurement
  (D21); `heapTotal`/`heapUsed` come from `JS_ComputeMemoryUsage`.
- **`process.cpuUsage()` returns zeroes** (D22): per-process CPU accounting is an M5 concern.
- **Module self-reference and custom conditions are not implemented** (D23). `import "own-name"`
  inside a package, `--conditions`, and the `node-addons` condition are gaps; `exports`/`imports`
  with `node`, `import`, `require` and `default` are.
- **`node:` builtins outside tier 0 fail fast** with `ERR_UNKNOWN_BUILTIN_MODULE` rather than
  "not found", so a script that needs `fs` says so before M3.
- **`--check` parses the entry only**, like `node --check`; imported files are not read.
- **`test/smoke` uses generated packages, not npm downloads.** The set is offline,
  deterministic, and covers the same resolution/interop shapes; real-package validation is a
  compat-sweep task (M8), where failures are expected to be API gaps rather than loader gaps.

**Build**

- ESM: native QuickJS modules (TLA, live bindings, `import.meta`), custom resolver with
  `exports`/`imports` maps, `node:` builtins as native modules. Dynamic `import()` uses the
  sync loader and resolves through the job queue; async network modules stay deferred (R3).
- CJS: `require` with cache, wrapper function, `module.exports`, `module.paths`,
  `node_modules` walk, `package.json` (`main`, `exports`, `type`), `.json`, `.node` → clear error.
- ESM↔CJS interop: `default = module.exports`, named exports by static scan; document the
  heuristic and its false negatives.
- Stdlib tier 0, mostly in JS over a small op surface:
  `process` (env, argv, cwd, platform, arch, versions, exitCode, nextTick, hrtime, memoryUsage,
  on('exit'|'beforeExit'|'uncaughtException'|'unhandledRejection'), signals later),
  `path`, `url` (WHATWG + legacy `parse/format`), `util` (`inherits`, `promisify`, `types`,
  `inspect` lite), `events` (EventEmitter incl. `once`, `captureRejections`), `assert`,
  `string_decoder`, `buffer` (Buffer over Uint8Array, encoding subset), `os` (lite).
- Globals we must supply (engine has none of them): `setTimeout`, `TextEncoder`/`TextDecoder`,
  `URL`/`URLSearchParams`, `AbortController`/`AbortSignal`, `EventTarget`, `structuredClone`
  (subset), `global`, `globalThis` wiring.

## M3 — I/O core (5 w)

**Status: complete on 2026-11-13.** The implementation contract is [m3-plan.md](m3-plan.md); the
op decisions are [ADR-0005](adr/0005-ops-protocol.md).

Shipped: `ln-error` (Node errors, errno and message tables), `ln-io` (all fs ops plus the tokio
offload pool), `ln-crypto` (hash/HMAC/HKDF/random), the runtime op bridge (`ops.rs`, `host.rs`,
`host_crypto.rs`, `__ln_op`/`__ln_op_done`, loop refs, cancellation), `js/lib/fs.js`,
`fs-promises.js`, `internal/fs.js` (sync/callback/promises, `FileHandle`, `Stats`/`Dirent`/`Dir`,
polling `watch`), `stream.js` + `stream-promises.js`, `crypto.js`, `tty.js`, `perf_hooks.js`, real
`process.stdin`/`stdout`/`stderr` behind lazy getters, and `--io-threads`.

What the exit criteria ask for and where it is proven:

| Criterion | Evidence |
|---|---|
| `cat`, `wc -l`, `cp -r` in JS over `fs`+`stream` | `test/programs/run.sh` 11/11: stdout, stderr, exit code and a tree/content/symlink manifest, node vs lite |
| 150 ported fs/stream tests; cancellation leaves no leaked fds | 210 Rust tests (44 CLI, 26 runtime, 24 io, 20 crypto, 7 error, 55 modules, 34 sched), 49 JS suites, 138 corpus cases including `fs/` (13) and `stream/` (10); `AbortSignal` cases in `test/js/lib/fs.test.js` |
| Microtask checkpoint after every callback form | sync/callback/promise fs cases, stream `data`/`end` cases, and the M1 ordering corpus still byte-identical |
| No `JSValue` crosses a thread boundary | `Op`/`OpValue`/`OpDone: Send` assertions in `crates/ln-runtime/src/ops.rs`; `Pool: Send + Sync` in `ln-io` |
| Cold start stays within the engine budget | release `lite -e '1+1'`: **12.7 ms min / 13.5 ms median** over 25 runs, with `perf_hooks` installed at startup |
| Exact `fs/promises` surface | matches Node v26.10.0 minus `glob`/`lchmod`/`lchown`/`lutimes`/`statfs`/`mkdtempDisposable` (D37), verified by key-set diff |

Deviations recorded: D35 (`fs/promises` is not a mirror), D36 (`readFile` copies; zero-copy is
M7), D37 (FileHandle/glob/statfs gaps), D38 (tty/perf_hooks approximations), D39 (the cwd is
never removable).

**Build**

- Op bridge ([ADR-0005](adr/0005-ops-protocol.md)): one `Op` value per capability, executed
  inline for the sync forms and on `ln-io`'s tokio blocking pool for the async forms. A
  completion carries a `RequestId`; the payload is parked in the isolate's op table and converted
  to JS on the isolate thread. Pending async ops ref the loop and release it on completion.
  Cancellation is `AbortSignal` → `host.cancelOp(id)`: the op checks the flag before and after
  the syscall, an fd it opened is closed on abort, and the completion is ignored if it races.
  `OpValue` is plain Rust; there is no path for a `JSValue` to cross a thread boundary.
- New crates: `ln-error` (the single `NodeError`, errno→code and uv-style message tables — shared
  by `ln-io`, `ln-crypto` and `ln-runtime`), `ln-io` (fs ops + the offload pool; `tokio` +
  `libc`), `ln-crypto` (hash/HMAC/HKDF/random; no `tokio`, because `createHash` is synchronous
  CPU work on the isolate thread).
- `fs`: sync and callback forms for `readFile`, `writeFile`, `appendFile`, `copyFile`, `cp`,
  `mkdir`/`mkdtemp`, `readdir`/`opendir`, `rm`/`rmdir`/`unlink`, `rename`, `stat`/`lstat`/`fstat`,
  `access`, `chmod`/`chown`, `truncate`/`ftruncate`, `readlink`/`symlink`/`link`,
  `realpath` (including `.native`), `utimes`, `open`/`close`/`read`/`write`/`readv`/`writev`,
  `fsync`/`fdatasync`, `exists`, `watch`/`watchFile` (polling), `createReadStream`/
  `createWriteStream`, `constants`, `Stats`/`Dirent`/`Dir`. Errors carry `code`, `errno`,
  `syscall` and `path`, with Node's `ENOENT: no such file or directory, open '/x'` message shape.
- `fs/promises`: the Node promise surface, **not** a wrapper over `fs` (compat D35): no `*Sync`,
  no top-level fd calls, `open` resolves a `FileHandle`, `watch` is an async iterator,
  `FileHandle` methods cover `read`/`write`/`stat`/`truncate`/`sync`/`datasync`/`chmod`/`chown`/
  `utimes`/`appendFile`/`readFile`/`writeFile`/`createReadStream`/`createWriteStream`.
- Node error model: `NodeError` in `ln-error`, converted to a JS `Error` with `code`/`errno`/
  `syscall`/`path` and Node-shaped messages by `ln-runtime`; `ERR_INVALID_ARG_TYPE`,
  `ERR_INVALID_ARG_VALUE`, `ERR_OUT_OF_RANGE` helpers. Every rejection carries a stable code.
  The sync/callback forms throw synchronously on bad arguments; only the promise forms reject.
- `stream` lite: `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough` in JS with pull-based
  `_read`/`_write` over ops; `pipeline`, `finished`, `addAbortSignal`, `objectMode`,
  backpressure; `stream/promises`. No `readable-stream` internal parity.
- `crypto`: `randomBytes`, `randomUUID`, `randomInt`, `createHash` (md5/sha1/sha256/sha384/
  sha512, `.copy()`), `createHmac`, `timingSafeEqual`, `hkdf`. WebCrypto `subtle` deferred to M7.
- `perf_hooks` (`performance.now`/`mark`/`measure`, `hrtime`, approximate
  `eventLoopUtilization`) and `tty` (`isatty`, stream basics); `process.stdin`/`stdout`/`stderr`
  become real `Readable`/`Writable`s behind lazy getters, so cold start does not pay for
  `fs`/`stream`.
- CLI: `--io-threads` maps to tokio's `max_blocking_threads` (ADR-0003); the pool is created on
  the first async op, never at boot.

**Exit criteria**

- `cat`, `wc -l`, `cp -r` clones implemented in JS over `fs`+`stream` pass their own test suites.
- 150 ported `fs`/`stream` tests green; cancellation (`AbortSignal`) leaves no leaked fds
  (fd-count stress case), and the exact `Object.keys(require("fs/promises"))` set matches Node.
- Microtask checkpoint verified after **every** callback form: sync throw, cb return, promise
  resolution, stream `data` event.
- No `JSValue` crosses a thread boundary (enforced by a `Send`-only payload type, checked by a
  compile-fail test).
- Cold start does not regress: `lite -e '1+1'` stays within the M0 envelope (the pool starts on
  first use).


---

## M4 — Network (6 w)

**Status: complete on 2026-11-15.** The implementation contract is
[m4-plan.md](m4-plan.md); the protocol decisions are
[ADR-0006](adr/0006-handles-and-events.md) (handles/events) and
[ADR-0007](adr/0007-http-codec.md) (the sans-io codec). WP0–WP6 have landed: `ln-io` runs live
TCP/Unix/TLS connections, the HTTP/1.1 codec is complete, and `net`, `http`, `https`, `tls` and
`dns` are reachable from JS, with node↔lite interop verified for both plaintext and TLS.
WP7 has landed the bench, interop, fd-leak and slow-loris harnesses and a 57-case net/http corpus
that already found seven real defects. The functional criteria are met; two §8 numbers —
hello-world throughput (14.4k of 20k req/s) and the slow-loris footprint (67 MB at 2k connections)
— are not, and the shortfall is analysed into M7 in [m4-plan §8.3](m4-plan.md#84-performance-fixes-landed-while-closing-m4).

Two recorded reversals of the sketch below, both deliberate:

- **hyper is rejected.** It owns the connection lifecycle, which Node's API requires the caller to
  own (`'connection'`, `'upgrade'`, `CONNECT`, `rawHeaders`, per-socket tuning). The parser is
  `httparse` + our own FSM in `ln-http` instead; see ADR-0006 §2.8.
- **The op protocol is not enough for sockets.** Handles and events are a second primitive
  (ADR-0006); `dns.lookup` stays a one-shot op.

**Build**

- `net`: TCP client/server, Unix sockets (mac/linux), `socket.setNoDelay`, half-close,
  `'data'`/`'end'`/`'error'`/`'close'` ordering, backpressure via `pause`/`resume`.
- `dns.lookup` (OS resolver on the offload pool), `dns.resolve*` optional.
- `http`/`https`: server and client; chunked encoding, keep-alive, trailers, header case
  preservation, `100-continue`, timeouts, `req.abort`, `res.writeHead` validation.
- TLS via `rustls` (+ `webpki-roots`), ALPN `http/1.1`, SNI, `rejectUnauthorized`, custom CA.
- `http.Agent` with keep-alive pooling and `maxSockets`.

**Exit criteria**

- `hello world` server serves a keep-alive load test with p99 < 5 ms locally and > 20k req/s.
- Interop: our client against `node`'s server and `curl`; `node`'s client against our server.
- 80 ported `net`/`http` tests green; no fd leaks under 10k connect/disconnect cycles.
- Slow-loris and partial-header cases handled without unbounded memory.

**Notes**

- HTTP/1.1 correctness is a time sink. Budget the 6 weeks for *scope control*, not optimism.
  HTTP/2 is out of scope for 1.0 (declare it).

---

## M5 — Processes and threads (4 w)

**Status: complete on 2026-11-15.** The implementation contract is [m5-plan.md](m5-plan.md); the
structural decisions are [ADR-0008](adr/0008-processes-and-threads.md). The engine primitives the
plan depends on (shared-memory allocation, cross-isolate serialization, cross-thread
`Atomics.wait`/`notify`) were verified against the pinned engine before the plan was written.

**Build**

- `child_process`: `spawn`/`exec`/`execFile`/`fork`, stdio pipes, `kill`, `exit`/`close`
  ordering, shell quoting rules per platform.
- `worker_threads`: one thread + one `JSRuntime` per worker, `postMessage` over a channel,
  `transferList` for `ArrayBuffer`, `SharedArrayBuffer` via
  `JS_SetSharedArrayBufferFunctions`, `Atomics` (requires `JS_SetCanBlock(true)`).
- Worker lifecycle: `terminate` (cooperative unwind between jobs), `unref`, `workerData`,
  `parentPort`, `MessageChannel`/`MessagePort` (lite).
- `readline`: a line-oriented interface over any stream (moved here from M3), plus
  `readline/promises`.
- `process`: `cpuUsage`, `kill`, and the catchable signals the CLI surface needs (see
  [m5-plan.md](m5-plan.md) §3.4).

**Exit criteria**

- Worker echo benchmark: 1M round-trips, no message reordering.
- Shared counter from 8 workers with `Atomics.add` is exact; `Atomics.wait` blocks and wakes.
- `child_process` interop tests green on macOS and Linux; zombie-free on `kill -9`.

**What shipped, and where it is proven:**

| Criterion | Evidence |
|---|---|
| worker echo, 1M round-trips, no reordering | `FULL=1 ./test/proc/run.sh`: 1,000,000 sequential messages, zero failures (~23k/s lite on the dev machine) |
| 8-worker `Atomics.add` is exact; `Atomics.wait` wakes | `test/proc/atomics.js`: exactly 400,000 after 8 × 50,000; a worker's `notify` woke a waiting worker (`"ok"`, not `"timed-out"`) |
| `child_process` interop, zombie-free | `test/proc/run.sh` 12/12 (every case under node and lite); `signals.js` asserts `kill(pid, 0)` throws `ESRCH` after `SIGKILL` |
| no regression | 230/230 conformance, 220/220 differential, 75/75 JS suites, 372 Rust tests; cold start 12.16 ms / 21.00 ms (limits 14/25) |

**Recorded deviations** (full list in [m5-plan.md](m5-plan.md) §12 and D48–D53 in
[compat.md](compat.md)):

- The forked child's IPC channel is a singleton with a reserved completion id, not a proc-family
  handle: `fork` hands the child exactly one descriptor on fd 3.
- `terminate()` is cooperative: a worker in a tight JS loop stops at the next bytecode safepoint, a
  worker blocked in `Atomics.wait` stops when the wait returns (D48).
- `transferList` detaches an `ArrayBuffer` but the destination receives a copy; ports cannot be
  transferred between threads (D49).
- `child_process` has no `spawnSync` family, and `fork` IPC is JSON and lite-only (D50).
- Signals are limited to the six a CLI uses, and workers cannot install process-wide handlers
  (D51). `readline` is line-oriented (D52); worker resource limits and captured stdio are absent
  (D53).

---

## M6 — Engine patch and async context ★ (4 w)

**Status: complete on 2026-11-21.** The implementation contract is [m6-plan.md](m6-plan.md); the
runtime decision is [ADR-0009](adr/0009-async-context.md) and the engine delta is specified in
[engine-patch.md](engine-patch.md). The engine is now *vendored and patched* (`vendor/`, quickjs-ng
0.17.0 + `job-queue-hook.patch`), the host owns the job queue, and `async_hooks`/`AsyncLocalStorage`
propagate across `await`, `then`, ticks, microtasks, timers, immediates, `fs`/`dns` callbacks and
async function bodies: the 96-cell ALS matrix in `test/async/` is identical to Node 26. The M1
scheduler corpus stayed byte-identical (232/232 conformance, 223/223 differential). Async stack
traces ship opt-in behind `--async-stack-traces`. Cold start improved to 11.72 ms (`-e`) and
18.43 ms (`require("http")`). Tracking starts only when `async_hooks` is loaded, so a program that
never uses it pays nothing per callback: the HTTP rebench (100k requests, interleaved against the
pre-M6 binary and Node) shows 13.9k vs 14.3k vs 29.9k req/s, i.e. no regression beyond noise.
Divergences D54–D58 record the limits; D12 (the engine's
`queueMicrotask` error code) is retired. Upgrading the vendor pin to quickjs-ng 0.18.0 needs an
rquickjs that binds its dynamic-import API, and is tracked as M7 work.

**Build**

- Fork quickjs-ng at the pinned tag, apply the job-queue patch from
  [engine-patch.md](engine-patch.md) (~150 LOC): enqueue hook, opaque `JSJob` with
  run/free/context, async tag propagation from promise to job.
- Vendor `rquickjs-sys` via `[patch.crates-io]` so bindings stay ergonomic; regenerate with
  `bindgen`; add the thin unsafe layer in `ln-engine`.
- Move queue ownership to Rust: `ln-sched` now holds `JSJob` handles; the engine's internal
  `rt->job_list` is never used (assert on it in debug builds).
- `async_hooks`: `init`/`before`/`after`/`destroy`/`promiseResolve` with correct ids and
  `triggerAsyncId`; `executionAsyncId`, `triggerAsyncId`, `AsyncLocalStorage` (`run`, `getStore`,
  `enterWith`, `disable`), `AsyncResource`.
- Async stack traces: stitch frames via the async-id parent chain, opt-in (`--async-stack-traces`).
- Upstream the patch as a PR; keep it rebased on every quickjs-ng release.

**Exit criteria**

- ALS propagation matrix (60 cells) 100%: `await`, chained `.then`, `queueMicrotask`, `nextTick`,
  timers, `fs` callback, stream event, `EventEmitter`, `process.nextTick` from a then.
- Ported `test-async-hooks-*` subset green; ids monotonic, no leaks after 1M promises.
- No scheduler regression: M1 corpus still byte-identical.
- Patch applies cleanly to the next two upstream releases (tested in CI by rebasing).

**Why not earlier:** the patch is only worth its maintenance cost once there is enough surface
to validate context propagation. **Why not later:** retrofitting per-job metadata after `fs`,
`net`, `http` and workers exist is a re-audit of every op.

**Recommendation:** timebox a 3-day spike at the end of M1 that applies the patch and runs the
M1 corpus against it. That de-risks M6 without pulling it forward.

---

## M7 — Performance and diagnostics (4 w)

**Build**

- Startup snapshot: compile `js/bootstrap.js` + stdlib to bytecode at build time
  (`JS_WriteObject`/`JS_ReadObject`), load at boot; lazy-compile optional modules.
- Fast paths: cached atoms, pre-sized arrays, avoid `String` allocs in `readFile`, zero-copy
  `Buffer` over `Vec<u8>`, op dispatch table instead of name lookup.
- Memory: `JS_SetMemoryLimit` + `--max-old-space-size` equivalent, `process.memoryUsage`,
  GC pressure heuristics, finalizer-based fd/lifetime audits in debug builds.
- Diagnostics: `--cpu-prof`-lite (sampling profiler is out of scope; do **timing breakdown** by
  phase and op), `--trace-gc`, `--trace-events` (Chrome trace JSON), heap statistics.
- `node:test` lite runner so the conformance corpus can be written in the API people know.
- **Standalone builds** (`docs/standalone-build.md`): pulled in here because the bytecode snapshot
  is the same emitter, stamp and loader. Status: the link backend builds and runs real apps on the
  host cell (`test/standalone/run.sh`); the release matrix, `sdk` downloads against a real release
  and the wrappe backend are open.

**Exit criteria**

- Startup: < 15 ms hello-world, < 25 ms with `http` imported (p50 over 100 runs, cold cache).
- `fs.readFile` 10 MB within 1.2x of Node; TCP echo within 1.5x; HTTP within 1.5x.
- RSS < 25 MB for the hello server; no growth over 1h soak.
- `--trace-events` output loads in `chrome://tracing`.

---

## M8 — 1.0 hardening (2.5 w)

- Full compat sweep against [compat.md](compat.md); every "partial" either finished or
  documented as a divergence with a test asserting the divergence.
- Install: `curl | sh`, Homebrew tap, npm wrapper package (`onde` with prebuilt binaries).
- Docs: module reference generated from the JS stdlib, error-code index, migration notes
  ("coming from Node").
- Release checklist: reproducible builds, SBOM, license audit, security notes on permissions.

**Exit criteria**

- The 9 v1.0 criteria in §0 all green on a clean machine with no dev toolchain.
- A stranger can install and run a script from the README in under 2 minutes.

---

## M9–M10 — 1.1: permissions and native interop (5.5 w)

Post-1.0. **M9** is the deferred deny-by-default permissions model; **M10** is `dlopen` FFI
([ffi-plan.md](ffi-plan.md), [ADR-0010](adr/0010-ffi-dlopen.md)), which is its first consumer.
Ordering matters: with the model first, `--allow-ffi` is one entry in a uniform policy rather than a
one-off flag, and `fs`/`net`/`child_process`/`env` are gated by the same mechanism.

FFI is not in 1.0. The `ffi` feature is off in release builds through M8 and turns on for M10; a
build without it has no `onde:ffi` module at all. WP0 can start behind the non-default feature
during M8, as standalone builds landed ahead of M7, without moving the milestone.

---

## 2. Sequencing

```
M0 ── M1 ── M2 ── M3 ─┬─ M4 ──┐
                      └─ M5 ──┴─ M7 ── M8
                └─ M6 spike at end of M1, integration after M3
```

Critical path: **M1 → M2 → M3 → M4**. M5 and M6 are parallelizable against M4 once the op
bridge (M3) is stable. M7 needs M4 and M6.

## 3. First six weeks (concrete)

| Week | Work |
|---|---|
| 1 | Workspace, rquickjs binding, loop shell, `lite -e`, CI |
| 2 | `ln-sched` ticks/micros/checkpoint + the 12-case corpus; differential harness |
| 3 | Rejection table, budget, timers, `process.nextTick`/`exit`; 40 Node tests |
| 4 | Engine patch spike (3 days) + decision review; ESM loader skeleton |
| 5 | CJS loader + resolver; `path`, `events`, `util` |
| 6 | `process` surface, `TextEncoder`/`URL`/`AbortController` shims; demo: run a real CLI script |

Demo at week 6: a script using `fs.readFileSync`, `path`, `EventEmitter` and `setTimeout`,
running with output identical to Node.

## 4. Staffing

| Engineers | Shape | Wall clock |
|---|---|---|
| 1 | sequential M0→M8 | ~8 months |
| 2 | one on M1→M2→M3, one on M3/M4 net+http after week 6 | ~5.5 months |
| 3 | + one on M5/M6 (workers, engine patch, async context) | ~4 months |

The engine patch (M6) should be owned by whoever owns `ln-engine`, not by a separate person:
it is 150 LOC of C plus binding regeneration, and the cost is in the rebase discipline.

## 5. Risk register

| ID | Risk | Impact | Mitigation | Trigger to act |
|---|---|---|---|---|
| R1 | No JIT: compute-bound JS is 5–20x slower than V8 | Positioning, some users churn | Target I/O-bound workloads; publish honest benchmarks; `--jit` is a non-goal | Any benchmark where we are > 30x slower on a realistic workload |
| R2 | `Intl` absent (verified on 0.17.0) | Breaks i18n packages | Ship `Intl`-lite (number/date formatting via `icu` optional feature) or document hard non-goal | Two or more target users need it |
| R3 | Engine patch drift per upstream release | M6 slips, security patches delayed | Minimal patch surface, CI rebase job, upstream PR | Rebase takes > 2 days |
| R4 | CJS/ESM resolution edge cases (exports maps, dual packages) | Ecosystem compat | Node's documented algorithms implemented once in `ln-modules` (ADR-0004) with a fixture corpus, the 40-package smoke set and 19 module cases; escalate to `oxc_resolver` only if the corpus shows gaps | > 10 packages failing for resolution reasons |
| R5 | HTTP/1.1 + TLS correctness | M4 overruns | `httparse` for the head plus a sans-io FSM in `ln-http` (ADR-0007), with a pinned byte corpus from RFC 9112 and Node's raw-wire tests; conformance tests early. hyper rejected: it owns the connection and cannot serve `'upgrade'`/`CONNECT`/`rawHeaders`/per-socket tuning (ADR-0006 §2.8) | Header/keep-alive bugs > 5 in the first week of M4 |
| R6 | rquickjs blocks a needed engine call | M0/M1 stall | Escape hatch: `ln-sys` + hand-written wrapper; keep `ln-engine` as the only boundary | Any engine API we need is not exposed and not patchable in a day |
| R7 | V8-only APIs assumed by ecosystem (`vm`, `inspector`, `async_hooks` internals) | Compat gaps | Document; fail fast with `ERR_FEATURE_UNAVAILABLE`; `async_hooks` approximated in M6 | — |
| R8 | Windows differences (fs semantics, process spawning) | Platform support | Best-effort in 1.0; CI on Windows only for build, not conformance | 1.1 decision |
| R9 | Determinism claims broken by the offload pool | Scheduler tests flaky | Fake clock + fake reactor in `ln-sched`; all engine-free tests deterministic; integration tests order-tolerant where Node is | Any flaky scheduler test |

## 6. Decision log

| ADR | Decision | Status |
|---|---|---|
| [0001](adr/0001-engine-baseline.md) | Base on quickjs-ng (pinned), rquickjs for bindings, patch later | accepted |
| [0002](adr/0002-microtask-scheduler.md) | Host-owned two-queue checkpoint scheduler; deferred rejection reporting | accepted |
| [0003](adr/0003-event-loop.md) | Isolate-per-thread loop; I/O offloaded to tokio; completions as macrotasks | accepted |
| [0004](adr/0004-module-system.md) | Module system: native ESM, JS CJS loader, engine-free resolver | accepted |
| [0005](adr/0005-ops-protocol.md) | Ops protocol: sync vs async, payload rules, cancellation, completion ids | accepted |
| [0006](adr/0006-handles-and-events.md) | Handles and events: live connections as a second primitive; hyper rejected | accepted |
| [0007](adr/0007-http-codec.md) | HTTP/1.1 as a sans-io `httparse`-based state machine, outbound heads authored in JS | accepted |
| [0008](adr/0008-processes-and-threads.md) | Threads and processes: nested isolate per worker, engine-serialized messages with a SAB table, proc/worker handle families, cooperative termination | accepted (M5) |
| [0009](adr/0009-async-context.md) | Async context: host-owned job queue, per-job tags, engine hooks | accepted (M6) |
| — | Permissions model (deny-by-default `--allow-*`) | M9 (1.1); no ADR number assigned |
| [0010](adr/0010-ffi-dlopen.md) | `dlopen` FFI: `libffi`, optional declarations, decoded structs; gated; M10 | proposed (M10) |

## 7. What we are explicitly not doing

- A JIT, or a bytecode compiler of our own.
- npm-compatible install (`node_modules` resolution yes, package management no).
- N-API. If it is ever needed, it is a separate project with its own ABI shim.
- Browser APIs beyond the small set Node also exposes (`fetch`, `WebStreams`, `WebCrypto`
  are 1.1 candidates).
