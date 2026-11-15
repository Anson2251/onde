# onde

A small, embeddable Node-shaped JavaScript runtime: **QuickJS (quickjs-ng) as the engine, Rust as
the host**.

onde is for the code around the work: CLIs, build steps, config, request handlers with light
logic, and the plugin layer inside another tool. It speaks Node's module system (`require`,
`import`, `node_modules`, `exports` maps), its core modules (`fs`, `stream`, `net`, `http`,
`https`, `tls`, `dns`, `zlib`) and its globals — without a JIT, a 40 MB resident floor, or a
V8-sized install.

> **Naming:** the project is now **onde**. The `ln-*` crates and the `lite` binary keep
> their names for now, so build commands below still use `target/debug/lite`.

Status: **M3 complete** (2026-11-13), **M4 in progress** (2026-11-14). `lite` runs CommonJS and
native ES modules, resolves `node_modules` and `exports` maps, ships the Node core stdlib tier 0
(`process`, `path`, `url`, `util`, `events`, `assert`, `buffer`, `string_decoder`, `os`, `console`,
`querystring`, `punycode`, `module`), the M3 I/O core (`fs`, `fs/promises`, `stream`,
`stream/promises`, `crypto`, `perf_hooks`, `tty`, real stdio), and the globals Node provides
(`URL`, `TextEncoder`, `AbortController`, `EventTarget`, `structuredClone`). M4 has landed `net`,
`http`, `https`, `tls`, `dns` and `zlib`: TCP and Unix sockets, an HTTP/1.1 server and client with
keep-alive, chunking and `Agent`, TLS through rustls with real certificate verification and ALPN,
`dns.lookup` over the OS resolver, and whole-buffer gzip/deflate with `crc32`. The acceptance
harnesses (throughput, interop, fd and slow-loris) are landing as the milestone closes — see
[docs/m4-plan.md](docs/m4-plan.md),
[ADR-0006](docs/adr/0006-handles-and-events.md) and
[ADR-0007](docs/adr/0007-http-codec.md). The roadmap is [docs/roadmap.md](docs/roadmap.md); the M3
contract is [docs/m3-plan.md](docs/m3-plan.md).

## Where it sits

One machine (M3 Macbook Air), release build, median of 25 runs, every row measured the same way
(2026-11-14):

| | onde | Node 26 | Bun 1.3 |
|---|---|---|---|
| install size | **4.8 MB** | 76 MB | 58 MB |
| cold start, `lite -e '1+1'` | 12.3 ms | 89.4 ms | **8.4 ms** |
| cold start, `require("http")` | 22.2 ms | 89.4 ms | — |
| peak RSS, hello HTTP server | **8.6 MB** | 42.4 MB | 30.1 MB |

Bun boots faster than onde does, and this README is not going to pretend otherwise: at this size
startup is table stakes, not the product. The claim is **footprint per process** — 5 MB and 8.6 MB
against 58–76 MB and 30–42 MB. That is the difference between a runtime you ship to users and one
you can put *inside* something else, and between running ten of them and running hundreds.

The trade is explicit. QuickJS has no JIT, so compute-bound JavaScript runs several times slower
than on V8. onde is not the runtime for a bundler, a minifier, or a 10 MB JSON transform. It is the
runtime for the glue around them — and for putting that glue inside your tool without shipping a
second application alongside it.

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

## Tuckbox

`tuckbox/` is a small npm: TypeScript, compiled to CommonJS, and run by onde. It is the honest test
of the claims above, because everything it executes is `require`, `fs`, `https`, `zlib`, `path` and
`process` - no shortcuts, no native addons.

```sh
cd tuckbox && pnpm install && pnpm build

mkdir /tmp/app && cd /tmp/app
printf '{"name":"app","dependencies":{"debug":"^4.3.0"}}' > package.json
/path/to/lite /path/to/tuckbox/bin/tuckbox.js install
/path/to/lite /path/to/tuckbox/bin/tuckbox.js ls
```

`install`, `ci`, `add`, `remove` and `ls`. Tarballs are verified against `dist.integrity`, unpacked
once into a content-addressed store, and hardlinked into `node_modules` - nested only where two
versions genuinely conflict, which is why the tree resolves identically under node and onde.

Installing the same two packages (`debug`, `ms`) cold, on this machine, tuckbox starting from an
empty cache while npm reused its global one:

| | tuckbox on onde | `npm install` |
|---|---|---|
| wall time | **0.40 s** | 0.58 s |
| peak RSS | **27 MB** | 98 MB |
| rebuild from the store | 0.08 s, 14 MB | — |

