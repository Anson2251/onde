# M4 implementation plan — network

This is the working contract for M4. [roadmap.md](roadmap.md#m4--network-6-w) says *what* ships;
this page says *where* it lives, *how* the host boundary works, and who owns which file. The
decisions behind it are [ADR-0006](adr/0006-handles-and-events.md) (handles/events) and
[ADR-0007](adr/0007-http-codec.md) (HTTP codec).

Status: in progress (2026-11-14). **WP0–WP2 are done.** The locked interfaces exist
(`ln_io::net`'s protocol types, `ln-http`'s codec), `ln-io` runs live TCP/Unix connections with
raw and parsed modes, and the HTTP/1.1 codec is complete with 38 wire tests. The JS surfaces
(WP4–WP6) have not started; see §9 for the interface additions and the gaps that are recorded
rather than fixed. Interfaces stay **extend, don't rename**.

## 1. Crate graph changes

```
ln-runtime ──┬─▶ ln-sched
             ├─▶ ln-engine ──▶ ln-sys
             ├─▶ ln-modules
             ├─▶ ln-io ──▶ ln-http      (M4 transports → sans-io codec)
             └─▶ ln-crypto

ln-runtime, ln-io, ln-http, ln-crypto ──▶ ln-error
```

One new crate (`ln-http`); `ln-io` grows a `net` module rather than a new transport crate, because
it already owns the only tokio runtime and the pool must stay a single lazy singleton.

New external dependencies, and nothing else:

| Crate | Version | Where | Why |
|---|---|---|---|
| `tokio` (`net`, `io-util`, plus existing `rt-multi-thread`, `sync`, `time`) | 1 | `ln-io` | sockets, DNS, async I/O |
| `httparse` | 1 | `ln-http` | head parsing only; allocation-free, hardened |
| `socket2` | 0.6 | `ln-io` | SO_KEEPALIVE tuning, SO_LINGER: what tokio does not expose |
| `rustls` (`ring` provider, no `aws-lc-rs`) | 0.23 | `ln-io` | TLS; the default provider adds cmake/nasm to every build |
| `tokio-rustls` | 0.26 | `ln-io` | async TLS stream |
| `rustls-pemfile` | 2 | `ln-io` | PEM parsing for `ca`/`cert`/`key` |
| `webpki-roots` | 1 | `ln-io` | Node-like bundled Mozilla store (MPL-2.0, allowlisted in `deny.toml`) |
| `rustls-native-certs` | 0.8 | `ln-io` | `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` escape hatch |

Explicitly **not** added as direct dependencies: `hyper`/`http`/`http-body` (ADR-0006 §2.8),
`mio` (ADR-0003; tokio's `net` feature brings it in transitively), `llhttp` (C), `openssl`,
`bytes`, `futures`, `hickory-resolver` (deferred with `dns.resolve*`).

`cargo deny` lands with WP0 (`deny.toml` + a CI job) because `webpki-roots` is MPL-2.0. The
policy is verified by that job, not locally: `cargo-deny` 0.16 cannot parse edition-2024 metadata
from a current dependency. The license set itself was checked against `cargo metadata` by hand
(everything resolved is MIT / Apache-2.0 / BSD / ISC / Zlib / Unicode / Unlicense, plus MPL-2.0
once `webpki-roots` lands).

## 2. The host boundary

### 2.1 One id space, two tables

There is a single `RequestId` sequence per isolate, owned by `ln-runtime` and used for **both** op
ids and handle ids, so an id is never ambiguous. JS asks for ids through `host.nextRequestId()`;
a pool task that creates a handle itself (an accepted connection) calls the `HandleIdSource`
closure it was constructed with. Both draw from the same atomic sequence, so WP3 makes the
allocator `Mutex`-backed and `Sync` instead of the `Cell`-based `RequestIdAllocator`. Rust's
completion router is:

```
Completion(id) → if op table has id: settle as today (ADR-0005)
                 else if handle table has id: drain that handle's event queue
                 else: ignore (stale completion after shutdown)
```

The `Completion` type does not change and `ln-sched` never learns about handles.

### 2.2 Commands

One entry point, mirroring `host.fsAsync`:

```
host.net(id, name, args) -> undefined, throws Node-shaped errors synchronously
```

Synchronous throws matter: `server.listen({ port: "x" })` must fail at the call site, not later on
an event.

| `name` | `args` | notes |
|---|---|---|
| `listen` | `host, port, backlog, ipv6Only, exclusive, tls` or `path, backlog, tls` | starts the accept task |
| `connect` | `host, port, family, localAddress, localPort, noDelay, keepAliveMs, tls` or `path, tls` | starts the connect task |
| `read` | `maxChunk` | pull one chunk (≤ 64 KiB); ignored while one is in flight. In parsed mode it resumes a paused body, and `maxChunk` does not apply (the codec blocks at `BODY_BLOCK_BYTES`) |
| `readStop` | — | stop pulling (`pause()`); in parsed mode it pauses the body stream, so the task stops reading the socket |
| `write` | `Uint8Array` | queued in order; `drain` when the queue empties |
| `end` | — | flush queued writes, then FIN; the read side stays open (half-close) |
| `destroy` | — | close now; `closed` is still emitted exactly once. A user-supplied `destroy(err)` is emitted by JS locally, so no error object crosses the boundary |
| `detach` | — | leave parsed mode, back to raw `data` |
| `httpAttach` | `role, maxHeadBytes, maxHeaders` | start the codec on this connection |
| `httpHead` | `Uint8Array` | JS-authored request/response head |
| `httpBody` | `Uint8Array` | body chunk; the codec frames it |
| `httpEnd` | `keepAlive` | finish the message; JS decides keep-alive |
| `httpContinue` | — | write the interim `100 Continue` (`res.writeContinue()`), before the final head |
| `setNoDelay` / `setKeepAlive` | `bool` / `enable, initialDelayMs` | live socket options |
| `ref` / `unref` | — | loop refcount, idempotent |

### 2.3 Events

```
__ln_handle_event(id, name, payload)
```

| `name` | payload | notes |
|---|---|---|
| `listening` | `{ address, family, port }` | `server.address()` is served from this, not a command |
| `connection` | `{ handle, address, family, port }` | server: a Rust-minted handle for the accepted socket |
| `connected` | `{ local, remote, alpn \| null }` | `alpn` is `"http/1.1"` or null |
| `data` | `Uint8Array` | raw mode only |
| `end` | — | peer FIN; `allowHalfOpen` handling is JS |
| `drain` | — | write queue empty |
| `timeout` | — | the task's `setTimeout`-style idle timer; JS decides whether to destroy |
| `error` | `{ code, message, errno?, syscall? }` | same shape as an op error |
| `closed` | `hadError` | always last, exactly once |
| `request` | `{ method, target, version, headers, keepAlive, expectContinue, body }` | parsed mode, server role; trailers arrive on `messageEnd` |
| `response` | `{ status, reason, version, headers, keepAlive, body }` | parsed mode, client role |
| `body` | `Uint8Array` | parsed mode, de-framed |
| `messageEnd` | `{ trailers }` | parsed mode |
| `upgrade` | `Uint8Array` | 101/CONNECT: bytes already read past the head, unparsed |
| `clientError` | `{ code, message }` | malformed request; the task has already answered 400/431 and closed (D42) |

`headers` is a **flat array** `[name, value, name, value, …]` in wire order, so `rawHeaders` is a
direct slice and no nested arrays are allocated per header. `body` is `"none" | "length: N" |
"chunked" | "eof"`.

### 2.4 HTTP mode

`httpAttach` switches a connected handle into parsed mode: the task feeds every read to
`ln_http::Conn`, and `data` is replaced by `request`/`response`/`body`/`messageEnd`/`upgrade`. A
zero-length read calls `Conn::end_of_stream()` (the codec's EOF signal, added by WP2 as an additive
method) and then drains events; a `feed` error drains the events queued before it *before* the
canned response, `clientError` and `Closed` are emitted, so Node's `request` → `clientError` order
holds. The socket object the user holds is unchanged, so `'connection'`, `'upgrade'` and `detach`
all refer to the same connection. The server task, after `messageEnd`, waits for `httpEnd` and uses
its `keepAlive` flag to decide between another round and a close — the codec never closes by
itself.

The response head is built in JS (`http.js`), so `writeHead` validation and header serialization
stay where the errors need to be thrown, and `Date`/`Connection`/`Transfer-Encoding` are computed
per Node's rules. Rust learns the framing by parsing the head it is about to send (ADR-0007 §2.5).

### 2.5 TLS options

Plain data crossing the boundary; JS reads PEM files with `fs.readFileSync`, so there is one file
path and one error shape:

```
connect: { servername, rejectUnauthorized, caPem: Uint8Array|null, alpn: string[] }
listen:  { certPem, keyPem, alpn: string[] }
```

Rust builds the `rustls::ClientConfig`/`ServerConfig` per handle (cached process-wide by a
content-hash of the options, so an `https.Agent` with 100 sockets builds one config).

### 2.6 DNS

`dns.lookup` is an **op, not a handle** (ADR-0005 unchanged): `Op::Lookup { host, family, all }`
executed on the blocking pool with `getaddrinfo`, returning `OpValue::Addrs(Vec<Addr>)`. The JS
`lookup` callback and `dns.promises.lookup` reuse the existing op table. `dns.resolve*` stays out
of M4.

## 3. Ownership and phases

One owner per file at a time. Do not edit a file outside your package; if a change is needed there,
leave a note in your final report instead.

| WP | Work | Owner | Files |
|---|---|---|---|
| WP0 | ADR-0006/0007, this plan, `ln_io::net` protocol types, `ln-http` skeleton, deps, `deny.toml` + CI | lead | `docs/**`, `crates/ln-io/src/net.rs`, `crates/ln-http/**`, `Cargo.toml`, `deny.toml`, `.github/workflows/ci.yml` |
| WP1 | transports (TCP/TLS/Unix), listener + connection tasks, commands/events, DNS op, fd accounting, EMFILE backoff | agent `net-core` | `crates/ln-io/src/net.rs`, `crates/ln-io/src/net/**`, `crates/ln-io/Cargo.toml`, `crates/ln-io/tests/net*.rs` |
| WP2 | `ln-http`: head parse (`httparse`), chunked codec, framing, limits, 100-continue, trailers | agent `http-codec` | `crates/ln-http/**` |
| WP3 | handle table, router, `host.net`/`host.dns`/`host.http`/`host.tls`, id allocator, flags. **First commit is a pure move**: `host.rs` → `host/{mod,fs,crypto,stdio}.rs`, reviewed with `git diff -M` | agent `bridge` | `crates/ln-runtime/src/**`, `js/bootstrap.js`, `crates/ln-modules/src/builtin.rs`, `crates/ln-cli/src/main.rs` |
| WP4 | `js/lib/internal/net.js`, `js/lib/net.js` + tests | agent `net-surface` | `js/lib/internal/net.js`, `js/lib/net.js`, `test/js/lib/net*.js`, `test/conformance/net/**` |
| WP5 | `js/lib/internal/http.js`, `http.js`, `https.js`, `Agent` | agent `http-surface` | `js/lib/internal/http.js`, `js/lib/http.js`, `js/lib/https.js`, `test/js/lib/http*.js`, `test/conformance/http/**` |
| WP6 | rustls wiring + `js/lib/tls.js` | agent `tls` | `crates/ln-io/src/net/tls.rs`, `js/lib/tls.js`, `test/js/lib/tls*.js` |
| WP7 | acceptance harness, interop matrix, load test, compat sweep, docs status | lead | `test/net/**`, `test/stress/**`, `docs/**` |

WP1 and WP2 start together (WP2 needs no sockets). WP3 starts against the locked interfaces. WP4
needs WP1+WP3; WP5 needs WP2+WP4; WP6 needs WP1.

## 4. `net` semantics that are easy to get wrong

- **`listen` binds asynchronously, but argument errors are synchronous.** `listen({port})` without
  a host binds `::` (dual-stack) when the platform allows it, else `0.0.0.0`; `ipv6Only: true`
  binds `::` only. `EADDRINUSE` arrives as an `error` event on the server, not a throw.
- **`connection` is emitted before any `data`.** The accept task must not start reading until JS has
  attached its listeners, which the pull-based `read` command gives for free: no `read` is issued
  until `'connection'` has been handled.
- **`end` vs `close`.** `end` is the read side reaching EOF. `close` is the handle gone, and it is
  always last, whether the path was `end`+`destroy`, an error, or a local `destroy`. `hadError` is
  true only when an `error` event was emitted for this handle.
- **Half-close.** `socket.end()` sends FIN but the socket stays readable until the peer's FIN, so
  `end` may arrive after `end()` returns. `allowHalfOpen: false` (default) makes JS call `end()`
  when `'end'` fires; `true` leaves the writable side open.
- **`pause`/`resume` are real.** At most one `read` is outstanding. `pause` sends `readStop`; data
  already in the task's buffer is delivered after resume, so no byte is lost and no kernel buffer
  grows unbounded.
- **`unref` is a loop-ref toggle, not a read stop.** An unref'd socket still reads; it just does not
  keep the process alive. `Agent`'s idle pool relies on this.
- **`drain` is a queue-empty signal.** The task emits it whenever its write queue empties, which can
  be after any write. Node's `'drain'` only follows a `write()` that returned `false`, so `net.js`
  emits it conditionally (WP4); the task's event is the primitive, not the public behaviour.
- **Parsed-mode backpressure uses `read`/`readStop`.** `IncomingMessage.pause()` is `httpPause`
  (or `readStop`), and `_read` is `read`; while paused the task does not pull from the socket at
  all, so a slow consumer bounds the parked events (H7) instead of buffering the upload.
- **EMFILE on accept.** Node emits `error` on the server and backs off. The task retries after a
  short sleep instead of spinning, and the fd count is asserted flat in the 10k-connection test.
- **`setTimeout(0)` disables the timer.** Socket idle timeouts are JS timers in WP4 (reset on
  `data`/`drain`), so `ln-sched` stays the only source of timers and `Event::Timeout` remains
  reserved. JS decides whether a timeout destroys the socket.

## 5. `http` semantics that are easy to get wrong

- **`rawHeaders` is wire order, `headers` is lowercased** with duplicate `set-cookie` collected into
  an array and duplicates of most other names joined with `, `. Both come from the same flat array.
- **No body on HEAD, 204, 304, 1xx.** A `Content-Length` on a 304 is metadata, not a body; reading
  it as one desynchronizes the connection. This is the single most common framing bug.
- **Chunked request bodies are de-framed before `'data'`.** The JS `IncomingMessage` never sees
  chunk sizes; trailers arrive on `'end'` as `req.trailers`.
- **`writeHead` validation throws at the call site**: status must be 100–999, header names must be
  tokens (`ERR_INVALID_HTTP_TOKEN`), values must not contain CR/LF (`ERR_INVALID_CHAR`).
- **Keep-alive is JS's decision, carried on `httpEnd`.** `server.keepAliveTimeout` (5 s),
  `headersTimeout` (60 s), `requestTimeout` (300 s) and `maxRequestsPerSocket` (0 = unlimited) are
  JS timers and counters; the task only obeys and reports.
- **`100-continue`**: with a `'checkContinue'` listener, Node does not send the interim response
  automatically; without one it does. `res.writeContinue()` writes it, and writing a real response
  instead is legal (the client must handle it).
- **`clientError` gets a socket it may not use.** After a parse error the task has already closed
  the connection, so JS must not write a response: the task writes the canned `400`/`431` itself
  from `ProtocolError::status` before closing, and the event is informational. This is narrower
  than Node, where `clientError` can still write; recorded as a divergence (D42).
- **`'upgrade'` needs a `detach`.** The task emits `upgrade` with the bytes read past the head and
  then parks at most one read; `http.js` calls `detach` before it expects `data` on the upgraded
  socket. The parked bytes are flushed as the first `data` after `detach`.
- **`Agent` is a JS pool of idle sockets.** `keepAlive: true` is the Node 19+ default; free sockets
  are `unref`'d and evicted after `keepAliveTimeout`. Reusing a socket means a new `httpAttach`
  cycle on the same handle, not a new connection.

## 6. Scope ladder

**Tier A (M4 exit criteria):** TCP + Unix client/server, IPv4/IPv6, `data`/`end`/`error`/`close`,
half-close, `pause`/`resume`, `setTimeout`, `setNoDelay`, `setKeepAlive`, `ref`/`unref`; `dns.lookup`
(`all`, `family`, `hints`); `http` server and client with chunked, keep-alive, trailers,
`100-continue`, `Agent`; `https` via rustls with `rejectUnauthorized`, `ca`, `servername`, ALPN
`http/1.1`.

**Tier B (nice, if the schedule holds):** `server.getConnections`, `maxConnections`,
`server.closeAllConnections`/`closeIdleConnections`, `bytesRead`/`bytesWritten`, custom `lookup`
function, `socket.setEncoding`, `http.request({ socketPath })`, `getPeerCertificate` fields.

**Deferred, documented:** `dgram`, `dns.resolve*`, HTTP/2, `CONNECT` proxying, `tls` session
reuse/renegotiation, `net.Socket({ fd })`, `_handle`, `cluster`.

## 7. Verification

Per package, run only what you own (do not run workspace-wide `cargo fmt`/`clippy`; other agents
are editing):

| WP | Command |
|---|---|
| WP1 | `cargo test -p ln-io`, `cargo clippy -p ln-io --all-targets -- -D warnings` |
| WP2 | `cargo test -p ln-http`, `cargo clippy -p ln-http --all-targets -- -D warnings` |
| WP3 | `cargo test -p ln-runtime -p ln-cli`, `cargo build` |
| WP4/WP5/WP6 | `node test/js/lib/<file>.test.js` where possible; final `./test/js/run.sh` is the lead's |

Recording expectations: never record from onde. Use `REGEN=1 RUN=node ./test/conformance/run.sh`
for corpus cases. Network cases must bind `127.0.0.1:0`, print the assigned port only through the
test's own output, avoid absolute paths, and never assert wall-clock timings.

Integration gate for M4 (the lead runs these): `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test --all`, `./test/conformance/run.sh`,
`RUN=node ./test/conformance/run.sh`, `./test/differential.sh`, `./test/js/run.sh`,
`./test/smoke/run.sh`, `./test/programs/run.sh`, `./test/stress/run.sh`, `./test/net/run.sh`.

## 8. Exit criteria

| Criterion | Evidence |
|---|---|
| hello-world keep-alive server > 20k req/s, p99 < 5 ms locally | `test/net/bench.sh` (release, 1 core, 100 connections) |
| interop: lite↔node, node↔lite, curl↔lite | `test/net/interop.sh` 4-way matrix |
| 60 `net` + 40 `http` corpus cases recorded from `node v26.10.0` | `test/conformance/net/**`, `test/conformance/http/**` |
| 10k connect/disconnect: fd count flat, RSS flat | `test/net/fdleak.sh`, `test/stress/` |
| slow-loris: 10k half-open conns bounded, 431 past `maxHeaderSize` | `test/net/slowloris.sh` |
| no scheduler regression: M1 corpus byte-identical | `./test/conformance/run.sh` |
| cold start unchanged (~13 ms) | release `lite -e '1+1'`, 25 runs |

## 9. Status and known gaps (after WP0–WP2)

Interface additions made after the WP0 scaffold, all additive:

| Addition | Why |
|---|---|
| `ln_io::net::HandleIdSource` | accepted connections need ids from the same sequence as JS-minted ones |
| `Conn::end_of_stream()` | the codec has no other way to learn the socket hit EOF, so `BodyMode::Eof` bodies can complete |
| `Command::HttpContinue` | `res.writeContinue()` needs to reach `Conn::write_continue` |
| `Pool::handle()` and `.enable_io()` | connection tasks are spawned on the same runtime, which must have I/O enabled |
| parsed-mode `read`/`readStop` | `IncomingMessage.pause()`/`_read`; without it a slow consumer grows the parked events without bound (H7) |

Recorded gaps, deliberately not fixed in M4's first half:

- **No `Conn::take_remainder()`.** A manual `detach` in the middle of a message cannot hand back the
  bytes the codec buffered without completing it. Detach at a message or head boundary; the
  `'upgrade'` path already does.
- **Socket and EAI errnos live in `ln-io::net::error`**, delegating to `ln-error` where it knows the
  errno. They belong in `ln-error`'s table once it grows beyond filesystem errnos.
- **`Event::Timeout` is never emitted** (§4): timeouts are JS timers.
- **Outbound trailers are Tier B**: `finish` writes `0\r\n\r\n` with no trailer fields; inbound
  trailers are parsed and reported.
- **TLS is a seam** (`Transport::{Tcp, Unix}`); WP6 adds rustls.
- **`exclusive: true` disables `SO_REUSEADDR`** rather than reproducing `SO_REUSEPORT`/cluster fd
  sharing, and a Unix socket file is not unlinked on close (Node does not either).
