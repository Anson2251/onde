# `js/` — the Node surface written in JavaScript

Everything user-visible that does not need a syscall lives here. These files are the readable
source: `crates/ln-runtime/build.rs` parses and compresses each one with oxc at build time (no name
mangling, because class and function names are part of the Node surface and of stack traces) and
embeds the artifacts from `OUT_DIR/js`. Setting `ONDE_NO_MINIFY=1` bundles the sources verbatim.

Rust exposes a small, frozen `globalThis.__ln_host` object; these modules turn it into the Node API. The rule from
[architecture.md](../docs/architecture.md) §2 applies: **no module here reaches into engine
internals**, and no module here is allowed to be the only copy of a semantics decision that
belongs in `ln-sched` or `ln-runtime`.

## Layout

```
js/
  bootstrap.js        install order: host, events/process, globals, module registry
  lib/
    path.js           path, path/posix, path/win32
    url.js            URL, URLSearchParams, legacy parse/format, fileURLToPath
    punycode.js       deprecated punycode
    querystring.js    querystring
    util.js           util, util.types, TextEncoder/TextDecoder re-export
    textcodec.js      UTF-8/UTF-16 codecs + TextEncoder/TextDecoder
    assert.js         assert, assert/strict
    events.js         EventEmitter, once/on, errorMonitor, captureRejections
    string_decoder.js StringDecoder
    buffer.js         Buffer (Uint8Array subclass)
    os.js             os
    console.js        Console + the global console
    module.js         Module/createRequire/builtinModules/isBuiltin
    globals.js        EventTarget, Event, AbortController, AbortSignal, structuredClone
    process.js        the process object (created by bootstrap.js), IPC in a forked child
    loader.js         CJS cache, require(), builtin registry, runMain
    child_process.js  spawn/exec/execFile/fork over the proc handle family
    internal/errors.js Node's coded-error vocabulary and argument validation
    internal/bytes.js Buffer's non-UTF-8 codecs and shared byte coercion
    internal/pipe.js  child stdio pipes as Readable/Writable
    worker_threads.js Worker, MessageChannel, parentPort, workerData
    internal/worker.js the shared core under worker_threads (ports, Worker, parentPort)
    readline.js       line-oriented Interface + ANSI helpers
    readline-promises.js readline/promises
    sqlite.js         Database, Statement, SQLTagStore, constants, backup
```

Each `lib/*.js` is a **CommonJS module**: `"use strict";`, `module.exports = ...`, no top-level
`await`, no import syntax. Stdlib modules may `require()` other stdlib modules by bare name
(`require("events")`); the runtime's CJS loader resolves those to the embedded sources.

## Host contract (`globalThis.__ln_host`)

Defined by `ln-runtime` (installed before the bootstrap runs) and frozen. Stdlib modules capture
it at load time. It is an internal seam, not API: user code must not depend on it.