Scope and deliberate gaps - no lifecycle scripts, no `.bin` links, no peer or native dependencies -
are in [docs/tuckbox.md](docs/tuckbox.md).

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

Node's cost model is dominated by things an "onde" runtime does not need: V8's memory floor,
an npm-install-time dependency graph, and libuv's surface. For CLIs, edge/serverless
handlers, build scripts and embedded scripting, the useful part of Node is its **semantics**
(module system, `process`, timers, streams, `fs`) and its **API shape**, not its engine.

QuickJS gives a ~1 MB engine with ES2023-level language support and fast startup. What it does
not give is a runtime: no event loop, no timers, no modules on disk, no `process`, and a
microtask queue whose execution model has to be re-hosted carefully (see ADR-0002). Those are
what this repository builds, in that order.

## What "onde" means here

- Same *shape* as Node: `require`, `import`, `process`, `fs`, `path`, `events`, `net`, `http`,
  `worker_threads`, Node-style errors with `code`.
- Not byte-for-byte Node: no native addons (N-API), no `vm`, no `cluster`, no `inspector`,
  no full `Intl`. Divergences are tracked in [docs/compat.md](docs/compat.md).
- One thread per isolate, deterministic scheduling, an explicit microtask model.

## Read in this order

1. [docs/roadmap.md](docs/roadmap.md) — milestones, exit criteria, sequencing, risks.
2. [docs/m4-plan.md](docs/m4-plan.md) — the milestone being worked on: host boundary, WP
   ownership, exit criteria.
3. [docs/adr/0006-handles-and-events.md](docs/adr/0006-handles-and-events.md) — ops vs handles, the
   structural M4 decision.
4. [docs/adr/0007-http-codec.md](docs/adr/0007-http-codec.md) — why the HTTP parser is a sans-io
   Rust state machine.
5. [docs/adr/0002-microtask-scheduler.md](docs/adr/0002-microtask-scheduler.md) — the scheduler
   redesign (the load-bearing decision).
6. [docs/adr/0003-event-loop.md](docs/adr/0003-event-loop.md) — loop phases, timers, I/O offload.
7. [docs/adr/0004-module-system.md](docs/adr/0004-module-system.md) — ESM/CJS, interop, resolver.
8. [docs/architecture.md](docs/architecture.md) — component map, crate graph, boot sequence.
9. [docs/adr/0001-engine-baseline.md](docs/adr/0001-engine-baseline.md) — why quickjs-ng, how it
   is pinned and patched.
10. [docs/compat.md](docs/compat.md) — API matrix and known divergences.

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
  ln-io/         tokio pool, fs ops, the M4 net/TLS transports         [M3/M4]
  ln-http/       sans-io HTTP/1.1 codec: framing and limits            [M4]
  ln-crypto/     hash/HMAC/HKDF/random, engine-free and tokio-free      [M3]
  ln-zlib/       gzip/deflate + crc32, engine-free and tokio-free     [M4]
  ln-error/      NodeError: errno→code and message tables               [M3]
  ln-sys/        bindgen FFI for vendored, patched quickjs-ng          [M6]
js/
  bootstrap.js   install order: host, events/process, globals, hooks
  lib/           path, url, util, events, assert, buffer, os, console,
                 querystring, punycode, string_decoder, textcodec,
                 module, process, loader, fs, fs-promises, internal/fs,
                 stream, stream-promises, crypto, tty, perf_hooks,
                 net, internal/net, http, https, internal/http, tls, dns,
                 zlib
test/
  conformance/   202 cases: scheduler (M1), modules, stdlib,
                 fs, stream, zlib, net, http, https, divergences
  js/            stdlib tests (run under node and lite) + Node oracles
  smoke/         generated 30-package CJS + 10-package ESM set
  stress/        RSS across timer create/clear
vendor/          quickjs-ng fork + rquickjs-sys patch queue             [M6]
```

## Build and test

```sh
cargo test --all                                # 325 tests across the crates
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

./test/conformance/run.sh                       # 202/202 corpus cases against target/debug/lite
RUN=node ./test/conformance/run.sh              # prove the expectations still describe Node
./test/differential.sh                          # node vs lite, same stdout + exit code (191)
./test/smoke/run.sh                             # 30 CJS + 10 ESM packages, node vs lite
./test/js/run.sh                                # 61 stdlib suites under node and lite + oracles
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
