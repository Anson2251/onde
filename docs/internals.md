# Internals and reference

The inventory, the repository layout, and the harnesses. The overview, the numbers and the pitch
are in the [README](../README.md); per-module compatibility and every deliberate divergence are in
[compat.md](compat.md); the milestones are in [roadmap.md](roadmap.md).

## 1. What runs today

### Runtime and scheduler

- [`onde <file>`](../crates/ln-cli/src/main.rs), `onde -e '<script>'`, `--check`, `--help`,
  `--version`
- `console.log` → stdout, `console.warn/error` → stderr, Node's `util.format`/`util.inspect`
- `process`: `argv`, `env`, `cwd`/`chdir`, `platform`, `arch`, `version(s)`, `pid`/`ppid`,
  `title`, `exit`/`exitCode`, `nextTick`, `hrtime`/`hrtime.bigint`, `uptime`, `memoryUsage`,
  `emitWarning`, `stdout`/`stderr`/`stdin`, and `on`/`once`/`off` for `exit`, `beforeExit`,
  `uncaughtException`, `unhandledRejection`, `rejectionHandled`, `warning`
- timers (`setTimeout`/`setInterval`/`setImmediate`, clears, `ref`/`unref`/`hasRef`, Node's clamp
  and insertion order) and `queueMicrotask`
- Node-compatible ordering: `nextTick` before promise jobs, unhandled rejections after both queues,
  inline `uncaughtException`, `beforeExit` revival, `process.exit` without draining
- Node-shaped uncaught errors: `file:line`, source line, caret, `Error: message`, frames
- `--max-microtasks N` / `--microtask-timeout MS` guard against unbounded microtask work

### Modules

- CommonJS: `require`, cache, wrapper (`this === module.exports`), `module.exports`, `module.paths`,
  `require.resolve`/`require.cache`/`require.main`, JSON modules, `node_modules` walking (including
  nested and scoped packages), `package.json` `main`/`exports`/`type`
- ES modules: native QuickJS modules with top-level await, live bindings,
  `import.meta.url`/`filename`/`dirname`/`resolve`, dynamic `import()`, and `file:`/`node:`
  specifiers
- `exports`/`imports` maps with conditions (`node`, `import`, `require`, `default`), subpath
  patterns (`./feature/*`), arrays and `null` blocks
- ESM↔CJS interop: `default = module.exports` plus statically scanned named exports; builtins are
  importable as `node:path` or `path`
- `--check` compiles the entry without running it, with Node-shaped file/line/column/caret

### Tier 0 stdlib — M2

`path` (posix + win32), `url` (WHATWG `URL`/`URLSearchParams` + legacy), `util` (`format`,
`inspect`, `promisify`, `inherits`, `types`, `isDeepStrictEqual`), `events` (`EventEmitter`, `once`,
`on`, `errorMonitor`, `captureRejections`), `assert` (+ `assert/strict`), `buffer`,
`string_decoder`, `os`, `console`, `querystring`, `punycode`, `module`, `constants`.

### Tier 1 — M3

- `fs` and `fs/promises`: sync + callback + promise forms for the usual surface, including
  `readdir` with `withFileTypes`/`recursive`, `open`/`read`/`write`/`readv`/`writev`, `statfs`,
  `mkdtemp`, `cp`, polled `watch`/`watchFile`, and `createReadStream`/`createWriteStream`
- `stream` and `stream/promises`: `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough`,
  `pipeline`, `finished`, `addAbortSignal`, backpressure
- `crypto`: `randomBytes`, `randomUUID`/`randomUUIDv7`, `randomInt`, `createHash`, `createHmac`,
  `timingSafeEqual`, `hkdf`, one-shot `hash`; no ciphers or signatures
- `perf_hooks`, `tty`, and real stdio for `process.stdout`/`stderr`/`stdin`

### Tier 2 — M4

- `net`: TCP and Unix sockets, IPv4/IPv6, half-close, `pause`/`resume`, `setTimeout`,
  `setNoDelay`/`setKeepAlive`, `ref`/`unref`, `getConnections`
