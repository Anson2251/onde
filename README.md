# lite-node

A small, embeddable Node.js-compatible JavaScript runtime: **QuickJS (quickjs-ng) as the engine, Rust as the host**.

Status: **M3 complete** (2026-11-13). `lite` runs CommonJS and native ES modules, resolves
`node_modules` and `exports` maps, ships the Node core stdlib tier 0 (`process`, `path`, `url`,
`util`, `events`, `assert`, `buffer`, `string_decoder`, `os`, `console`, `querystring`, `punycode`,
`module`), the M3 I/O core (`fs`, `fs/promises`, `stream`, `stream/promises`, `crypto`,
`perf_hooks`, `tty`, real stdio), and the globals Node provides (`URL`, `TextEncoder`,
`AbortController`, `EventTarget`, `structuredClone`). Network and async context are next — see
[docs/roadmap.md](docs/roadmap.md), the M3 contract in [docs/m3-plan.md](docs/m3-plan.md) and the
op protocol in [ADR-0005](docs/adr/0005-ops-protocol.md).

## Try it

```sh
cargo build
./target/debug/lite -e '1+1'                 # 2
./target/debug/lite hello.js                 # CommonJS entry
./target/debug/lite main.mjs                 # ES module (TLA, import.meta)
./target/debug/lite --check main.mjs         # syntax check, no execution
./target/debug/lite --help
```

```js
// hello.js — CommonJS
const path = require("path");
const { EventEmitter } = require("events");
console.log(path.join("a", "b"));
process.nextTick(() => console.log("tick"));
Promise.resolve().then(() => console.log("then"));
setTimeout(() => console.log("timer"), 0);
```

```js
// main.mjs — ES module
import path from "node:path";
import { EventEmitter } from "node:events";

export const answer = await Promise.resolve(42);
const events = new EventEmitter();
events.once("ready", (value) => console.log(value, path.sep, import.meta.filename));
events.emit("ready", answer);
```

## Works today (M0 + M1 + M2)

**Runtime and scheduler**

- [`lite <file>`](crates/ln-cli/src/main.rs), `lite -e '<script>'`, `--check`, `--help`, `--version`
- `console.log` → stdout, `console.warn/error` → stderr, Node's `util.format`/`util.inspect`
- `process`: `argv`, `env`, `cwd`/`chdir`, `platform`, `arch`, `version(s)`, `pid`/`ppid`,
  `title`, `exit`/`exitCode`, `nextTick`, `hrtime`/`hrtime.bigint`, `uptime`, `memoryUsage`,
  `emitWarning`, `stdout`/`stderr`/`stdin`, and `on`/`once`/`off` for `exit`, `beforeExit`,
  `uncaughtException`, `unhandledRejection`, `rejectionHandled`, `warning`
- timers (`setTimeout`/`setInterval`/`setImmediate`, clears, `ref`/`unref`/`hasRef`, Node's
  clamp and insertion order) and `queueMicrotask`
- Node-compatible ordering: `nextTick` before promise jobs, unhandled rejections after both
  queues, inline `uncaughtException`, `beforeExit` revival, `process.exit` without draining
- Node-shaped uncaught errors: `file:line`, source line, caret, `Error: message`, frames
- `--max-microtasks N` / `--microtask-timeout MS` guard against unbounded microtask work

**Modules**

- CommonJS: `require`, cache, wrapper (`this === module.exports`), `module.exports`,
  `module.paths`, `require.resolve`/`require.cache`/`require.main`, JSON modules,
  `node_modules` walking (including nested and scoped packages), `package.json`
  `main`/`exports`/`type`
- ES modules: native QuickJS modules with top-level await, live bindings,
  `import.meta.url`/`filename`/`dirname`/`resolve`, dynamic `import()`, and `file:`/`node:`
  specifiers
- `exports`/`imports` maps with conditions (`node`, `import`, `require`, `default`), subpath
  patterns (`./feature/*`), arrays and `null` blocks
- ESM↔CJS interop: `default = module.exports` plus statically scanned named exports; builtins
  are importable as `node:path` or `path`
- `--check` compiles the entry without running it, with Node-shaped file/line/column/caret

**Stdlib tier 0** — `path` (posix + win32), `url` (WHATWG `URL`/`URLSearchParams` + legacy),
`util` (`format`, `inspect`, `promisify`, `inherits`, `types`, `isDeepStrictEqual`), `events`
(`EventEmitter`, `once`, `on`, `errorMonitor`, `captureRejections`), `assert` (+ `assert/strict`),
`buffer`, `string_decoder`, `os`, `console`, `querystring`, `punycode`, `module`.

