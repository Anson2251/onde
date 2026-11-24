# onde

A Node-compatible JavaScript runtime: QuickJS as the engine, Rust as the host.

onde runs the code around the work: CLIs, build steps, config, request handlers with light logic,
the plugin layer inside another tool. It speaks Node's module system (`require`, `import`,
`node_modules`, `exports` maps), its core modules (`fs`, `stream`, `net`, `http`, `https`, `tls`,
`dns`, `zlib`, `child_process`, `worker_threads`) and its globals, and it installs as a 5.5 MB
binary.

> Naming: the project is onde. The `ln-*` crates and the `lite` binary keep their old names, so the
> commands below still say `target/debug/lite`.

Status: M0 through M7 are done; M8 is next. M7 added the build-time bootstrap snapshot, the
diagnostics flags (`--trace-events`, `--timing`, `--trace-gc`), heap limits and a `node:test` runner,
and fixed an idle socket that held 64 KiB of read buffer — the half-open case went from 156 MB to
41 MB at 2,000 connections. One measured gap is recorded rather than closed: HTTP throughput is
0.45x of Node in one isolate. The half-open case went from 67 MB to 45 MB: the server stopped
building a session, and its timers, for a connection that never sent a byte. [docs/m7-plan.md](docs/m7-plan.md) is the record.

M6 is the milestone that changes the engine: quickjs-ng
is now vendored and patched (`vendor/`, 0.17.0 plus a ~260-line job-queue patch), the host owns the
microtask queue, and `async_hooks`/`AsyncLocalStorage` propagate across `await`, `then`, ticks,
microtasks, timers, `fs` callbacks and async function bodies. A 96-cell propagation matrix runs
against Node 26 in `test/async/`; the scheduler corpus stayed byte-identical.
[docs/m6-plan.md](docs/m6-plan.md) records the contract and its outcome,
[docs/adr/0009](docs/adr/0009-async-context.md) the engine/host boundary. Two M4 targets are still
missed, HTTP throughput and the memory held by half-open connections;
[docs/m4-plan.md](docs/m4-plan.md) §8 has both. Standalone builds landed ahead of M7: `ondec`
bundles an app and links it with the runtime into one executable, see
[One executable](#one-executable).

## Roadmap

| Milestone | Adds | Why |
|---|---|---|
| M0 to M2, done | engine binding, scheduler and timers, CommonJS and ESM, `process`, stdlib tier 0 | nothing runs before these |
| M3, done | `fs`, streams, `crypto`, `perf_hooks`, real stdio | files and streams are where a CLI spends its time |
| M4, done | `net`, `http`/`https`, `tls`, `dns`, `zlib` | the server case, and what tuckbox needs |
| M5, done | `child_process`, `worker_threads` with shared memory and `Atomics`, `readline`, process signals | tools that shell out, and work that leaves the main thread |
| M6, done | `async_hooks` and `AsyncLocalStorage` across `await`, on a host-owned job queue; the engine is vendored and patched | request-scoped state without passing a context through every call |
| M7, done | a build-time bootstrap snapshot, `--trace-events`/`--timing`/`--trace-gc`, `--max-old-space-size` with worker limits, a `node:test` runner, and an idle socket that no longer holds 64 KiB of read buffer; standalone builds landed early (`ondec`) | startup, per-connection memory and diagnostics; the HTTP tail is left to 1.1 |
| M8 | compatibility sweep, packaging, publish | 1.0 |

## What you trade

Measured on one machine (M3 MacBook Air, macOS arm64) on 2026-11-24, release build, Node 26.12.1
and Bun 1.3.10; the onde column was re-measured after M7 on the same machine with `lowpowermode`
off and a load average near 5, which is why the three runtimes reproduce their earlier figures while
onde's moved. Cold start and HTTP are medians of three (HTTP: 100 keep-alive connections, 20 warm-up
+ 200 measured requests each); compute is medians of five repetitions per workload. Harnesses:
`test/net/bench.sh`, `test/net/coldstart.js` and `test/bench/run.js`. Peak RSS is the one figure not
re-measured: this machine's sampler falls back to `footprint`, whose 1 MB granularity cannot resolve
the change (an M7 soak of the same server peaked at 8.0 MB).

### Footprint

| metric | onde | Node 26 | Bun 1.3 |
|---|---:|---:|---:|
| install size | 5.5 MB | 77 MB | 58 MB |
| cold start, `-e '1+1'` | 11.6 ms | 92.9 ms | 8.0 ms |
| cold start, `require("http")` | 18.4 ms | 94.2 ms | 15.5 ms |
| peak RSS, hello HTTP server | 9.3 MB | 44.2 MB | 33.2 MB |
| 100 processes, same server (derived) | 927 MB | 4.42 GB | 3.32 GB |
| embedded JS stdlib | 581 KB from 925 KB source (540 KB of module source + a 41 KB compiled bootstrap) | — | — |

At 9.3 MB resident, a hundred onde processes cost less than the tool around them; the same
hundred Node processes need 4.42 GB. Startup is not the win: Bun opens in 8.0 ms against onde's
11.6, and QuickJS has an engine to initialize either way.

