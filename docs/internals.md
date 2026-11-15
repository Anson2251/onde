# Internals and reference

The inventory, the repository layout, and the harnesses. The overview, the numbers and the pitch
are in the [README](../README.md); per-module compatibility and every deliberate divergence are in
[compat.md](compat.md); the milestones are in [roadmap.md](roadmap.md).

## 1. What runs today

### Runtime and scheduler

- [`lite <file>`](../crates/ln-cli/src/main.rs), `lite -e '<script>'`, `--check`, `--help`,
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

### Globals

`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`,
`EventTarget`, `Event`, `DOMException`, `structuredClone`, `atob`/`btoa`, `global`.

### Diagnostics

`lite --check`, Node-shaped resolution errors with `code` (`MODULE_NOT_FOUND`,
`ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_REQUIRE_ESM`, …), and uncaught-error
rendering shared by scripts and modules.

### Not yet

- **M5:** `child_process`, `worker_threads`, `readline`
- **M6:** `async_hooks`/`AsyncLocalStorage` across `await`
- **Non-goals:** native addons (N-API), `vm`, `cluster`, `inspector`, full `Intl` — see
  [compat.md](compat.md) §3

`require()` of an ES module is rejected with `ERR_REQUIRE_ESM`; use `import()`.

## 2. Repo layout

```
crates/
  ln-cli/        `lite` binary: args, budget flags, eval vs file       [exists]
  ln-runtime/    isolate bootstrap, host primitives, ESM/CJS loading,
                 loop, errors                                          [exists]
  ln-engine/     safe wrapper over the engine + the job pump step      [exists]
  ln-sched/      microtask/tick scheduler, timers, loop driver, budget [exists]
  ln-modules/    engine-free CJS/ESM resolution, package.json maps,
                 named-export scan                                     [exists]
  ln-io/         tokio pool, fs ops, the net/TLS transports            [M3/M4]
  ln-http/       sans-io HTTP/1.1 codec: framing and limits            [M4]
  ln-crypto/     hash/HMAC/HKDF/random, engine-free and tokio-free     [M3]
  ln-zlib/       gzip/deflate + crc32, engine-free and tokio-free      [M4]
  ln-error/      errno→code and message tables                         [M3]
  ln-sys/        bindgen FFI for vendored, patched quickjs-ng          [M6]
js/
  bootstrap.js   install order: host, events/process, globals, hooks
  lib/           path, url, util, events, assert, buffer, os, console,
                 querystring, punycode, string_decoder, textcodec,
                 module, process, loader, fs, fs-promises, internal/fs,
                 stream, stream-promises, crypto, tty, perf_hooks,
                 net, internal/net, http, https, internal/http, tls,
                 dns, zlib
test/
  conformance/   202 cases: scheduler (M1), modules, stdlib,
                 fs, stream, zlib, net, http, https, divergences
  js/            stdlib tests (run under node and lite) + Node oracles
  smoke/         generated 30-package CJS + 10-package ESM set
  programs/      cat, wc -l, cp -r as real programs (M3 acceptance)
  net/           throughput, interop, fd-leak, slow-loris, cold start (M4)
  stress/        RSS across timer create/clear
tuckbox/         a small npm, in TypeScript, running on onde           [demo]
vendor/          quickjs-ng fork + rquickjs-sys patch queue            [M6]
```

## 3. Build and test

```sh
cargo test --all                                # 335 tests across the crates
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

./test/conformance/run.sh                       # 202/202 corpus cases against target/debug/lite
RUN=node ./test/conformance/run.sh              # prove the expectations still describe Node
./test/differential.sh                          # node vs lite, same stdout + exit code (191)
./test/smoke/run.sh                             # 30 CJS + 10 ESM packages, node vs lite
./test/js/run.sh                                # 61 stdlib suites under node and lite + oracles
./test/programs/run.sh                          # cat, wc -l, cp -r (M3 acceptance)
./test/stress/run.sh                            # RSS flat across 200k timer create/clear
./test/net/run.sh                               # M4 acceptance: bench, interop, fdleak, slowloris
node test/bench/run.js                          # node vs onde: compute, codecs, remaining stdlib
node test/net/coldstart.js target/release/lite  # 25 spawns per expression, median
```

The README's comparison table comes from those three: `coldstart.js` for boot, `bench.sh` for HTTP
(with `LITE_RELEASE="$(command -v node)"` to point the same harness at another runtime), and
`bench/run.js` for compute.

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

### Why the corpus compares stdout and the exit code, not stderr

V8 and QuickJS frame text differ (`Module._compile` vs `<eval>`) even when the header and the error
body match, so stderr is asserted by the renderer unit tests and the CLI end-to-end tests instead of
being byte-diffed against Node.

Cases that mix a clamped 0 ms timer with `setImmediate` depend on whether the timer is already
due when the loop starts — wall-clock timing in Node and in lite. `divergences/d04` carries a
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
   exit criteria.
3. [adr/0006-handles-and-events.md](adr/0006-handles-and-events.md) — ops vs handles, the
   structural M4 decision.
4. [adr/0007-http-codec.md](adr/0007-http-codec.md) — why the HTTP parser is a sans-io Rust state
   machine.
5. [adr/0002-microtask-scheduler.md](adr/0002-microtask-scheduler.md) — the scheduler redesign
   (the load-bearing decision).
6. [adr/0003-event-loop.md](adr/0003-event-loop.md) — loop phases, timers, I/O offload.
7. [adr/0004-module-system.md](adr/0004-module-system.md) — ESM/CJS, interop, resolver.
8. [architecture.md](architecture.md) — component map, crate graph, boot sequence.
9. [adr/0001-engine-baseline.md](adr/0001-engine-baseline.md) — why quickjs-ng, how it is pinned
   and patched.
10. [compat.md](compat.md) — API matrix and known divergences.
11. [tuckbox.md](tuckbox.md) — the demo that exercises all of it: a package installer on onde.