**Globals** — `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `AbortController`,
`AbortSignal`, `EventTarget`, `Event`, `DOMException`, `structuredClone`, `atob`/`btoa`,
`global`.

**Diagnostics** — `lite --check`, Node-shaped resolution errors with `code`
(`MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_REQUIRE_ESM`,
…), uncaught-error rendering shared by scripts and modules.

Not yet, deliberately: `net`/`http`/TLS (M4); `child_process` and `worker_threads` (M5);
`async_hooks`/`AsyncLocalStorage` across `await` (M6). `require()` of an
ES module is rejected with `ERR_REQUIRE_ESM` (use `import()`); the reasons and the rest of the
tracked differences are in [docs/compat.md](docs/compat.md).

## Why

Node's cost model is dominated by things a "lite" runtime does not need: V8's memory floor,
an npm-install-time dependency graph, and libuv's surface. For CLIs, edge/serverless
handlers, build scripts and embedded scripting, the useful part of Node is its **semantics**
(module system, `process`, timers, streams, `fs`) and its **API shape**, not its engine.

QuickJS gives a ~1 MB engine with ES2023-level language support and fast startup. What it does
not give is a runtime: no event loop, no timers, no modules on disk, no `process`, and a
microtask queue whose execution model has to be re-hosted carefully (see ADR-0002). Those are
what this repository builds, in that order.

## What "lite" means here

- Same *shape* as Node: `require`, `import`, `process`, `fs`, `path`, `events`, `net`, `http`,
  `worker_threads`, Node-style errors with `code`.
- Not byte-for-byte Node: no native addons (N-API), no `vm`, no `cluster`, no `inspector`,
  no full `Intl`. Divergences are tracked in [docs/compat.md](docs/compat.md).
- One thread per isolate, deterministic scheduling, an explicit microtask model.

## Read in this order

1. [docs/roadmap.md](docs/roadmap.md) — milestones, exit criteria, sequencing, risks.
2. [docs/adr/0002-microtask-scheduler.md](docs/adr/0002-microtask-scheduler.md) — the scheduler
   redesign (the load-bearing decision).
3. [docs/adr/0003-event-loop.md](docs/adr/0003-event-loop.md) — loop phases, timers, I/O offload.
4. [docs/adr/0004-module-system.md](docs/adr/0004-module-system.md) — ESM/CJS, interop, resolver.
5. [docs/architecture.md](docs/architecture.md) — component map, crate graph, boot sequence.
6. [docs/adr/0001-engine-baseline.md](docs/adr/0001-engine-baseline.md) — why quickjs-ng, how it
   is pinned and patched.
7. [docs/compat.md](docs/compat.md) — API matrix and known divergences.

## Repo layout

```
crates/
  ln-cli/        `lite` binary: args, budget flags, eval vs file       [exists]
  ln-runtime/    isolate bootstrap, host primitives, ESM/CJS loading,
                 loop, errors                                         [exists]
  ln-engine/     safe wrapper over the engine + the job pump step      [exists]
  ln-sched/      microtask/tick scheduler, timers, loop driver, budget [exists]
  ln-modules/    engine-free CJS/ESM resolution, package.json maps,
                 named-export scan                                    [exists]
  ln-io/         tokio offload pool + fs ops (net/dns/tls in M4,
                 child_process in M5)                                   [M3]
  ln-crypto/     hash/HMAC/HKDF/random, engine-free and tokio-free      [M3]
  ln-error/      NodeError: errno→code and message tables               [M3]
  ln-sys/        bindgen FFI for vendored, patched quickjs-ng          [M6]
js/
  bootstrap.js   install order: host, events/process, globals, hooks
  lib/           path, url, util, events, assert, buffer, os, console,
                 querystring, punycode, string_decoder, textcodec,
                 module, process, loader, fs, fs-promises, internal/fs,
                 stream, stream-promises, crypto, tty, perf_hooks
test/
  conformance/   137 cases: scheduler (M1), modules, stdlib,
                 fs, stream, divergences
  js/            stdlib tests (run under node and lite) + Node oracles
  smoke/         generated 30-package CJS + 10-package ESM set
  stress/        RSS across timer create/clear
vendor/          quickjs-ng fork + rquickjs-sys patch queue             [M6]
```

## Build and test

```sh
cargo test --all                                # 208 tests across the crates
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

./test/conformance/run.sh                       # 137/137 corpus cases against target/debug/lite
RUN=node ./test/conformance/run.sh              # prove the expectations still describe Node
./test/differential.sh                          # node vs lite, same stdout + exit code (127)
./test/smoke/run.sh                             # 30 CJS + 10 ESM packages, node vs lite
./test/js/run.sh                                # 49 stdlib suites under node and lite + oracles
./test/programs/run.sh                          # cat, wc -l, cp -r (M3 acceptance)
./test/stress/run.sh                            # RSS flat across 200k timer create/clear
```

The engine is built from `rquickjs` 0.14's vendored quickjs-ng, so a C toolchain is required
(`cc`/clang). CI runs on macOS and Linux, re-validates the corpus against Node on every push,
and runs the differential, smoke and stdlib harnesses.

The corpus compares ordered stdout plus the exit code. Stderr is asserted by the renderer unit
tests and the CLI end-to-end tests rather than byte-diffed against Node, because V8 and QuickJS
frame text differ (`Module._compile` vs `<eval>`) even when the header and error body match.

Cases that mix a clamped 0 ms timer with `setImmediate` depend on whether the timer is already
due when the loop starts — wall-clock timing in Node and in lite. `divergences/d04` carries a
`.nodiff` marker and asserts the byte set rather than the order; the Node self-test and the
differential harness skip it. The ordering rule itself is asserted by the non-racing cases
(ADR-0003 §5).
