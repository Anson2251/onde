# Compatibility matrix and divergences

Two things are tracked separately:

- **Coverage** — which Node API exists, and at what fidelity.
- **Divergence** — where we deliberately behave differently, with a test that asserts it.

A module is only "✅" when its tests are green; "🟡" means the common path works and the gaps are
listed. Status: 🟢 engine provides · 🔵 we build (small) · 🟠 we build (substantial) · ⚪ absent.

**Last verified: M3, 2026-11-13** (`node v26.10.0` as the oracle). The M3 rows and divergences
D35–D39 are green: `fs`, `fs/promises`, `stream`, `crypto`, `perf_hooks` and `tty` are exercised
by the corpus, the JS suites and `test/programs/run.sh`.

## 1. What quickjs-ng 0.17.0 gives us

Measured on the pinned engine (2026-11-13):

| Feature | Status | Notes |
|---|---|---|
| ES2023+ syntax, TLA, classes, private fields | 🟢 | `Promise.withResolvers`, `Object.groupBy`, `toSorted`, `RegExp.escape` present |
| Modules, dynamic `import()` | 🟢 | `JS_SetModuleLoaderFunc2`; onde supplies the resolver, canonical names and `import.meta` |
| `queueMicrotask` | 🟢 | shares FIFO with promise reactions (correct) |
| `WeakRef`, `FinalizationRegistry` | 🟡 | `WeakRef` works; cleanup callbacks are enqueued as jobs in ng master but not in 0.17.0 — do not rely on them in 1.0 |
| `atob`/`btoa` | 🟢 | onde also defines them from `Buffer` if absent |
| `Intl` | ⚪ | non-goal for 1.0 (R2); `typeof Intl === "undefined"` (D5) |
| `TextEncoder`/`TextDecoder` | 🔵 M2 | `js/lib/textcodec.js` (WHATWG subset; see D28) |
| `URL`/`URLSearchParams` | 🔵 M2 | `js/lib/url.js`; no `URLPattern` (D29) |
| `AbortController`/`AbortSignal` | 🔵 M2 | `js/lib/globals.js`, integrated with `EventTarget` and `events.once({ signal })` |
| `EventTarget`/`Event`/`DOMException` | 🔵 M2 | `js/lib/globals.js`; tree propagation is an extension (D27) |
| `structuredClone` | 🔵 M2 | subset: plain data, Map/Set/Date/RegExp, buffers, typed arrays, cycles (D27) |
| `crypto` (WebCrypto) | ⚪ | `subtle` in M7; `randomBytes`/hash are M3 ops |
| `fetch`, `WebStreams` | ⚪ | 1.1 candidates |
| `WebAssembly` | ⚪ | non-goal |
| `performance` | 🟢 | engine object; `perf_hooks` wrapper in M3 |
| `setTimeout`/`setInterval`/`setImmediate` | 🟢 M1 | ours: `ln-sched` heap + `ln-runtime` loop |
| `process` | 🟡 M1/M2 | see §2; signals and CPU accounting are later |

## 2. Node API coverage by milestone

### Module system — M2

| Feature | Status | Notes |
|---|---|---|
| CJS `require` | ✅ | wrapper (`this === module.exports`), cache, `module.exports`, `require.resolve`/`cache`/`main`, `module.paths`, `children` |
| CJS resolution | ✅ | relative/absolute, extension search, `index`, `node_modules` walk (nested + scoped), `package.json` `main`/`type` |
| ESM | ✅ | native QuickJS modules: TLA, live bindings, `import.meta.url`/`filename`/`dirname`/`main`/`resolve`, dynamic `import()` |
| `exports` / `imports` maps | ✅ | conditions `node`/`import`/`require`/`default`, exact subpaths, `*` patterns, arrays, `null` blocks; no custom conditions (D23) |
| ESM→CJS interop | ✅ | `default = module.exports` + statically scanned names (D17) |
| CJS→ESM | 🟡 | `import()` works; `require(esm)` is rejected (D16) |
| JSON modules | ✅ | `import`/`require`; import attributes parsed but not required (D18) |
| `node:` builtins | 🟡 | tier 0 only; unknown names fail fast (D23) |
| `--check` | ✅ | CJS and ESM compile-only diagnostics with file/line/column/caret |
| Loader hooks, `--conditions`, network imports | ⚪ | 1.1 / out of scope (D32) |

