# ADR-0007: The HTTP/1.1 codec is a sans-io state machine

- Status: accepted
- Date: 2026-11-14
- Supersedes: none
- Related: [0005 ops protocol](0005-ops-protocol.md),
  [0006 handles and events](0006-handles-and-events.md), [M4 plan](../m4-plan.md)

## 1. Context

M4 ships `http`/`https` server and client. The roadmap calls HTTP/1.1 correctness the milestone's
time sink and asks for scope control. Three questions decide most of the cost:

1. **Where does parsing run?** Node parses with llhttp (C) and layers the API in JS. A JS parser in
   onde would be byte-scanning inside QuickJS, which has no JIT; the 20k req/s criterion rules it
   out.
2. **Who owns the connection?** Node's API hands the user the socket: `'connection'`, `'upgrade'`,
   `CONNECT`, `socket.setNoDelay`, `destroy`. A codec that owns the socket cannot offer those.
   [ADR-0006](0006-handles-and-events.md) §2.8 rejects hyper on exactly this point.
3. **What is the test surface?** HTTP framing bugs (chunked termination, `Content-Length` with a
   body on a 304, header folding, trailers) are found fastest by feeding byte strings, not by
   opening sockets.

## 2. Decision

**`ln-http` is a pure state machine with bytes in and bytes out. It has no socket, no tokio, no
engine, and no clock.**

1. **One type, two roles.** `ln_http::Conn::new(Role::Server | Role::Client, Limits)`. The role
   selects which head is expected and which body mode applies.

2. **Inbound: `feed(&mut self, bytes: &[u8])`** appends to a bounded buffer and advances the state
   machine, queuing events. `next_event()` drains them. Events are:

   ```rust
   enum Event {
       Request { method, target, version, headers, keep_alive, expect_continue, body: BodyMode },
       Response { status, reason, version, headers, keep_alive, body: BodyMode },
       Body { bytes: Vec<u8> },              // de-framed (chunked or length)
       MessageEnd { trailers: Vec<(String, String)> },
       Upgrade { bytes: Vec<u8> },           // 101/CONNECT: bytes read past the head, unparsed
   }
   ```

   Malformed input is not an event: `feed` returns `Result<(), ProtocolError>`, the codec enters a
   failed state, and the transport emits the error as its own `clientError` event. One
   representation, one close path.

3. **Head parsing is `httparse`.** It is allocation-free, hardened against malformed input, and
   handles request/response lines and header fields. `ln-http` keeps headers as
   `Vec<(String, String)>` in wire order, which is what `rawHeaders` needs; it does not use
   `http::HeaderMap` and does not lowercase stored names, so case survives to the JS layer.

4. **Framing is ours, and it is the point.** Chunked decode/encode, `Content-Length` bounds, EOF
   bodies, trailers, and the no-body rules (HEAD, 204, 304, 1xx) are implemented here, with a
   table-driven malformed corpus from RFC 9112 and Node's own raw-wire tests. Pipelining is
   rejected: after each message the connection waits for the response before parsing the next
   request, which is what Node's JS layer does anyway.

5. **Outbound heads are authored in JS and parsed here only for framing.**
   `encode_head(&mut self, head: &[u8])` validates that the bytes are a legal head (status line or
   request line, well-formed fields) and records the body mode it implies. It never re-serializes,
   so header order, case and spacing are exactly what the user wrote. `encode_body(chunk, out)`
   applies the framing; `finish(out)` writes the chunked terminator. This is also where JS-side
   `writeHead` validation lands: the JS layer throws at the call site for bad tokens/status, and
   the codec refuses a malformed head that got past it.

6. **Limits are in one place.** `Limits { max_head_bytes: 16 * 1024, max_headers: 2000 }`, mapping
   to Node's `--max-http-header-size` and `server.maxHeadersCount`. Oversize head → `431`, malformed
   → `400`, and both leave the connection closable, so slow-loris cannot allocate without bound.
   The read side is pull-based (ADR-0006 §2.3), so the parser never has more than one bounded chunk
   in flight.

7. **The peer's intent is reported, the local decision is commanded.** The codec reports
   `keep_alive` from the request/response headers and version. Whether the server actually keeps the
   connection open is JS's call (`server.keepAliveTimeout`, `maxRequestsPerSocket`,
   `res.shouldKeepAlive`), so the response ends with `Command::HttpEnd { keep_alive }` and the task
   obeys it. The codec never decides to close on its own except on a parse error.

8. **`100-continue` is surfaced, not assumed.** `expect_continue` is set on the request event and
   `write_continue(out)` writes the interim response; the JS layer decides between the
   `'checkContinue'` listener and Node's default. Interim 1xx responses are otherwise passed
   through as `Response` events for the client role.

## 3. Invariants

| ID | Invariant |
|---|---|
| C1 | `ln-http`'s only dependencies are `ln-error` and `httparse`; it compiles without tokio, an engine or a clock |
| C2 | The same `Conn` drives TCP, TLS and Unix sockets; transport is the caller's problem |
| C3 | Every emitted byte is either a head the caller authored or framing this crate added; the two never mix |
| C4 | Inbound buffering is bounded by `max_head_bytes` for a head and by one body chunk otherwise |
| C5 | A malformed message yields exactly one `ProtocolError` and puts the codec in a failed state; no further events |

## 4. Alternatives considered

- **hyper's client/server**: see ADR-0006 §2.8. Rejected.
- **`llhttp` bindings** (Node's own parser): exact parity on malformed-input behaviour, but a C
  dependency with immature Rust bindings and no ability to preserve the caller's outbound bytes.
  Rejected.
- **A JS parser over `Buffer`**: simplest to debug, but no JIT and it moves per-request work into
  the isolate thread, which also owns microtasks. Rejected on throughput and on head-of-line
  blocking.
- **`http` crate for header storage**: normalizes names and does not model wire order, so
  `rawHeaders` would need a parallel structure anyway. Rejected; `httparse` plus our own
  `Vec<(String, String)>` is less code and exact.
- **Integrating the codec into the socket task** (no sans-io split): less plumbing, but every
  framing test would need a socket or a fake transport, and the same FSM has to run over TLS and
  Unix sockets. Rejected.

## 5. Consequences

- WP2 can develop the entire HTTP/1.1 surface against byte vectors before WP1's transport exists,
  which is what makes the 6-week schedule parallel rather than serial.
- The JS `http` layer owns policy (keep-alive, timeouts, `Agent` pooling, `checkContinue`) and
  Rust owns framing. That is the same split as `fs`: policy in JS, syscalls in Rust.
- Chunk-boundary parity with Node is not promised (Node does not promise it either); `rawHeaders`,
  status, body bytes and event ordering are.
- A malformed-input bug is a 10-line test case instead of a flaky socket test, and the fuzz corpus
  is a build artifact rather than a service.