### Hot path

| metric | onde | Node 26 | Bun 1.3 |
|---|---:|---:|---:|
| HTTP throughput, 100 keep-alive connections | 13.2k req/s | 30.0k req/s | 29.5k req/s |
| HTTP p50 | 0.45 ms | 3.19 ms | 3.20 ms |
| HTTP p99 | 45.7 ms | 6.8 ms | 6.4 ms |
| share of Node's requests/s | 44% | 100% | 98% |

The p50 is lower than Node's because onde's requests are cheap; the tail is much worse because
every connection queues behind one isolate thread. That is the single-isolate ceiling, not the
async-hooks plumbing (which costs nothing for a server that never loads `async_hooks`), and it is
why M7 closed the diagnostics and memory criteria but left this one recorded: M7 took the p99 from
52.5 ms to 45.7 ms and the throughput from 12.9k to 13.2k req/s, which is allocation work, not an
architecture change. A second isolate is a 1.1 item.

### Pure JavaScript

| workload | Node 26 | onde | ratio |
|---|---:|---:|---:|
| string building | 22.5 ms | 43.0 ms | 1.9x |
| sort 200k | 30.2 ms | 91.2 ms | 3.0x |
| JSON 5×100k | 171.0 ms | 779.0 ms | 4.6x |
| fib(30) | 6.0 ms | 55.8 ms | 9.3x |
| object churn 300k | 2.7 ms | 49.9 ms | 18.5x |

Median 4.6x. QuickJS has no JIT and no generational nursery, so allocation-heavy code pays the
most. For a CLI, a build step or a request handler with light logic that is decent; for a
bundler, a minifier or a 10 MB JSON transform it is the wrong runtime.

## Try it

```sh
cargo build
./target/debug/lite -e '1+1'                 # 2
./target/debug/lite hello.js                 # CommonJS entry
./target/debug/lite main.mjs                 # ES module (TLA, import.meta)
./target/debug/lite --check main.mjs         # parse without running
```

```js
// hello.js
const path = require("path");
const { EventEmitter } = require("events");
console.log(path.join("a", "b"));
process.nextTick(() => console.log("tick"));
Promise.resolve().then(() => console.log("then"));
setTimeout(() => console.log("timer"), 0);
```

## One executable

`ondec` packages an app as a single program: it bundles the sources with rolldown, compiles every
module to QuickJS bytecode, and links the payload against a static runtime library. The result needs
neither `lite` nor Node, `node_modules`, the sources or the SDK at run time.

```sh
# In the onde checkout: the tool, and the SDK for this machine.
cargo build --release -p ondec
./scripts/build-sdk.sh                        # onde.h + libonde-<tuple>.a, prints the path
sdk=$(ls -d dist/sdk/*/* | tail -1)           # dist/sdk/0.1.0/<tuple>

# Anywhere: bundle a project into one executable.
target/release/ondec build ~/app/src/main.js --sdk "$sdk" -o ~/app/app
```

`cargo install --path crates/ondec` puts the tool on `PATH` if you would rather not type the
checkout's path.

> **Alpha.** Fetching the SDK is a release-stage feature: once the first alpha publishes `onde.h`
> and the `libonde-<tuple>.a` cells as GitHub release assets, `ondec build` downloads and verifies
> them by itself and `--sdk` becomes optional. There are no release assets yet, so `--sdk` is
> required and the SDK is built locally with the script above.

The tool does the work in order: bundle with rolldown (in-process, so TypeScript, JSX, `require`
and `node_modules` all work at build time), compile every output module to bytecode, encode a
payload (header, table, bodies), write a temporary C file, link it with the cell's archive, strip,
optionally sign. None of that machinery ends up in the app: it is the runtime plus its modules, and
a generated C file that hands the payload over.

Sizes and startup, measured 2026-11-23 on the same machine as *What you trade* (macOS arm64,
release build):