- `http` and `https`: HTTP/1.1 server and client, chunked both ways, keep-alive, `100-continue`,
  inbound trailers, `clientError`, upgrade, `Agent`
- `tls`: rustls, certificate verification against bundled roots, ALPN, `ca`/`cert`/`key`
- `dns`: `lookup` over the OS resolver
- `zlib`: `gzip`/`gunzip`/`deflate`/`inflate` (and `Raw`) in sync and callback forms,
  `crc32`, `constants`
- `sqlite` (after M7): `Database`/`Statement`/`Session`/`SQLTagStore`, the 45 `constants` and
  `backup` over a bundled SQLite 3.53.2; user-defined functions and aggregates, the authorizer,
  changesets, JavaScript-backed virtual tables and extension loading. Sync-only, with Node's type
  conversion and binding rules. The `node-sqlite` feature can drop the whole module (and the
  bundled C) from a build; `node-zlib` drops the `node:zlib` module and, in `onde`, zlib itself
  (the only consumer there). The SDK keeps the payload inflater through a separate `zlib-payload`
  feature. The network stack has two flags: `node-net` drops `net`, `http` and `dns` together with
  the socket layer and the `ln-http` codec, and `node-tls` drops `tls`/`https` and the rustls
  provider underneath (it implies `node-net`, since a TLS stream is always over a socket).
  `node-crypto` drops `node:crypto` and the RustCrypto digests; it is independent of the network
  flags. Per-flag binary cost is measured in the README's feature-footprint section.

### Processes, threads and lines — M5

- `child_process`: `spawn`/`exec`/`execFile`/`fork`; stdio `pipe`/`ignore`/`inherit`/fd, the
  `ChildProcess` event set, streamed stdin/stdout/stderr with backpressure, `kill`, `exec`
  `timeout`/`maxBuffer`/`killSignal`, `shell`, `cwd`/`env`/`argv0`/`detached`, and `fork` IPC
  (`send`/`message`/`disconnect`, JSON frames over fd 3)
- `worker_threads`: one isolate per OS thread, `Worker`, `parentPort`, `workerData`, `threadId`,
  `MessageChannel`/`MessagePort`, `receiveMessageOnPort`, `transferList`, `SharedArrayBuffer` and
  cross-thread `Atomics`, cooperative `terminate`, `ref`/`unref`
- `readline` and `readline/promises`: `createInterface`, `Interface`, prompts, history, async
  iteration, ANSI helpers, `emitKeypressEvents`
- `process`: real `cpuUsage`, `kill`, the six catchable signals, and `send`/`message`/`disconnect`
  in a forked child

### Globals

`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`,
`EventTarget`, `Event`, `DOMException`, `structuredClone`, `atob`/`btoa`, `global`.

### Diagnostics

`onde --check`, Node-shaped resolution errors with `code` (`MODULE_NOT_FOUND`,
`ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_REQUIRE_ESM`, …), and uncaught-error
rendering shared by scripts and modules.

### Async context (M6)

`async_hooks` and `AsyncLocalStorage` are host features built on the patched engine: the engine
hands every job to `ln-engine`'s queue with an `int64_t` tag, promises carry the tag of the resource
they belong to, and the runtime brackets each job with `before`/`after`. `js/lib/async_hooks.js`
owns the hook list, the store tables and `AsyncResource`; `ln-runtime/src/async_hooks.rs` owns ids
and the execution context. See [ADR-0009](adr/0009-async-context.md) and
[m6-plan.md](m6-plan.md).

### Not yet

- **M7:** fast paths for the async-hooks crossing, per-socket resources, async frames on by default
- **Non-goals:** native addons (N-API), `vm`, `cluster`, `inspector`, full `Intl` — see
  [compat.md](compat.md) §3

`require()` of an ES module is rejected with `ERR_REQUIRE_ESM`; use `import()`.

## 2. Repo layout

