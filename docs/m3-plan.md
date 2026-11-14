# M3 implementation plan — I/O core

This is the working contract for M3. [roadmap.md](roadmap.md#m3--io-core-5-w) says *what* ships;
this page says *where* it lives, *how* the host boundary works, and who owns which file. The
decisions behind it are [ADR-0005](adr/0005-ops-protocol.md).

Status: in progress. The Rust crates `ln-error`, `ln-io`, `ln-crypto` exist as compiling skeletons
with the public types locked (this page and those files are the interface; extend, don't rename).
No JS module in §4 exists yet.

## 1. Crate graph changes

```
ln-runtime ──┬─▶ ln-sched
             ├─▶ ln-engine ──▶ ln-sys
             ├─▶ ln-modules
             ├─▶ ln-error      (NodeError → JS Error)
             ├─▶ ln-io ────────┘  (fs ops + tokio offload pool)
             └─▶ ln-crypto ────┘  (hash/HMAC/HKDF/random, no tokio)
```

New external dependencies, and nothing else:

| Crate | Where | Why |
|---|---|---|
| `tokio` 1 (`rt-multi-thread`, `sync`, `time`) | `ln-io` | the offload pool; `spawn_blocking` is the fs executor |
| `libc` 0.2 (unix) | `ln-io` | `open`/`fsync`/`utimensat`/`chown`/`access`/errno where `std` has no safe wrapper |
| `getrandom` 0.2 | `ln-io` (`mkdtemp`), `ln-crypto` | OS entropy without an RNG framework |
| `sha2`/`sha1`/`md-5` 0.10, `hmac`/`hkdf` 0.12 | `ln-crypto` | RustCrypto, MIT/Apache, no C toolchain |
| `tempfile` 3 (dev) | `ln-io` | fs tests without hand-rolled cleanup |

Explicitly **not** added: `mio` (ADR-0003), `notify` (`fs.watch` polls), `ring`/`openssl` (C
toolchain, size), `uuid`/`rand` (covered by `getrandom`), `bytes`/`walkdir`/`glob`/`atty`/
`filetime`/`nix` (`std` + `libc` cover them). `cargo deny` is still missing from CI and must land
before M4's `webpki-roots` (MPL-2.0); it is not needed for M3.

## 2. The host boundary

The isolate thread is the only place JS values exist. Everything below is a primitive-typed
function on the `host` object that `js/bootstrap.js` receives as `__ln_host`.

### 2.1 Callback ids, not JS functions in Rust

Timer callbacks already use this pattern: JS registers a callback, gets an id, and Rust later
calls `__ln_dispatch(id, ...)`. Ops use the same pattern, extended with results:

- JS allocates a monotonically increasing `opId` and registers a settler in a JS-side
  `Map<opId, { resolve, reject } | { callback }>`.
- Rust stores `opId` as the `RequestId`, and only ever holds that number.
- On completion, the runtime calls `__ln_op_done(opId, errorOrNull, valueOrUndefined)` from the
  completion dispatch, then checkpoints.
- `__ln_op_done` settles exactly once and deletes the entry. A throw from a user callback
  therefore propagates out of the dispatch and is routed to `uncaughtException`, not to
  `unhandledRejection`.

### 2.2 `fs` primitives

Two entry points plus cancellation, so the binding surface stays one dispatch table instead of
sixty closures. `name` is the op name; `args` is a JS array of primitives in the order listed
(strings, numbers, booleans, `Uint8Array`, `null`). The JS layer builds the array; Rust validates
it into an `Op`. M7 may specialize hot ops into typed bindings — the op semantics stay identical.

```
host.fsSync(name, args)                    -> value, throws
host.fsAsync(opId, name, args)             -> undefined   (completion via __ln_op_done)
host.fsCancel(opId)                        -> void        (sets the op's abort flag)
```

| `name` | `args` | result |
|---|---|---|
| `readFile` | `path` | `Uint8Array` |
| `writeFile` / `appendFile` | `path, data, mode, flags` | — |
| `copyFile` | `src, dst, flags` | — |
| `mkdir` | `path, mode, recursive` | `string \| null` (first created path) |
| `mkdtemp` | `prefix` | `string` |
| `readdir` | `path, withTypes` | `Array<{name, kind}>` |
| `rm` | `path, recursive, force, maxRetries, retryDelayMs` | — |
| `rmdir` | `path, recursive` | — |
| `unlink` / `readlink` | `path` | — / `Uint8Array` |
| `rename` | `from, to` | — |
| `stat` / `lstat` | `path` | `StatObject` |
| `statfs` | `path` | `StatFsObject` (`type,bsize,frsize,blocks,bfree,bavail,files,ffree`) |
| `fstat` | `fd` | `StatObject` |
| `access` | `path, mode` | — |
| `chmod` / `chown` | `path, mode\|uid, gid, follow` | — |
| `truncate` / `ftruncate` | `path\|fd, len` | — |
| `symlink` | `target, path` | — |
| `link` | `existing, newPath` | — |
| `realpath` | `path` | `string` |
| `utimes` | `path, atimeMs, mtimeMs, follow` | — |
| `open` | `path, flags, mode` | `number` (fd) |
| `close` | `fd` | — |
| `read` | `fd, length, position` | `Uint8Array` (may be empty at EOF) |
| `write` | `fd, data, position` | `number` (bytes written) |
| `fsync` / `fdatasync` / `fchmod` / `fchown` / `futimes` | `fd, …` | — |

`StatObject` keys: `dev ino mode nlink uid gid rdev size blksize blocks atimeMs mtimeMs ctimeMs
birthtimeMs` (numbers; the JS `Stats` class adds the `Date` getters). `kind` is
`0 unknown, 1 file, 2 dir, 3 symlink, 4 fifo, 5 socket, 6 char, 7 block`.

`readdir` always returns entries (`{name, kind}`), even without `withFileTypes`; the JS layer maps
to names. `read` returns the bytes actually read; the JS layer copies them into the caller's
buffer. `position: -1` means "current offset".

### 2.3 `crypto` primitives

Synchronous, CPU-only, no loop involvement:

```
host.crypto.randomBytes(size)              -> Uint8Array
host.crypto.randomInt(min, max)            -> number
host.crypto.randomUUID()                   -> string
host.crypto.hashNew(algorithm)             -> number   (state id)
host.crypto.hashUpdate(id, data)
host.crypto.hashDigest(id)                 -> Uint8Array  (consumes the state)
host.crypto.hashCopy(id)                   -> number
host.crypto.hmacNew(algorithm, key)        -> number
host.crypto.hmacUpdate(id, data)
host.crypto.hmacDigest(id)                 -> Uint8Array  (consumes the state)
host.crypto.timingSafeEqual(a, b)          -> boolean     (throws on length mismatch)
host.crypto.hkdf(algorithm, ikm, salt, info, length) -> Uint8Array
```

### 2.4 stdio primitives

```
host.writeFd(fd, data)                     -> number   (sync write, for 1/2 and tty spans)
host.isTTY(fd) / host.columns(fd)          // already exist
```

`process.stdin` uses `host.fsAsync.read(0, len, -1)`; `process.stdout`/`stderr` use
`host.writeFd`. Console keeps `host.write` in M3.

## 3. Ownership and phases

One owner per file at a time. Do not edit a file outside your package; if a change is needed
there, leave a note in your final report instead.

| WP | Work | Owner | Files |
|---|---|---|---|
| WP1 | `ln-error` (codes, errno/message tables, arg errors) + `ln-io` (all ops, pool, unit tests) | agent `io-ops` | `crates/ln-error/**`, `crates/ln-io/**` |
| WP2 | `ln-crypto` + `js/lib/crypto.js` + tests | agent `crypto` | `crates/ln-crypto/**`, `js/lib/crypto.js`, `test/js/lib/crypto*.js`, `test/conformance/crypto/**` |
| WP3 | `js/lib/stream.js`, `js/lib/stream-promises.js` + tests | agent `streams` | `js/lib/stream.js`, `js/lib/stream-promises.js`, `test/js/lib/stream*.js`, `test/conformance/stream/**` |
| WP4 | op table, `__ln_op_done`/`__ln_op`, host `fsSync`/`fsAsync`/`crypto`/`writeFd`, builtin registry, `--io-threads` | agent `bridge` | `crates/ln-runtime/**`, `js/bootstrap.js`, `crates/ln-modules/src/builtin.rs`, `crates/ln-cli/src/main.rs` |
| WP5 | `js/lib/internal/fs.js`, `js/lib/fs.js`, `js/lib/fs-promises.js` + tests | agent `fs-surface` (after WP1+WP4) | `js/lib/internal/fs.js`, `js/lib/fs.js`, `js/lib/fs-promises.js`, `test/js/lib/fs*.js`, `test/conformance/fs/**` |
| WP6 | `process` stdio rewrite, `tty`, `perf_hooks` + tests | agent `stdio` (after WP3) | `js/lib/process.js`, `js/lib/tty.js`, `js/lib/perf_hooks.js`, `test/js/lib/tty*.js`, `test/conformance/stdlib/perf*.js` |
| WP7 | `cat`/`wc -l`/`cp -r` programs, integration corpus, docs status, fd-leak stress | lead | `test/programs/**`, `test/conformance/fsp/**`, `test/stress/**`, docs |

WP1/WP2/WP3 run in parallel. WP4 proceeds against the locked interfaces. WP5 and WP6 start when
their dependency lands.

## 4. fs semantics that are easy to get wrong

- **`mkdir({recursive})`** resolves the *first created* path (topmost missing directory), or
  `undefined` when everything existed. Walk up to the first existing ancestor, then create down,
  remembering the first one created. `mkdtemp` retries on `EEXIST` with fresh entropy.
- **`rm`** ignores `ENOENT` when `force`, retries `ENOTEMPTY`/`EBUSY`/`EPERM`/`EMFILE` up to
  `maxRetries` with `retryDelay`, and refuses `"."`/`".."` with `ERR_FS_EISDIR`/`EINVAL`.
  `rm -r` on a symlink removes the link, never the target.
- **`readdir`** returns `string[]` or `Dirent[]`; `recursive` adds relative paths (`a/b`), and
  symlinked directories are not descended.
- **`stat`** follows symlinks; `lstat` does not; the `follow` flag maps to `stat` vs `lstat` at
  the syscall. macOS reports birth time; Linux reports `ctimeMs` in both `birthtimeMs` and
  `ctimeMs` (Node does the same).
- **`realpath`** is `canonicalize`; `.native` aliases it. It resolves symlinks and makes the path
  absolute.
- **`read`/`write`** take explicit `position`; `-1` uses the file offset. `read` returns at most
  `length` bytes; EOF is an empty result, not an error.
- **`access`** uses `access(2)` semantics (effective ids), not a permission-bit test.
- **`utimes`** is `utimensat(AT_SYMLINK_NOFOLLOW)` when `follow` is false, so `lutimes` does not
  touch the target.
- **fds are real OS fds**, because Node exposes them (`FileHandle.fd`, `fs.open`'s result). Closing
  an already-closed fd is `EBADF`. A double close that would hit a reused fd is prevented by the
  JS-side open-fd set; the fd-leak test counts descriptors before/after.
- **paths** reach Rust as UTF-8 strings. The JS layer converts `URL` with `fileURLToPath` and
  `Buffer` paths with UTF-8 decoding (documented gap for non-UTF-8 Buffer paths).
- **`AbortSignal`**: register one listener per op, remove it on settle; on abort call
  `host.fsCancel(opId)`. The rejection is `AbortError` with `code === "ABORT_ERR"`.

## 5. Error delivery

| Surface | Invalid argument | Syscall failure |
|---|---|---|
| `fs.readFileSync` etc. | throws synchronously | throws |
| `fs.readFile(path, cb)` | throws synchronously (Node does) | `cb(err)` once, no throw |
| `fs.promises.readFile` | rejects | rejects |
| `createHash`/`randomInt` etc. | throws | throws |

Every error carries `code`; system errors also carry `errno`, `syscall`, `path`, and a message of
the form `ENOENT: no such file or directory, open '/x'`. Coded argument errors use
`TypeError`/`RangeError` with the code on the error, not in the message.

## 6. Verification

Per package, run only what you own (do not run workspace-wide `cargo fmt`/`clippy`; other agents
are editing):

| WP | Command |
|---|---|
| WP1 | `cargo test -p ln-error -p ln-io` and `cargo clippy -p ln-error -p ln-io --all-targets -- -D warnings` |
| WP2 | `cargo test -p ln-crypto`, `cargo clippy -p ln-crypto --all-targets -- -D warnings` |
| WP3/WP5/WP6 | `node test/js/lib/<file>.test.js` where possible; final `./test/js/run.sh` is the lead's |
| WP4 | `cargo test -p ln-runtime -p ln-cli`, `cargo build` |

Recording expectations: never record from onde (the `lite` binary). Use `REGEN=1 RUN=node ./test/conformance/run.sh`
for corpus cases, and keep printed output deterministic (basenames, not absolute temp paths; no
mode/mtime assertions that depend on the host umask).

Integration gate for M3 (the lead runs these): `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test --all`, `./test/conformance/run.sh`,
`RUN=node ./test/conformance/run.sh`, `./test/differential.sh`, `./test/js/run.sh`,
`./test/smoke/run.sh`, `./test/programs/run.sh`, `./test/stress/run.sh`.