### Tier 0 stdlib — M2

| Module | Status | Notes |
|---|---|---|
| `process` | 🟡 | env/argv/cwd/chdir/platform/arch/version(s)/pid/ppid/title/exit/exitCode/nextTick/hrtime/bigint/uptime/memoryUsage/emitWarning/stdio; `cpuUsage()` zeroes (D22), signals M5, `version` is onde's (D34) |
| `path` | 🟡 | posix + win32 complete; `matchesGlob` absent (D31) |
| `url` | 🟡 | WHATWG `URL`/`URLSearchParams`, legacy `parse`/`format`/`resolve`/`resolveObject`, `fileURLToPath`, `pathToFileURL`, `urlToHttpOptions`, `domainTo*`; no `URLPattern`/`fileURLToPathBuffer` (D29) |
| `util` | 🟡 | `format`, `formatWithOptions`, `inspect`, `inherits`, `promisify` (+custom), `callbackify`, `types`, `isDeepStrictEqual`, `deprecate`, `debuglog`, errno helpers, `stripVTControlCharacters`, `toUSVString`; inspect is a documented subset (D30) |
| `events` | 🟡 | `EventEmitter`, `once`/`on` (with `AbortSignal`), `errorMonitor`, `captureRejections`, prepend/once wrappers, `getEventListeners`; no `EventEmitterAsyncResource`/`addAbortListener` (D26) |
| `assert` | 🟡 | full core set + `strict` + `AssertionError`; no snapshots/`CallTracker`/`partialDeepStrictEqual`, simpler diff bodies (D30) |
| `buffer` | 🟡 | `Uint8Array` subclass, utf8/hex/base64/base64url/latin1/ascii/utf16le, numeric I/O, comparison/search; no pool, no `Blob`/`File`/`transcode` (D28) |
| `string_decoder` | 🟡 | utf8/utf16le/base64/hex/latin1/ascii with correct split handling; `text` is a method (Node's legacy form), no `lastChar`/`omitPadding` (D28) |
| `os` | 🟡 | platform/arch/type/release/EOL/devNull/homedir/tmpdir/hostname/cpus count/totalmem/freemem/uptime/userInfo/endianness/availableParallelism; onde values (D24) |
| `console` | 🟡 | `Console` class, log/info/debug/warn/error, dir/trace/assert/time/count/group/table/clear; no `profile*`/`timeStamp`/`createTask`, no color (D25) |
| `querystring` | ✅ | parse/stringify/escape/unescape/decode/encode/unescapeBuffer |
| `punycode` | ✅ | deprecated but complete |
| `module` | 🟡 | `createRequire`, `builtinModules`, `isBuiltin`, `_cache`, `syncBuiltinESMExports`; no internals (D33) |

### Globals — M2

| Global | Status | Notes |
|---|---|---|
| `URL`, `URLSearchParams` | ✅ | WHATWG implementation |
| `TextEncoder`, `TextDecoder` | 🟡 | utf-8/utf-16le/windows-1252 labels (D28) |
| `AbortController`, `AbortSignal` | ✅ | `abort`, `timeout`, `any`, `throwIfAborted`, `onabort` |
| `EventTarget`, `Event`, `DOMException` | 🟡 | DOM-shaped; tree propagation extension, listener errors via `queueMicrotask` (D27) |
| `structuredClone` | 🟡 | data subset; Proxy undetectable (D27) |
| `atob`, `btoa`, `global`, `globalThis` | ✅ | |
| `queueMicrotask` | 🟢 | engine-provided (D12 applies) |

### Tier 1 — M3

| Module | Status | Notes |
|---|---|---|
| `fs` | 🟡 | sync + callback: `readFile`, `writeFile`, `appendFile`, `copyFile`, `cp`, `mkdir` (recursive resolves the first created path), `mkdtemp`, `mkdtempDisposableSync`, `readdir` (`withFileTypes`, `recursive`), `opendir` (JS `Dir` over a materialized `readdir`), `rm`/`rmdir`, `unlink`, `rename`, `stat`/`lstat`/`fstat`, `statfs`, `access`, `chmod`/`chown`/`lchmod`/`lchown` (`lchmod` is `ENOSYS` off macOS, as in Node), `truncate`/`ftruncate`, `readlink`/`symlink`/`link`, `realpath` (+`.native`), `utimes`/`lutimes`, `open`/`close`/`read`/`write`/`readv`/`writev`, `fsync`/`fdatasync`, `exists`, `watchFile`/`unwatchFile` and `watch` (polling, D3), `createReadStream`/`createWriteStream`, `constants`, `Stats`/`StatsFs`/`Dirent`/`Dir` |
| `fs/promises` | 🟡 | **not a mirror of `fs`** (D35): 31 functions, no `*Sync`, no fd-level top-level calls, `open` returns `FileHandle`, `watch` is an async iterator, `constants` is the same object as `fs.constants`; `readFile`/`writeFile`/`appendFile`/`stat` also accept a `FileHandle`; includes `lchmod`/`lchown`/`lutimes`/`statfs`/`mkdtempDisposable` |
| `stream` | 🟡 | `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough`, `pipeline`, `finished`, `addAbortSignal`, `objectMode`, backpressure; `stream/promises` (`pipeline`, `finished`); no `readable-stream` internal parity |
| `crypto` | 🟡 | `randomBytes`, `randomFill`/`randomFillSync`, `randomUUID`, `randomUUIDv7`, `randomInt`, `getRandomValues`, `createHash` (md5/sha1/sha224/sha256/sha384/sha512/sha512-224/sha512-256, `.copy()`), `createHmac`, one-shot `hash`, `timingSafeEqual`, `hkdf`/`hkdfSync`; no ciphers/keys/signatures, no `constants`/`getCiphers`; OpenSSL-only digests (SHA-3, BLAKE2, RIPEMD, SM3) are rejected and the gap is asserted in `crypto.oracle.js`; WebCrypto `subtle` in M7 |
| `perf_hooks` | 🟡 | `performance.now`/`mark`/`measure`/`getEntries`, `hrtime`, approximate `eventLoopUtilization`; the `performance` global |
| `tty` | 🟡 | `isatty`, `WriteStream`/`ReadStream` basics; backs `process.stdout`/`stderr`/`stdin` |

### Tier 2 — M4, M5

| Module | Status | Notes |
|---|---|---|
| `net` | 🟡 | `Socket` (extends `Duplex`), `Server`, `connect`/`createConnection`/`createServer`, `isIP`/`isIPv4`/`isIPv6`; TCP + Unix, IPv4/IPv6, half-close, `pause`/`resume`, `setTimeout`, `setNoDelay`/`setKeepAlive`, `ref`/`unref`, `bytesRead`/`bytesWritten`, `getConnections`, `maxConnections`, `allowHalfOpen`, `pauseOnConnect`; no JS-visible fd (D40), `write()` accounting differs (D45) |
| `http`/`https` | 🟡 | `Server`/`createServer`/`request`/`get`/`Agent`/`globalAgent`, `STATUS_CODES`/`METHODS`/`maxHeaderSize`/`validateHeaderName`/`validateHeaderValue`; HTTP/1.1 server + client, chunked both ways, keep-alive, inbound trailers, `100-continue`, `clientError`, upgrade; outbound trailers and the upgrade `head` bytes are missing (D43, D44). `https` refuses every TLS entry point until WP6 rather than downgrading to plaintext |
| `dns` | 🟡 | `lookup` (callback and `dns.promises.lookup`) over `getaddrinfo`, with `all` and `family`; no `resolve*`, `lookupService`, `getServers`/`setServers`; `hints` is accepted and ignored |
| `tls` | ⚪ | M4/WP6: rustls; `rejectUnauthorized`, `ca`, `servername`, ALPN `http/1.1`. Until it lands every `https`/TLS entry point throws `ERR_FEATURE_UNAVAILABLE` synchronously — connecting in plaintext while the caller asked for TLS is a security bug, not a compat gap |
| `readline` | 🟡 | interface over stdin; no `readline/promises` in 1.0. Moved out of M3: it is a stdin consumer, not I/O core, and M3 is the densest milestone |
| `child_process` | 🟡 | `spawn`/`exec`/`execFile`/`fork`, stdio pipes, `kill` |
| `worker_threads` | 🟡 | `Worker`, `MessageChannel`/`MessagePort`, `SharedArrayBuffer`, `Atomics` |
| `cluster` | ⚪ | non-goal (use workers) |
| `async_hooks` | 🟡 M6 | `createHook`, `executionAsyncId`, `triggerAsyncId`, `AsyncLocalStorage`, `AsyncResource` |
| `v8` | ⚪ | no `getHeapSnapshot`; `--max-old-space-size` maps to the engine limit |
| `vm` | ⚪ | non-goal (D6) |
| `inspector` | ⚪ | non-goal |
| `diagnostics_channel` | ⚪ | 1.1 candidate |
| `cluster`, `dgram`, `http2`, `zlib`, `sqlite` | ⚪ | not in 1.0 |
| `node:test` | 🟡 M7 | onde runner powering our own conformance corpus |

## 3. Divergences (deliberate, tested)

| ID | Divergence | Rationale | Test |
|---|---|---|---|
| D1 | No libuv poll phase: onde orders timers by due time, so a clamped 0 ms timer that is already due runs before `setImmediate`. Whether it is due at loop start is wall-clock dependent (as in Node), so races are `.nodiff`; the ordering rule itself is deterministic | determinism within a turn is a feature for embedders; the one unavoidable race is not papered over | `test/conformance/divergences/d04-zero-timer-vs-immediate.js` (asserts the byte set, since the order is the race); `loop/l09-immediate-before-timer.js` and `microtasks/c10-*` use a 20 ms timer and assert the order deterministically |
| D2 | Close callbacks are dispatched as completions, not in a dedicated phase | single completion channel | M3 |
| D3 | `fs.watch` polls in 1.0 | avoids three platform watch backends in the first release | M3 |
| D4 | `process.exit` inside a microtask drops remaining microtasks | matches Node (verified C7), stated loudly because it surprises people | `microtasks/c07` |
| D5 | `Intl` absent | engine gap, non-goal | `divergences/d09-intl` |
| D6 | No `vm` module; `eval` is the only escape hatch | engine/scope | `divergences/d10-vm` |
| D7 | `Buffer` is a `Uint8Array` subclass without the pool allocator | simpler; `allocUnsafe` is zeroed, `Buffer.from(Buffer)` copies | `test/js/lib/buffer.oracle.js` |
| D8 | Stack traces for async jobs are synthetic unless `--async-stack-traces` (M6) | engine has no async stacks | M6 |
| D9 | `--max-microtasks`/`--microtask-timeout` exist; Node has no equivalent | bounded work for embedders; default off | `crates/ln-cli/tests/cli.rs` |
| D10 | HTTP/2, `dgram`, `zlib` absent | scope | M4 |
| D11 | Non-`Error` thrown values are wrapped in an `Error` before `uncaughtException`/`unhandledRejection` | promise jobs cannot carry the raw value across the engine-free scheduler boundary before the M6 job patch | `divergences/d01` |
| D12 | The engine's `queueMicrotask` `TypeError` has no `ERR_INVALID_ARG_TYPE` code | QuickJS owns the global; ADR-0002 forbids wrapping it because it shares the promise FIFO | `divergences/d02` |
| D13 | Timer/immediate ids start at 1 (Node's first id is 2) | ids are an implementation detail; `Timeout`/`Immediate` objects are the API | `divergences/d03` |
| D14 | Fatal stderr is Node-**shaped**, not byte-identical: V8 internal frames (`Module._compile`) have no QuickJS equivalent | different engines; header, source excerpt, caret and user frames match | renderer unit tests + CLI e2e (not a byte diff) |
| D15 | `process.exit` unwinds with a private sentinel, so a script that catches arbitrary values can catch it; Node exits immediately | QuickJS has no uncatchable abort that preserves the exit path; the recorded code is authoritative and the loop stops at the next boundary | `divergences/d05-exit-sentinel-catchable` |
| D16 | `require()` of an ES module throws `ERR_REQUIRE_ESM`; Node 22+ can synchronously require a TLA-free graph | evaluating ESM inside a running CJS call would pump the engine job queue re-entrantly (ADR-0002 I1); dynamic `import()` is the supported direction | `divergences/d06-require-esm` |
| D17 | ESM named exports from CJS come from a static scan (`exports.x`, `module.exports.x`, brackets, `Object.defineProperty`, `module.exports = {...}`); `Object.assign`, loop-built names and re-exports are missed | a full parser is not worth the code; Node's `cjs-module-lexer` has the same class of false negatives; `default` is always reliable | `test/conformance/modules/esm02-interop.mjs` |
| D18 | JSON modules do not require `with { type: "json" }`; the attribute is parsed and ignored | keeps onde lenient while accepting the same source Node accepts | `divergences/d07-json-attribute` |
| D19 | A rejected top-level `await` is reported through `unhandledRejection`; Node routes it to `uncaughtException` | the engine exposes the module promise as a normal rejection; with no listeners both exit 1, and M6's job ownership can route it exactly | `divergences/d08-tla-rejection` |
| D20 | Resolution/loader error messages are Node-shaped, not byte-identical (no Node internal frames, shorter require stack, specifier text may be relative where Node prints an absolute URL) | different engine and no `module` internals; `name [CODE]: message`, the `code` property and the useful first line match | CLI e2e + `test/conformance/modules/esm03-dynamic.mjs` |
| D21 | `process.memoryUsage().rss` is the engine heap (equal to `heapTotal`); `external`/`arrayBuffers` are 0 | OS-level RSS is an M7 measurement; the fields exist so callers keep working | `test/conformance/stdlib/process01.js` |
| D22 | `process.cpuUsage()` returns zeroes | per-process CPU accounting arrives with processes/workers (M5) | `test/conformance/stdlib/process01.js` |
| D23 | No package self-reference (`import "own-name"`), no custom conditions, no `node-addons` condition; unknown `node:` names throw `ERR_UNKNOWN_BUILTIN_MODULE` | the common conditional map is supported; the rest is 1.1 scope | `crates/ln-modules/tests/resolve.rs` |
| D24 | `os.networkInterfaces()` is `{}`; `os.loadavg()` is `[0,0,0]`; `os.cpus()` is count-only with zeroed times; `os.freemem()` is 0 on macOS; permissions constants are a portable subset; `getPriority`/`setPriority`/`version` absent | no host ops for these yet; shape stays Node-compatible | `test/js/lib/os.test.js` |
| D25 | `console.table` is an onde box table (no Map/Set iterators, multiline cells flattened); `colorMode` accepted but never colorizes; `time` formatting simplified; `profile`/`timeStamp`/`createTask` absent | avoids porting cli-table/colors for M2 | `test/js/lib/console.test.js` |
| D26 | Events: `EventEmitterAsyncResource`, `addAbortListener` and `usingDomains` absent; no max-listener leak warning; `EventEmitter.captureRejections` is an accessor over a symbol flag (assignment still toggles the default) | small surface, no async_hooks yet; warning policy deferred to M6 | `test/js/lib/events.oracle.js` |
| D27 | Globals: `structuredClone` is a data subset (no Blob/File/MessagePort/streams; a Proxy clones as a plain object); `EventTarget` tree propagation is an extension; listener errors rethrow from `queueMicrotask`; `passive` is inert | single-realm, no host objects before M3/M5; DOM behaviour is otherwise followed | `test/js/lib/globals.test.js` + `globals.oracle.js` |
| D28 | Buffer/codecs: no pool; `Buffer.from(array)` validates 0–255 (Node coerces), iterables are accepted (Node throws), `DataView` copies; `StringDecoder.text` is a method; `TextDecoder` supports utf-8/utf-16le/windows-1252 only | documented subset; the common encodings and Node's split/hold rules are matched | `test/js/lib/buffer.oracle.js`, `textcodec.test.js` |
| D29 | `url` lacks `URLPattern` and `fileURLToPathBuffer`; IDNA is punycode + practical UTS#46 mapping (NFKC, case folding, ignored chars) without the full status table, so a few disallowed code points are punycoded where Node rejects them; Windows `pathToFileURL` handles normal drive paths but not bare-root/UNC edge serialization; legacy `url.parse` does not emit DEP0169 | web-platform extras and the full UTS#46 table are 1.1 scope; WHATWG serialization, legacy parse and common IDN cases match the oracle | `test/js/lib/url.oracle.js` |
| D30 | `util.inspect` is a subset (no full Node line-breaking/formatting parity in deep containers; colors disabled; `showHidden` sees plain hidden props only); `assert` bodies use a simpler diff; `parseArgs`/`parseEnv`/`styleText`/MIME absent; `partialDeepStrictEqual` absent | the oracle pins the common values; porting Myers diff and the color engine is not M2 value | `test/js/lib/util.oracle.js`, `assert.oracle.js` |
| D31 | `path.matchesGlob` (Node 22.17+) absent | rare and new; `path` is otherwise complete on both flavors | `test/js/lib/path.oracle.js` |
| D32 | No loader hooks, no `--conditions`, no import attributes validation, no network module loading (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); `import.meta.resolve` is synchronous and returns the canonical name | M2 scope; the resolver's condition list is fixed | `test/conformance/modules` |
| D33 | `module` exposes only `createRequire`/`builtinModules`/`isBuiltin`/`_cache`; no `_compile`, `_resolveFilename`, `registerHooks`, `findPackageJSON`, `runMain` internals | internals are not API; supporting them would freeze private structures | `test/conformance/stdlib/module01.js` |
| D34 | `process.version` is onde's version (`v0.1.0`) and `process.versions` still reports the `lite` key (no `node` key); `process.argv[1]` is canonicalized (symlinks resolved) where Node uses `path.resolve`; `process.env` is a startup snapshot whose mutations are not exported to the OS environment | honest identity; packages that gate on a Node major take their fallback paths (M8 compat sweep); environment propagation belongs to `child_process` (M5) | `test/conformance/stdlib/process01.js` |
| D35 | `fs/promises` is **not** a promisified `fs`: no `*Sync` variants, no top-level fd calls (`close`/`read`/`write`/`readv`/`writev`/`fstat`/`fchmod`/`fchown`/`fsync`/`fdatasync`/`ftruncate`/`futimes` are `FileHandle` methods), `open` resolves a `FileHandle`, `watch` is an async iterator, module-level `createReadStream`/`createWriteStream` are absent, `exists`/`watchFile` are absent, and `constants` is the same object as `fs.constants`. Bad arguments still throw synchronously from the callback/sync forms and reject from the promise forms | derived from the same ops but shaped like Node, because the promise form is a different API (verified against `node v26.10.0`, which has 35 promise functions against ~90 `fs` functions) | `test/js/lib/fs-promises.test.js` + an exact `Object.keys` conformance case |
| D36 | `fs.readFile`/`fs.read` copy the op's bytes into a JS `Uint8Array`; the zero-copy external-memory view promised by [architecture](architecture.md) §10 is M7 work | `ln-engine` has no external `ArrayBuffer` path yet, and correctness of the fs surface outranks one copy per read; `Buffer` stays a plain `Uint8Array` subclass (D7) | M7 benchmark (`fs.readFile` 10 MB within 1.2x of Node) |
| D37 | `FileHandle.getAsyncId` is absent until M6 (it is an `async_hooks` hook); `FileHandle.readLines`/`readableWebStream`/`fs.openAsBlob` are absent (M7/1.1); `fs.glob`/`globSync`/`fs/promises.glob` are absent; `fs.promises.FileHandle` is not exported (Node does not export it either); `Dir` is a JS iterator over a materialized `readdir` rather than a lazy fd-backed directory; `URL` paths work but a `Buffer` path is decoded as UTF-8, so non-UTF-8 byte paths are unsupported | keeps M3 to the I/O core; the class surface is recorded from the oracle rather than assumed | `test/js/lib/fs.test.js` |
| D38 | `tty`: no kernel window size or resize events (`columns`/`rows` come from `COLUMNS`/`LINES`, else 80×24), `getColorDepth`/`hasColors` are a `TERM`/`COLORTERM` heuristic rather than terminfo, `setRawMode` only flips a flag, and `tty.ReadStream` does not raise `ERR_TTY_INIT_FAILED` on a non-TTY fd. `perf_hooks`: `eventLoopUtilization` reports `idle: 0` and `active` as wall time between samples, `PerformanceObserver` never delivers entries, and `nodeTiming`/`timerify`/`monitorEventLoopDelay` are absent. Pipe stdin reports `isTTY: false` where Node leaves it `undefined`, and destroying stdin cannot cancel an already-blocking fd-0 read | the runtime has no libuv handle, no ioctl binding and no loop-statistics source yet; the shapes stay Node-compatible so callers keep working, and the real values are M7 diagnostics work | `test/js/lib/tty.test.js`, `test/js/lib/perf.test.js` |
| D39 | `rm`/`rmdir` refuse to remove the process's working directory: `.`, `./`, `a/..` and an absolute path equal to the cwd raise `ERR_FS_EISDIR`. Node rejects only the literal `.`/`./` (with `EINVAL`) and will delete an absolute cwd (`fs.rmSync(process.cwd())` removes the project) | a runtime that deletes its own project tree on a path-resolution mistake is not a failure mode worth preserving; the guard is lexical so resolved paths cannot bypass it | `crates/ln-io` unit tests (`self_references_are_refused...`, `the_process_cwd_is_refused...`) |
| D40 | A socket is owned by a pool task, so there is no JS-visible file descriptor: `socket._handle`, `socket.fd`, `new net.Socket({ fd })` and `net.Socket({ readable, writable })` over an existing fd are unsupported. `setNoDelay`/`setKeepAlive`/`setTimeout` are commands to the task, not libuv handle calls | ADR-0006: `JSValue`s never cross a thread and one thread per socket does not reach 10k connections; the fd is an implementation detail Node exposes by accident of libuv | M4 |
| D41 | TLS is rustls: no renegotiation, no `getSession`/`setSession`/`isSessionReused`, `getPeerCertificate` returns a field subset, and cipher names are rustls' IANA names (they match Node's TLS 1.3 suites and differ for some TLS 1.2 suites) | rustls does not implement renegotiation or session caching in the OpenSSL shape; the supported knobs (`rejectUnauthorized`, `ca`, `servername`, ALPN) are the ones the roadmap names | M4 |
| D42 | HTTP parse errors carry onde codes (`ERR_HTTP_PARSE`, `ERR_HTTP_HEADERS_OVERFLOW`) rather than llhttp's `HPE_*`; `clientError` is emitted after the connection has been closed, so a listener cannot write a response on it | the codec is `httparse` + our own framing (ADR-0007), and the task closes before the isolate sees the event; writing to a closed handle would be a lie | M4 |
| D43 | Client-side interim `1xx`: after a `100`/`103` the parser is restarted on the same handle, so the remembered request method is lost for the final response. A `HEAD`/`CONNECT` request that receives an interim response can mis-frame the final one | the transport parks after every `messageEnd`; keeping the codec alive across a `1xx` is a transport change plus a JS one, deferred to M4 hardening | `test/conformance/http/04-expect-continue` (the POST path) |
| D44 | HTTP `'upgrade'` hands back a zero-length `head` Buffer: detaching at a request boundary cannot recover bytes the codec reserved without completing a message | `Conn` has no `take_remainder()`; the transport's own surplus is flushed as `data`, so no byte is lost, but Node's third argument is smaller | `test/js/lib/http.test.js` |
| D45 | `net.Socket.write()` returns `false` at a 16 KiB JS-buffered high-water mark, and `writableLength` counts bytes handed to the task rather than libuv's 64 KiB queue | the M3 stream contract; the observable `false` + conditional `'drain'` shape matches Node, the byte counts do not | `test/js/lib/net.test.js` |
| D46 | Outbound HTTP trailers are validated and stored by `addTrailers` but never written; `finish` emits `0\r\n\r\n` with no trailer fields | `ln-http::finish` has no trailer parameter (ADR-0007 §2.4, Tier B); inbound trailers are parsed and reported | `test/js/lib/http.test.js` |


## 4. Buffer strategy

`Buffer` must be a `Uint8Array` subclass with Node's method surface. Two options were considered:

- **A. Pure JS subclass** (`class Buffer extends Uint8Array`) — fast to write, every method is JS,
  easy to keep correct, but `Buffer.isBuffer` and native call sites need careful plumbing.
- **B. Engine class** (`JS_NewClass` with a `Uint8Array`-shaped exotic object) — best
  performance, hardest to keep spec-identical.

Decision for 1.0: **A**, implemented in `js/lib/buffer.js`. `Buffer` allocations are
`Uint8Array`s backed by an `ArrayBuffer`; there is no pool. M3's `fs` ops hand back owned bytes
that the JS layer wraps in a `Buffer`, so there is one copy per read; a zero-copy
external-memory `ArrayBuffer` path is M7 work (D36). Revisit B only if profiling shows `Buffer`
conversion in the top 3 hot spots.

## 5. How we decide "supported"

1. There is a test file for the module: `test/js/lib/<module>.test.js` (runs under Node **and**
   lite via `test/js/run.sh`) and, where a Node oracle is meaningful, `<module>.oracle.js`.
2. There is at least one case in `test/conformance/stdlib/` (or `modules/`) that exercises the
   public surface, recorded from `node v26.x`.
3. Any known gap is listed above with a divergence ID and an asserting test.
4. The module is documented in the generated reference (M8).

A module with no tests is not supported, regardless of how much of it compiles.