```
crates/
  ln-cli/        `onde` binary: args, budget flags, eval vs file       [exists]
  ln-runtime/    isolate bootstrap, host primitives, ESM/CJS loading,
                 loop, errors, worker/proc/signal bridges              [exists]
  ln-engine/     the engine wrapper, the host-owned job queue and the
                 patched entry points (ffi.rs, jobs.rs)                 [exists]
  ln-sched/      microtask/tick scheduler, timers, loop driver, budget [exists]
  ln-modules/    engine-free CJS/ESM resolution, package.json maps,
                 named-export scan                                     [exists]
  ln-io/         tokio pool, fs ops, net/TLS transports, child
                 processes and signals                                [M3/M4/M5]
  ln-http/       sans-io HTTP/1.1 codec: framing and limits            [M4]
  ln-crypto/     hash/HMAC/HKDF/random, engine-free and tokio-free     [M3]
  ln-zlib/       gzip/deflate + crc32, engine-free and tokio-free      [M4]
  ln-sqlite/     SQLite connections/statements/backup, engine-free     [after M7]
  ln-error/      errno→code and message tables                         [M3]
js/
  bootstrap.js   install order: host, events/process, globals, hooks
  lib/           path, url, util, events, assert, buffer, os, console,
                 querystring, punycode, string_decoder, textcodec,
                 module, process, loader, fs, fs-promises, internal/fs,
                 stream, stream-promises, crypto, tty, perf_hooks,
                 net, internal/net, http, https, internal/http, tls,
                 dns, zlib, sqlite, child_process, internal/pipe,
                 worker_threads, internal/worker, readline,
                 readline-promises, async_hooks, test
test/
  conformance/   253 cases: scheduler (M1), modules, stdlib,
                 fs, stream, zlib, sqlite, net, http, https,
                 child_process, workers, readline, async_hooks, divergences
  js/            stdlib tests (run under node and onde) + Node oracles
  smoke/         generated 30-package CJS + 10-package ESM set
  programs/      cat, wc -l, cp -r as real programs (M3 acceptance)
  net/           throughput, interop, fd-leak, slow-loris, cold start (M4)
  proc/          M5 acceptance: children, workers, Atomics, signals
  async/         M6 acceptance: ALS matrix (96 cells), hook semantics,
                 1M-promise retention
  stress/        RSS across timer create/clear
tuckbox/         a small npm, in TypeScript, running on onde           [demo]
vendor/          rquickjs-sys 0.14.0 + patched quickjs-ng 0.17.0        [M6]
                 job-queue-hook.patch, README (pin + rebase procedure)
```

## 3. Build and test

```sh
cargo test --all                                # 550 tests across the crates
cargo build -p ln-cli --no-default-features     # no node:sqlite/node:zlib (clear error on require)
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

./test/conformance/run.sh                       # 253/253 corpus cases against target/debug/onde
RUN=node ./test/conformance/run.sh              # prove the expectations still describe Node
./test/differential.sh                          # node vs onde, same stdout + exit code (239)
./test/smoke/run.sh                             # 30 CJS + 10 ESM packages, node vs onde
./test/js/run.sh                                # 85 stdlib suites under node and onde + oracles
./test/proc/run.sh                              # M5 acceptance: children, workers, signals
./test/async/run.sh                             # M6 acceptance: ALS matrix, hooks, 1M promises
./test/ffi/run.sh                               # M10 acceptance: C fixture, layout oracle, JS matrix, gates
FULL=1 ./test/proc/run.sh                       # the 1M worker round-trip benchmark
./test/programs/run.sh                          # cat, wc -l, cp -r (M3 acceptance)
./test/stress/run.sh                            # RSS flat across 200k timer create/clear
./test/net/run.sh                               # M4 acceptance: bench, interop, fdleak, slowloris
node test/bench/run.js                          # node vs onde: compute, codecs, stdlib (rebuilds release)
node test/net/coldstart.js target/release/onde  # 25 spawns per expression, median
```

The README's comparison table comes from those three: `coldstart.js` for boot, `bench.sh` for HTTP
(with `ONDE_RELEASE="$(command -v node)"` to point the same harness at another runtime), and
`bench/run.js` for compute.