| Member | Signature | Notes |
|---|---|---|
| `write` | `(text: string, isErr: boolean) => void` | raw bytes to stdout/stderr; callers add newlines |
| `exit` | `(code: number) => never` | unwinds with the private sentinel |
| `setExitCode` | `(code: number) => void` | |
| `nextTick` / `setTimer` / `clearTimer` / `timerRef` / `setImmediate` / `clearImmediate` / `immediateRef` | M1 scheduler primitives | see `bootstrap.js` |
| `reject` / `handle` | rejection table primitives | |
| `argv` | `string[]` | `[execPath, script, ...args]` |
| `platform` | `"darwin" \| "linux" \| "win32"` | Node names, not Rust names |
| `pid` / `ppid` | `number` | |
| `version` | `string` | `v<onde version>` |
| `env` | `() => Record<string, string>` | a copy |
| `cwd` | `() => string` | absolute |
| `chdir` | `(path: string) => void` | throws a Node-shaped error with `code` |
| `hrtimeNs` | `() => bigint` | monotonic |
| `memoryUsage` | `() => { rss, heapTotal, heapUsed, external, arrayBuffers }` | bytes; cached between JS calls (the engine cannot re-enter itself) |
| `osInfo` | `() => { platform, arch, type, release, endianness, homedir, tmpdir, hostname, shell, username, uid, gid, cpus, totalmem, freemem, uptime }` | `cpus` is a count |
| `isTTY` | `(fd: 0 \| 1 \| 2) => boolean` | |
| `columns` | `(fd: 0 \| 1 \| 2) => number` | 0 when not a TTY |
| `resolve` | `(specifier, fromFile, kind) => Resolved` | `kind` is `"require"` or `"import"`; throws Node-shaped errors |
| `readFile` | `(path) => string` | UTF-8; throws Node-shaped errors |
| `realpath` | `(path) => string` | |
| `statKind` | `(path) => "file" \| "dir" \| "other" \| null` | `null` when missing |
| `builtinSource` | `(name) => string \| null` | embedded stdlib source, including `internal/*` modules |
| `builtinNames` | `() => string[]` | |
| `evalCjs` | `(filename, source, exports, require, module, dirname) => void` | compiles the CJS wrapper with the real filename (stack traces) and calls it with `this === exports` |
| `cjsNamespace` | `(path) => any` | load a CJS file and return `module.exports` (ESM interop) |
| `builtinExports` | `(name) => any` | load a builtin and return its exports (ESM interop) |
| `detachBuffer` | `(buffer) => void` | `JS_DetachArrayBuffer`, for `transferList` |
| `workers` | registry object | `register(id, sink)` / `release(id)`, filled by `bootstrap.js` |
| `workerInfo` | `null \| { id, threadId, workerData }` | `null` on the main isolate; workerData is deserialized on the worker thread |
| `worker` | `(id, name, args) => any` | `spawn`, `postMessage`, `terminate`, `ref`, `unref`; worker role routes self messages to the parent |
| `procHandles` | registry object | `register(id, sink)` / `release(id)`, filled by `bootstrap.js` |
| `proc` | `(id, name, args) => void` | spawn/write/end/read/readStop/kill/send/disconnect/ref/unref |
| `ipcFd` | `number \| null` | descriptor named by `ONDE_IPC_FD`, set only in a forked child |
| `ipc` | `(name, args) => bool` | `attach`, `send`, `disconnect`, `ref`, `unref` on the forked child's channel |
| `signal` | `(number, on) => void` | subscribe/unsubscribe a main-isolate signal listener |
| `signalNumber` / `signalName` | `(name) => number \| null`, `(number) => string \| null` | platform signal table |
| `kill` | `(pid, signal) => true` | throws `ESRCH`/`EPERM` like `process.kill` |
| `cpuUsage` | `() => { user, system }` | `getrusage`, microseconds |
| `buffer.encodeBase64` | `(view, start, end, urlSafe) => string` | borrowed view bytes; the JS seam clamps the range and picks the alphabet |
| `buffer.decodeBase64` | `(text, urlSafe) => Uint8Array` | fresh array; ignores non-alphabet bytes and accepts both alphabets, as Node does |
| `buffer.encodeHex` | `(view, start, end) => string` | lowercase; same borrowed-view and clamped-range rules as base64 |
| `buffer.decodeHex` | `(text) => Uint8Array` | fresh array; stops at the first non-hex pair and drops an odd trailing digit |
| `text.decodeStream` | `(data, start, end, pending, fatal) => { text, pending } \| null` | UTF-8 streaming split for `StringDecoder`; `null` means the prefix was invalid under `fatal` |
| `sqlite` | object of primitives | `node:sqlite` handles: `open`, `close`, `exec`, `prepare`, `finalize`, `bind`, `run`, `all`, `first`, `begin`, `next`, `finish`, `columns`, `stat`, `resetStats`, `sourceSQL`, `expandedSQL`, `isOpen`, `isTransaction`, `location`, `serialize`, `deserialize`, `limit`, `setLimit`, `enableDefensive`, `backupInit`/`backupStep`/`backupFinish`, `version`, and the callback/session/extension entry points (`createFunction`, `createAggregate`, `setAuthorizer`, `createSession`, `sessionChangeset`, `sessionPatchset`, `sessionClose`, `applyChangeset`, `createModule`, `enableLoadExtension`, `loadExtension`); installed only when the `node-sqlite` feature is on |
| `nodeOnlyBuiltins` | `() => string[]` | builtin names reachable only as `node:<name>` (`sqlite`), so `isBuiltin` and `builtinModules` match Node |
| `builtinUnavailable` | `(name: string) => string \| null` | why a builtin compiled out of this build (any of `node-net`, `node-tls`, `node-crypto`, `node-sqlite`, `node-zlib` off) cannot load; the loader turns it into a readable `ERR_UNKNOWN_BUILTIN_MODULE` |

`buffer` and `text` are nested members (`__ln_host.buffer.*`, `__ln_host.text.*`), installed only
when the runtime provides the native codec; `internal/bytes.js` and `textcodec.js` fall back to
their JavaScript loops when they are absent (the Node oracle does exactly that).

`Resolved` is one of `{ type: "builtin", name }`, `{ type: "file", path }`,
`{ type: "json", path }`, `{ type: "esm", path }`, `{ type: "addon", path }`. `"file"` always
means CommonJS; `"esm"` is what makes `require()` throw `ERR_REQUIRE_ESM`.

Internal modules (not part of the public builtin list) are addressed as `internal/loader`,
`internal/process`, `internal/globals`, `internal/textcodec`, `internal/net`, `internal/pipe` and
`internal/worker`; they are evaluated once by `bootstrap.js`, and stdlib modules can also
`require("./sibling.js")` because the loader maps relative requires made from `<onde:...>` modules
onto that registry. `internal/worker` is loaded eagerly on a worker isolate so a parent message
that arrives before user code is queued for `parentPort` rather than dropped.

`internal/errors` and `internal/bytes` are leaf helpers in that registry: `errors` requires
nothing and `bytes` requires only `errors`, so either can be loaded from any stdlib module
regardless of order. They are resolved through the same virtual tree as every other `internal/*`
module, which means a new one must also be registered in `crates/ln-runtime/src/modules.rs`.

## Testing the stdlib without the runtime

`test/js/host-shim.js` implements the contract with Node's own `process`/`os`/`fs`, so a stdlib
module can be exercised under plain `node`:

```js
globalThis.__ln_host = require("../host-shim.js")();
const path = require("../../../js/lib/path.js");
```

Two test conventions live in `test/js/lib/`:

- `<name>.test.js` — self-checking, runtime-agnostic: it requires **our** module by relative path
  and asserts against literals. It must pass unchanged under `node` and under `onde`.
- `<name>.oracle.js` — Node-only differential: compares our module against the Node builtin and
  is only run when the oracle exists.

`test/js/run.sh` runs every `*.test.js` under both runtimes and every `*.oracle.js` under Node.

## Quality bar

`docs/compat.md` is the source of truth for what "supported" means. A module is done when its
common path matches Node, argument validation throws the same error *name* and (where practical)
`code`, and every known gap is listed in `docs/compat.md` with a divergence id rather than
silently different.