| app | executable | cold start |
|---|---|---|
| hello world (210 B payload) | 4.8 MB | 18 ms |
| [vibe-cpc](https://github.com/Anson2251/vibe-cpc) (1.1 MiB payload) | 6.0 MB | 25 ms (Node: 105 ms) |
| 34,000-function module (4.3 MiB payload) | 9.4 MB | 26 ms |
| the same, `--compress zstd:19` (543 KiB payload) | 5.4 MB | 29 ms |

A compiled app never parses its sources: a 1.9 MiB module loads from bytecode in about 5 ms where
`lite` needs about 790 ms to parse it. A hello-world app is also smaller than the interpreter that
produced it — 4.8 MB against `lite`'s 5.5 MB — because only the runtime code the app reaches is
linked in.

Compression buys size, not speed. `--compress` takes `none` (the default), `zlib`, or
`zstd[:level]`: zlib costs nothing because the runtime already links it for `node:zlib`, while zstd
compresses better and decodes faster but adds a 249 KB decoder to every image.

Cross-building is explicit: `--target <tuple>` names the cell, and `--cc` or `CC_<tuple>` names the
compiler (`gcc`, `clang`, `zig cc`, `cl`) — a non-host target is never compiled with the host's
`cc` by default. `--print-command` prints the link line instead of running it, and `--packager
wrappe` stages the same bundle for a self-extracting binary when there is no C toolchain at all.

The payload format, the cell matrix and the parts still open are in
[docs/standalone-build.md](docs/standalone-build.md).

## Tuckbox

`tuckbox/` is a small npm: TypeScript, compiled to CommonJS, and run by onde. Every module it uses
is one onde implements, so it exercises the runtime the way a real tool would.

```sh
cd tuckbox && pnpm install && pnpm build
onde=$PWD/../target/debug/lite
tuckbox=$PWD/bin/tuckbox.js

mkdir /tmp/app && cd /tmp/app
printf '{"name":"app","dependencies":{"debug":"^4.3.0"}}' > package.json
"$onde" "$tuckbox" install
"$onde" "$tuckbox" ls
```

`install`, `ci`, `add`, `remove` and `ls`. Tarballs are checked against `dist.integrity`, unpacked
once into a content-addressed store, and hardlinked into `node_modules`. A package is nested only
where two versions genuinely conflict, so the tree resolves the same way under node and onde.

The install numbers come from `/usr/bin/time -l` on an empty cache in a fresh directory, for the
same two packages (`debug`, `ms`): `"$onde" "$tuckbox" install` against `npm install
--no-audit --no-fund`, onde on a release build and npm 11.20.0. The rebuild row is `"$onde"
"$tuckbox" ci` on that tree, with the store warm.

| | tuckbox on onde | `npm install` |
|---|---|---|
| wall time | 0.23 s | 0.44 s |
| peak RSS | 21 MB | 107 MB |
| rebuild from the store | 0.03 s, 10 MB | |

`pnpm test` in `tuckbox/` runs every suite under node and under onde and compares the output;
`TUCKBOX_NET=1 pnpm test` adds the suite that installs real packages from the registry. It skips
lifecycle scripts, `.bin` links, peer and native dependencies, and the full scope is in
[docs/tuckbox.md](docs/tuckbox.md).

The real npm gets further than a demo usually does: `lite "$(command -v npm)" --help` prints npm
11.20's help with no version warning. A command that walks the tree, `npm ls`, stops at
`node:diagnostics_channel`, which [docs/compat.md](docs/compat.md) lists as a 1.1 candidate. That
is the honest line: the CLI loads and runs, the module it needs for real work is not there yet.

## What's in the box

| Layer | What's there |
|---|---|
| runtime | `console`, `process`, timers, `queueMicrotask`, Node-style uncaught errors |
| modules | CommonJS and native ESM, `node_modules` walking, `exports`/`imports` maps, ESM to CJS interop |
| M2 stdlib | `path`, `url`, `util`, `events`, `assert`, `buffer`, `string_decoder`, `os`, `console`, `querystring`, `punycode`, `module`, `constants` |
| M3 I/O | `fs`, `fs/promises`, `stream`, `stream/promises`, `crypto`, `perf_hooks`, `tty`, real stdio |
| M4 network | `net`, `http`, `https`, `tls`, `dns`, `zlib` |
| M5 processes and threads | `child_process`, `worker_threads` with `SharedArrayBuffer`/`Atomics`, `readline`, signals |
| M6 async context | `async_hooks`, `AsyncLocalStorage`, `AsyncResource`, `--async-stack-traces` |
| next | performance and diagnostics (M7) |

Per-module detail and all 52 deliberate divergences are in [docs/compat.md](docs/compat.md). The
full inventory, repo layout and every harness are in [docs/internals.md](docs/internals.md).

## Why

Node's cost comes from V8's memory floor, an install-time dependency graph, and libuv's surface.
For CLIs, edge handlers, build scripts and embedded scripting, what matters is Node's semantics
(module system, `process`, timers, streams, `fs`) and its API shape. The engine underneath is the
part you can replace.

QuickJS gives a 1 MB engine with ES2023-level language support and fast startup, but no runtime
around it. There is no event loop, no timers, no module loading from disk, no `process`, and the
microtask queue has to be re-hosted carefully. Those are what this repository builds.

onde is Node-compatible, not byte-identical. Native addons (N-API), `vm`, `cluster`, `inspector`
and full `Intl` are absent, and each isolate runs on one thread with deterministic scheduling and
an explicit microtask model.

## Where to read next

1. [docs/internals.md](docs/internals.md) for what runs today, the repo layout and every harness.
2. [docs/compat.md](docs/compat.md) for the API matrix and the deliberate divergences.
3. [docs/roadmap.md](docs/roadmap.md) for milestones, exit criteria and sequencing.
4. [docs/architecture.md](docs/architecture.md) for the component map and boot sequence.
5. [docs/tuckbox.md](docs/tuckbox.md) for the demo: a package installer on onde.
6. [docs/standalone-build.md](docs/standalone-build.md) for packaging an app as one executable.

The decisions behind the structure (scheduler, event loop, module system, handles, HTTP codec) are
in [docs/adr/](docs/adr/), and [internals.md](docs/internals.md) §5 gives the reading order.