`crates/ln-runtime/build.rs` minifies `js/` into `OUT_DIR/js` before the Rust sources embed it:
every file is parsed as a classic script, compressed with oxc, and emitted without name mangling.
The readable sources and `test/js/run.sh` are unchanged; `ONDE_NO_MINIFY=1` bundles them verbatim
when a minifier change needs bisecting. `cargo build` therefore needs no network after the first
fetch, and a normal build sees the readable files again. Stack frames that point *into* the stdlib
name minified lines; frames in user code keep their file, line and column.

`tuckbox` has its own harness: `cd tuckbox && pnpm install && pnpm test` runs every suite under
both node and onde (see [tuckbox/README.md](../tuckbox/README.md)).

### What each harness is for

- **conformance/** is the contract: a case is a script plus the `.expected` file recorded from
  Node, compared byte-for-byte on stdout plus the exit code.
- **differential.sh** runs the same cases against both binaries and diffs the results, so an
  expectation cannot drift into "whatever onde does".
- **js/** holds the stdlib unit suites and the Node oracles the expectations were derived from.
- **smoke/** generates 30 CommonJS and 10 ESM packages and resolves them under both runtimes.
- **net/** is the M4 acceptance set; `NET_BENCH_SOFT=1` makes its performance rows informational,
  which is the mode CI uses.
- **proc/** is the M5 acceptance set: every case runs under node and under onde; the worker echo
  case runs 20k round-trips by default and 1M with `FULL=1`.
- **ffi/** builds a C shared library and a layout oracle with the system compiler, runs the
  `onde:ffi` matrix (there is no Node equivalent, so nothing is diffed), and checks the
  `--no-default-features` and `ffi.load` gates. It needs `libffi-dev` on Linux.

### Why the corpus compares stdout and the exit code, not stderr

V8 and QuickJS frame text differ (`Module._compile` vs `<eval>`) even when the header and the error
body match, so stderr is asserted by the renderer unit tests and the CLI end-to-end tests instead of
being byte-diffed against Node.

Cases that mix a clamped 0 ms timer with `setImmediate` depend on whether the timer is already
due when the loop starts — wall-clock timing in Node and in onde. `divergences/d04` carries a
`.nodiff` marker and asserts the byte set rather than the order; the Node self-test and the
differential harness skip it. The ordering rule itself is asserted by the non-racing cases
(ADR-0003 §5).

## 4. Engine and toolchain

The engine is `rquickjs` 0.14's vendored quickjs-ng, so a C toolchain is required (`cc`/`clang`).
CI runs on macOS and Linux, re-validates the corpus against Node on every push, and runs the
differential, smoke and stdlib harnesses.

## 5. Reading order

1. [roadmap.md](roadmap.md) — milestones, exit criteria, sequencing, risks.
2. [m4-plan.md](m4-plan.md) — the milestone just closed: host boundary, WP ownership,
   exit criteria. [ffi-guide.md](ffi-guide.md) is the user-facing `onde:ffi` guide.
3. [m5-plan.md](m5-plan.md) — the milestone being planned: process/worker host boundary, work
   packages, tests, divergences.
4. [adr/0008-processes-and-threads.md](adr/0008-processes-and-threads.md) — the M5 structural
   decision: one isolate per thread, serialized messages plus a shared-memory pointer table.
5. [adr/0006-handles-and-events.md](adr/0006-handles-and-events.md) — ops vs handles, the
   structural M4 decision.
6. [adr/0007-http-codec.md](adr/0007-http-codec.md) — why the HTTP parser is a sans-io Rust state
   machine.
7. [adr/0002-microtask-scheduler.md](adr/0002-microtask-scheduler.md) — the scheduler redesign
   (the load-bearing decision).
8. [adr/0003-event-loop.md](adr/0003-event-loop.md) — loop phases, timers, I/O offload.
9. [adr/0004-module-system.md](adr/0004-module-system.md) — ESM/CJS, interop, resolver.
10. [architecture.md](architecture.md) — component map, crate graph, boot sequence.
11. [adr/0001-engine-baseline.md](adr/0001-engine-baseline.md) — why quickjs-ng, how it is pinned
    and patched.
12. [compat.md](compat.md) — API matrix and known divergences.
13. [tuckbox.md](tuckbox.md) — the demo that exercises all of it: a package installer on onde.
