# onde

A Node-compatible JavaScript runtime: QuickJS as the engine, Rust as the host.

onde runs the code around the work: CLIs, build steps, config, request handlers with light logic,
the plugin layer inside another tool. It speaks Node's module system (`require`, `import`,
`node_modules`, `exports` maps), its core modules (`fs`, `stream`, `net`, `http`, `https`, `tls`,
`dns`, `zlib`, `sqlite`, `child_process`, `worker_threads`) and its globals, and installs as a
7.6 MB binary (3.7 MB with every optional module compiled out).

Status: M0–M7 are done; M8, the 1.0 compatibility sweep, packaging and publish, is next.

Contents: [Quick start](#quick-start) · [Building](#building) ·
[What's in the box](#whats-in-the-box) · [Footprint](#footprint) ·
[Performance](#performance) · [One executable](#one-executable) ·
[Milestones](#milestones) · [Compatibility](#compatibility) · [Tuckbox](#tuckbox) ·
[Why](#why) · [Licensing](#licensing) · [Docs](#where-to-read-next)

## Quick start

```sh
cargo build
./target/debug/onde -e '1+1'                 # 2
./target/debug/onde hello.js                 # CommonJS entry
./target/debug/onde main.mjs                 # ES module (TLA, import.meta)
./target/debug/onde --check main.mjs         # parse without running
```

```js
// hello.js
const path = require("path");
console.log(path.join("a", "b"));
process.nextTick(() => console.log("tick"));
Promise.resolve().then(() => console.log("then"));
setTimeout(() => console.log("timer"), 0);
```

`cargo build` builds the workspace; the examples above use the debug `onde` binary. The core
modules are ordinary `require`/`import` targets:

```js
const { Database } = require("node:sqlite");
const db = new Database(":memory:");
db.exec("CREATE TABLE t(v)");
db.prepare("INSERT INTO t VALUES (?)").run("hello");
console.log(db.prepare("SELECT v FROM t").get()); // [Object: null prototype] { v: 'hello' }
```

## Building

Every optional Node module is a Cargo feature, and all of them are on by default:

| feature | module(s) it compiles in | what it links |
|---|---|---|
| `node-net` | `net`, `http`, `dns` | the socket layer and the `ln-http` HTTP/1.1 codec |
| `node-tls` | `tls`, `https` (implies `node-net`) | rustls over `ring`, with the bundled Mozilla roots |
| `node-crypto` | `crypto` | RustCrypto MD5/SHA-1/SHA-2, HMAC and HKDF |
| `node-sqlite` | `node:sqlite` | the bundled SQLite 3.53.2 amalgamation |
| `node-zlib` | `zlib` | zlib |

`zlib-payload` and `zstd-payload` are not modules: they carry the payload decoders a compiled app
needs for `--compress zlib` and `--compress zstd`.

```sh
cargo build                                                         # every module
cargo build --release
cargo build -p ln-cli --no-default-features                         # none of them
cargo build -p ln-cli --no-default-features --features node-net     # sockets, no TLS
cargo build -p ln-cli --no-default-features --features node-tls     # tls implies net
cargo test --all
```

In `onde`, `node-zlib` is the only zlib consumer, so leaving the feature out drops zlib from that
binary. The SDK is different: `ln-embed` enables `zlib-payload` by default so compiled apps can inflate
`--compress zlib` payloads, and `node-zlib` there only adds the module (about 40 KB; zlib is
already present). An SDK archive built without `zlib-payload` refuses a zlib-compressed app with
a message instead of misreading it. A module the build left out fails with its feature named, on
`require` and `import`, instead of a generic unknown-module error:

> node:sqlite is not available: the `node-sqlite` feature is not enabled in this build. Rebuild
> without `--no-default-features` (or with `--features node-sqlite`) to include it.

`./test/features/run.sh` builds the matrix (default, none, each flag alone, and `node-tls` without
`node-net` to prove the implication) and asserts every message. `./test/features/size.sh` prints
the release cost of each flag; the numbers are in [Footprint](#footprint).

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
| M7 diagnostics | bootstrap snapshot, `--trace-events`/`--timing`/`--trace-gc`, `--max-old-space-size`, `node:test` |
| storage (after M7) | `sqlite`/`node:sqlite`: bundled SQLite 3.53.2, `Database`, `Statement`, `Session`/changesets, `SQLTagStore`, user-defined functions/aggregates, authorizer, virtual tables, extensions, `backup`, limits, serialize/deserialize |
| next | compatibility sweep and packaging (M8) |

Per-module detail and all 77 deliberate divergences are in [docs/compat.md](docs/compat.md). The
full inventory, repo layout and every harness are in [docs/internals.md](docs/internals.md).

## Footprint

Measured on one machine (M3 MacBook Air, macOS arm64) on 2026-11-24, release build, Node 26.12.1
and Bun 1.3.10; the onde column was re-measured after M7 and again after `node:sqlite` landed, on
the same machine with `lowpowermode` off and a load average near 5, which is why the three runtimes
reproduce their earlier figures while onde's moved. Cold start is medians of three; compute is
medians of five repetitions per workload. Harnesses: `test/net/bench.sh`,
`test/net/coldstart.js` and `test/bench/run.js`. Peak RSS is the one figure not re-measured: the
machine's sampler falls back to `footprint`, whose 1 MB granularity cannot resolve the change.

| metric | onde | Node 26 | Bun 1.3 |
|---|---:|---:|---:|
| install size, full features (default) | 7.6 MB | 77 MB | 58 MB |
| install size, no optional features | 3.7 MB | — | — |
| cold start, `-e '1+1'` | 11.6 ms | 92.9 ms | 8.0 ms |
| cold start, `require("http")` | 18.4 ms | 94.2 ms | 15.5 ms |
| peak RSS, hello HTTP server | 9.3 MB | 44.2 MB | 33.2 MB |
| 100 processes, same server (derived) | 927 MB | 4.42 GB | 3.32 GB |
| embedded JS stdlib | 617 KB from 984 KB source (575 KB of minified module source + a 42 KB compiled bootstrap) | — | — |

At 9.3 MB resident, a hundred onde processes cost less than the tool around them; the same hundred
Node processes need 4.42 GB. Startup is not the win: Bun opens in 8.0 ms against onde's 11.6, and
QuickJS has an engine to initialize either way.

### Feature flags and what they cost

The baseline is the minimal release build, `--no-default-features` at 3.7 MB; the full build is
7.6 MB. Each figure is what that flag adds on top of the baseline.

| feature | modules it brings back | footprint | what it links |
|---|---|---:|---|
| baseline | core only (`fs`, `stream`, `buffer`, `console`, `path`, `os` …) | 3.7 MB | QuickJS, the runtime core, tokio (fs pool, child_process IPC, signals) |
| `node-zlib` | `zlib` | +106 KB | zlib |
| `node-crypto` | `crypto` | +127 KB | `ln-crypto`: SHA-1, SHA-2, MD5, HMAC, HKDF |
| `node-net` | `net`, `http`, `dns` | +220 KB | the socket layer and the `ln-http` HTTP/1.1 codec |
| `node-tls` | `tls`, `https` | +1.4 MB | rustls, tokio-rustls, `ring`, `webpki-roots`, `rustls-pemfile` |
| `node-sqlite` | `node:sqlite` | +2.1 MB | the bundled SQLite 3.53.2 amalgamation |

The costs add up to the full build, and each is measured as a step on the ladder rather than by
subtracting from the full build, so they are what a size-trimmed build actually pays when the
module comes back. Measured on the same machine and system as the table above (M3 MacBook Air,
macOS arm64), on 2026-11-25, release profile with thin LTO. The byte-level figures move with the
toolchain and the linker; the deltas are the part worth comparing, and
`./test/features/size.sh` re-measures them on the machine it runs on.

`node-tls` is where the weight is, and `https` is its only other consumer in the stdlib.

`node-net` does **not** remove tokio, and the table does not claim it does: the fs offload pool,
child-process IPC and signals use tokio whatever the module flags say, so tokio and `mio` stay in
the graph (`socket2` with them, through tokio's `net` feature). What `node-net` removes is the
module code and our direct `socket2` dependency; the measured delta is the honest number for that.

In a compiled-app archive, `zlib-payload` is already on, so `node-zlib` adds only the module,
about 40 KB. `cargo tree -i ln-zlib` shows which build carries the library.

## Performance

### HTTP

| metric | onde | Node 26 | Bun 1.3 |
|---|---:|---:|---:|
| HTTP throughput, 100 keep-alive connections | 13.2k req/s | 30.0k req/s | 29.5k req/s |
| HTTP p50 | 0.45 ms | 3.19 ms | 3.20 ms |
| HTTP p99 | 45.7 ms | 6.8 ms | 6.4 ms |
| share of Node's requests/s | 44% | 100% | 98% |

The p50 is lower than Node's because onde's requests are cheap; the tail is much worse because
every connection queues behind one isolate thread. That is the single-isolate ceiling, not the
async-hooks plumbing (which costs nothing for a server that never loads `async_hooks`). M7 took the
p99 from 52.5 ms to 45.7 ms and throughput from 12.9k to 13.2k req/s, which is allocation work, not
an architecture change. A second isolate is a 1.1 item.

### Pure JavaScript

| workload | Node 26 | onde | ratio |
|---|---:|---:|---:|
| string building | 22.5 ms | 43.0 ms | 1.9x |
| sort 200k | 30.2 ms | 91.2 ms | 3.0x |
| JSON 5×100k | 171.0 ms | 779.0 ms | 4.6x |
| fib(30) | 6.0 ms | 55.8 ms | 9.3x |
| object churn 300k | 2.7 ms | 49.9 ms | 18.5x |

Median 4.6x. QuickJS has no JIT and no generational nursery, so allocation-heavy code pays the
most. For a CLI, a build step or a request handler with light logic that is decent; for a bundler,
a minifier or a 10 MB JSON transform it is the wrong runtime.

## One small executable

`ondec` packages an app as a single program: it bundles the sources with rolldown, compiles every
module to QuickJS bytecode, and links the payload against a static runtime library. The result needs
neither `onde` nor Node, `node_modules`, the sources or the SDK at run time.

```sh
# In the onde checkout: the tool, and the SDK for this machine.
cargo build --release -p ondec
./scripts/build-sdk.sh                        # onde.h + libonde-<tuple>.a, prints the path
export ONDE_SDK=$(ls -d dist/sdk/*/* | tail -1)           # dist/sdk/0.1.0/<tuple>

# Anywhere: bundle a project into one executable.
target/release/ondec build ~/app/src/main.js --sdk "$ONDE_SDK" -o ~/app/app
```

`cargo install --path crates/ondec` puts the tool on `PATH` if you would rather not type the
checkout's path.

> **Alpha.** Fetching the SDK is a release-stage feature: once the first alpha publishes `onde.h`
> and the `libonde-<tuple>.a` cells as GitHub release assets, `ondec build` downloads and verifies
> them by itself and `--sdk` becomes optional. There are no release assets yet, so `--sdk` is
> required and the SDK is built locally with the script above.

Sizes and startup, measured 2026-11-23 on the same machine as [Footprint](#footprint) (macOS
arm64, release build):

| app | executable | cold start |
|---|---|---|
| hello world (210 B payload) | 4.8 MB | 18 ms |
| [vibe-cpc](https://github.com/Anson2251/vibe-cpc) (1.1 MiB payload) | 6.0 MB | 25 ms (Node: 105 ms) |
| 34,000-function module (4.3 MiB payload) | 9.4 MB | 26 ms |
| the same, `--compress zstd:19` (543 KiB payload) | 5.4 MB | 29 ms |

A compiled app never parses its sources: a 1.9 MiB module loads from bytecode in about 5 ms where
`onde` needs about 790 ms to parse it. A hello-world app is also smaller than the interpreter that
produced it — 6.9 MB against `onde`'s 7.6 MB — because only the runtime code the app reaches is
linked in.

The size table was measured before `node:sqlite` landed. The default SDK now carries the bundled
SQLite as well: a hello world links at 6.6 MiB (6.9 MB) instead of 4.8 MB, and every row grows by
the same archive code. An archive built with
`cargo build --release -p ln-embed --no-default-features` leaves SQLite out and links the same
hello world at 4.4 MiB (4.6 MB); payload and startup figures are unaffected either way.

Compression buys size, not speed. `--compress` takes `none` (the default), `zlib`, or
`zstd[:level]`: zlib costs nothing because the runtime already links it for the payload format,
while zstd compresses better and decodes faster but adds a 249 KB decoder to every image.

Cross-building is explicit: `--target <tuple>` names the cell, and `--cc` or `CC_<tuple>` names the
compiler (`gcc`, `clang`, `zig cc`, `cl`) — a non-host target is never compiled with the host's
`cc` by default. `--print-command` prints the link line instead of running it, and `--packager
wrappe` stages the same bundle for a self-extracting binary when there is no C toolchain at all.
The payload format, the cell matrix and the parts still open are in
[docs/standalone-build.md](docs/standalone-build.md).

## Milestones

- The engine is vendored quickjs-ng 0.17.0 plus a ~260-line job-queue patch. The host owns the
  microtask queue, so `async_hooks`/`AsyncLocalStorage` propagate across `await`, `then`, ticks,
  microtasks, timers, `fs` callbacks and async function bodies
  ([docs/m6-plan.md](docs/m6-plan.md), [ADR-0009](docs/adr/0009-async-context.md)).
- M7 added the build-time bootstrap snapshot, `--trace-events`/`--timing`/`--trace-gc`,
  `--max-old-space-size` and a `node:test` runner, and stopped an idle socket from holding 64 KiB
  of read buffer. [docs/m7-plan.md](docs/m7-plan.md) is the record.
- `node:sqlite` landed after M7 as a standalone work package: the synchronous surface plus
  user-defined functions and aggregates, the authorizer, sessions and changesets, JavaScript-backed
  virtual tables and extension loading, over a bundled SQLite 3.53.2. The one Node surface left out
  is `diagnostics_channel`'s `'sqlite.db.query'` events.
  [docs/sqlite-plan.md](docs/sqlite-plan.md) has the contract and the gap.
- One measured gap is recorded rather than closed: HTTP throughput is 0.45x of Node in a single
  isolate. The tail and the single-isolate ceiling are 1.1 work; see [Performance](#performance)
  and [docs/m4-plan.md](docs/m4-plan.md) §8.

### Roadmap

| Milestone | Adds |
|---|---|
| M0–M2, done | engine binding, scheduler and timers, CommonJS and ESM, `process`, stdlib tier 0 |
| M3, done | `fs`, streams, `crypto`, `perf_hooks`, real stdio |
| M4, done | `net`, `http`/`https`, `tls`, `dns`, `zlib` |
| M5, done | `child_process`, `worker_threads` with shared memory and `Atomics`, `readline`, signals |
| M6, done | `async_hooks`/`AsyncLocalStorage` on a host-owned job queue; the engine is vendored |
| M7, done | bootstrap snapshot, diagnostics flags, heap limits, `node:test`, the idle-socket fix |
| M8, next | compatibility sweep, packaging, publish (1.0) |

Exit criteria and sequencing for every milestone are in [docs/roadmap.md](docs/roadmap.md).

## Compatibility

onde is Node-compatible, not byte-identical. Native addons (N-API), `vm`, `cluster`, `inspector`,
HTTP/2, `dgram` and full `Intl` are absent, and each isolate runs on one thread with deterministic
scheduling and an explicit microtask model. The per-module matrix and every deliberate divergence
are in [docs/compat.md](docs/compat.md).

## Tuckbox

`tuckbox/` is a small npm: TypeScript, compiled to CommonJS, and run by onde. Every module it uses
is one onde implements, so it exercises the runtime the way a real tool would.

```sh
cd tuckbox && pnpm install && pnpm build
onde=$PWD/../target/debug/onde
tuckbox=$PWD/bin/tuckbox.js

mkdir /tmp/app && cd /tmp/app
printf '{"name":"app","dependencies":{"debug":"^4.3.0"}}' > package.json
"$onde" "$tuckbox" install
"$onde" "$tuckbox" ls
```

`install`, `ci`, `add`, `remove` and `ls`. Tarballs are checked against `dist.integrity`, unpacked
once into a content-addressed store, and hardlinked into `node_modules`. A package is nested only
where two versions genuinely conflict, so the tree resolves the same way under node and onde. The
install numbers come from `/usr/bin/time -l` on an empty cache in a fresh directory, for the same
two packages (`debug`, `ms`), against `npm install --no-audit --no-fund` (npm 11.20.0):

| | tuckbox on onde | `npm install` |
|---|---|---|
| wall time | 0.23 s | 0.44 s |
| peak RSS | 21 MB | 107 MB |
| rebuild from the store | 0.03 s, 10 MB | |

`pnpm test` in `tuckbox/` runs every suite under node and under onde and compares the output;
`TUCKBOX_NET=1 pnpm test` adds the suite that installs real packages from the registry. It skips
lifecycle scripts, `.bin` links, peer and native dependencies, and the full scope is in
[docs/tuckbox.md](docs/tuckbox.md).

The real npm gets further than a demo usually does: `onde "$(command -v npm)" --help` prints npm
11.20's help with no version warning. A command that walks the tree, `npm ls`, stops at
`node:diagnostics_channel`, which [docs/compat.md](docs/compat.md) lists as a 1.1 candidate. That
is the honest line: the CLI loads and runs, the module it needs for real work is not there yet.

## Why

Node's cost comes from V8's memory floor, an install-time dependency graph, and libuv's surface.
For CLIs, edge handlers, build scripts and embedded scripting, what matters is Node's semantics
(module system, `process`, timers, streams, `fs`) and its API shape. The engine underneath is the
part you can replace.

QuickJS gives a 1 MB engine with ES2023-level language support and fast startup, but no runtime
around it. There is no event loop, no timers, no module loading from disk, no `process`, and the
microtask queue has to be re-hosted carefully. Those are what this repository builds.

## Where to read next

1. [docs/internals.md](docs/internals.md) for what runs today, the repo layout and every harness.
2. [docs/compat.md](docs/compat.md) for the API matrix and the deliberate divergences.
3. [docs/architecture.md](docs/architecture.md) for the component map and boot sequence.
4. [docs/roadmap.md](docs/roadmap.md) for milestones, exit criteria and sequencing.
5. [docs/standalone-build.md](docs/standalone-build.md) for packaging an app as one executable.
6. [docs/tuckbox.md](docs/tuckbox.md) for the demo: a package installer on onde.
7. [docs/sqlite-plan.md](docs/sqlite-plan.md) for the `node:sqlite` contract and what is still open.

The decisions behind the structure (scheduler, event loop, module system, handles, HTTP codec) are
in [docs/adr/](docs/adr/), and [internals.md](docs/internals.md) §5 gives the reading order.

## Licensing

onde is free for commercial use under both of its licenses. The split is by crate, and the rule is
"the bricks are MIT, the machine is MPL-2.0".

**MPL-2.0 — the runtime machine:** `ln-engine`, `ln-runtime`, `ln-io`, `ln-embed`, `ln-cli`,
`ondec`. Use it, modify it, sell it, embed it in a product. If you distribute a modified version,
the files you changed stay under MPL-2.0 and their source must be made available. Files you add
are yours to license as you like. Distributing an unmodified build only asks that recipients can
reach the source, which for this repository is a URL.

**MIT — the reusable bricks and the JavaScript surface:** `ln-abi`, `ln-payload`, `ln-crypto`,
`ln-error`, `ln-http`, `ln-sched`, `ln-sqlite`, `ln-zlib`, `ln-modules`, plus everything under
`js/` and the `tuckbox` demo. Take them anywhere, including into closed-source products, as long as
the copyright notice travels with them. The `js/` files are embedded into the binary at build time,
so a shipped `onde` is a mixed work: MPL-2.0 for the Rust crates, MIT for the JavaScript.

The full texts are [LICENSE](LICENSE) (MPL-2.0, canonical copy from mozilla.org) and
[LICENSE-MIT](LICENSE-MIT).

In practice:

- Embedding onde in a closed-source product is allowed; your own code stays yours.
- Forking onde and shipping a closed-source distribution is not.
- Every third-party dependency of this tree is permissive or MPL-2.0 (enforced by `deny.toml`), so
  the MPL-2.0 crates combine cleanly with all of them, and downstream projects under MIT, Apache-2.0
  or GPL can depend on these crates without adopting MPL-2.0 for their own files.

Contributions are accepted under the license of the crate being touched, with a `Signed-off-by`
line (DCO). Copyright stays with each author; this project takes no assignment, and there is no CLA.

The name and logo are covered by neither license.

