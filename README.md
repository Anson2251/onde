# onde

A Node-compatible JavaScript runtime: QuickJS as the engine, Rust as the host.

onde runs the code around the work: CLIs, build steps, config, request handlers with light logic,
the plugin layer inside another tool. It speaks Node's module system (`require`, `import`,
`node_modules`, `exports` maps), its core modules (`fs`, `stream`, `net`, `http`, `https`, `tls`,
`dns`, `zlib`) and its globals, and it installs as a 4.9 MB binary.

> Naming: the project is onde. The `ln-*` crates and the `lite` binary keep their old names, so the
> commands below still say `target/debug/lite`.

Status: M0 through M4 are done and M5 is next. Two M4 targets are still missed, HTTP throughput and
the memory held by half-open connections; [docs/m4-plan.md](docs/m4-plan.md) §8 has both.

## Roadmap

| Milestone | Adds | Why |
|---|---|---|
| M0 to M2, done | engine binding, scheduler and timers, CommonJS and ESM, `process`, stdlib tier 0 | nothing runs before these |
| M3, done | `fs`, streams, `crypto`, `perf_hooks`, real stdio | files and streams are where a CLI spends its time |
| M4, done | `net`, `http`/`https`, `tls`, `dns`, `zlib` | the server case, and what tuckbox needs |
| M5, next | `child_process`, `worker_threads` with shared memory and `Atomics`, `readline` | tools that shell out, and work that leaves the main thread |
| M6 | `async_hooks` and `AsyncLocalStorage` across `await`, on a host-owned job queue | request-scoped state without passing a context through every call |
| M7 | bytecode snapshot at build time, allocation fast paths, memory limits, `--trace-events`, a `node:test` runner | closes the startup, throughput and memory gap measured below |
| M8 | compatibility sweep, packaging, publish | 1.0 |

## What you trade

Measured on one machine (M3 MacBook Air, macOS arm64) on 2026-11-14, with onde on a release build,
Node 26.10.0 and Bun 1.3.10. Cold start and HTTP are medians of three runs of the same script; the
compute figures are medians of five repetitions per workload. Harnesses: `test/net/bench.sh`,
`test/net/coldstart.js` and `test/bench/run.js`, all in the repo.

| metric | onde | Node 26 | Bun 1.3 |
|---|---|---|---|
| install size | 4.9 MB | 76 MB | 58 MB |
| cold start, `-e '1+1'` | 10.8 ms | 82.0 ms | 6.9 ms |
| cold start, `require("http")` | 19.0 ms | 84.3 ms | 13.6 ms |
| peak RSS, hello HTTP server | 9.3 MB | 44.3 MB | 38.1 MB |
| HTTP throughput, 100 keep-alive connections | 13.4k req/s | 29.9k req/s | 32.1k req/s |
| HTTP p99 at that load | 42.5 ms | 6.6 ms | 5.9 ms |

onde ships as one 4.9 MB binary against a 76 MB Node install, and it holds a fifth of the memory
for the same server. Startup is not where onde wins: Bun opens in 6.9 ms against onde's 10.8, and
that gap will stay, because QuickJS has an engine to initialize as well. What changes a deployment
is the resident figure: at 9 MB per process, embedding a runtime costs less than the tool around
it, and a hundred of them take 930 MB where a hundred Node processes would need 4.4 GB.

The cost is on the hot path. At 100 keep-alive connections onde carries about 45% of Node's
requests per second, and the tail is much worse (42.5 ms p99 against 6.6) because every connection
queues behind one thread.

Pure JavaScript is where the gap widens. Five compute benchmarks run between 2.2x and 18x slower
than Node on this machine, with a median of 4.9x: string building 2.2x, sorting 3.1x, JSON 4.9x,
recursive calls 9.3x, object churn 18x. QuickJS has no JIT and no generational nursery, so
allocation-heavy code pays the most.

For a CLI, a build step or a request handler with light logic, that is decent. For a bundler, a
minifier or a 10 MB JSON transform, it is the wrong runtime.

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
--no-audit --no-fund`, onde on a release build and npm 11.19.1. The rebuild row is `"$onde"
"$tuckbox" ci` on that tree, with the store warm.

| | tuckbox on onde | `npm install` |
|---|---|---|
| wall time | 0.40 s | 0.44 s |
| peak RSS | 21 MB | 108 MB |
| rebuild from the store | 0.04 s, 10 MB | |

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
| next | `child_process`, `worker_threads`, `readline` (M5); `async_hooks` (M6) |

Per-module detail and all 47 deliberate divergences are in [docs/compat.md](docs/compat.md). The
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

The decisions behind the structure (scheduler, event loop, module system, handles, HTTP codec) are
in [docs/adr/](docs/adr/), and [internals.md](docs/internals.md) §5 gives the reading order.
