//! Sans-io HTTP/1.1 codec: bytes in, events out. No socket, no tokio, no engine, no clock.
//!
//! The design is [ADR-0007](../../docs/adr/0007-http-codec.md); the contract with the transport is
//! [m4-plan.md](../../docs/m4-plan.md) §2.4. One [`Conn`] drives a client or a server connection
//! over any byte stream, which is what lets the parser be tested with vectors and reused over TCP,
//! TLS and Unix sockets.
//!
//! **This file is the locked M4 interface.** WP2 implements it; extend the types, do not rename
//! them.
//!
//! Inbound:
//!
//! ```text
//! feed(bytes) -> Result<(), ProtocolError>      // advance the state machine, queue events
//! next_event() -> Option<Event>                 // drain in wire order
//! ```
//!
//! Outbound (the head is authored in JS, so it is never re-serialized here):
//!
//! ```text
//! encode_head(head) -> Result<(), ProtocolError>  // validate + learn the framing
//! encode_body(chunk, out)                         // apply content-length / chunked framing
//! finish(out)                                     // write the chunked terminator, if any
//! write_continue(out)                             // interim 100 Continue
//! ```
//!
//! # Framing decisions
//!
//! The points RFC 9112 leaves to the implementation are fixed here, so the JS layer and the tests
//! can rely on one behaviour:
//!
//! * **`Transfer-Encoding` plus `Content-Length` is rejected** (400 inbound, `ERR_HTTP_PARSE`;
//!   500 via [`ProtocolError::invalid_head`] outbound). RFC 9112 §6.1 lets a recipient either
//!   prefer `Transfer-Encoding` or treat the message as an error; rejecting is the smuggling-safe
//!   choice and matches Node's strict llhttp mode.
//! * **`Content-Length` must be decimal** (`1*DIGIT`). Duplicate values are accepted only when
//!   they are identical, including across comma-separated lists; a conflicting duplicate is an
//!   error. This is the second half of the request-smuggling defence.
//! * **A request with `Transfer-Encoding` must end in `chunked`**; anything else is 400. A
//!   response whose final transfer coding is not `chunked` is close-delimited ([`BodyMode::Eof`]).
//! * **No body follows** a 1xx, 204 or 304 response, or any response to `HEAD`; a `Content-Length`
//!   on those is metadata and is not consumed ([`BodyMode::None`]).
//! * **Obs-fold (a header line starting with SP/HTAB) is rejected** (400), per RFC 9112 §5.2. The
//!   parser never normalizes folding away, because that would change `rawHeaders`.
//! * **Bare LF and bare CR are rejected** everywhere in a head, a chunk-size line and a trailer
//!   block. Only CRLF is a line terminator.
//! * **Header names and values are treated as opaque bytes.** Names keep their wire case and the
//!   order is the wire order; duplicates are kept. Values are decoded as latin1 (each byte becomes
//!   the code point of the same value, which is how Node exposes header bytes to JS), so obs-text
//!   survives instead of being lossily UTF-8 decoded.
//! * **Header/trailer limits are enforced while buffering**: a head or trailer block may not
//!   exceed [`Limits::max_head_bytes`] and may not contain more than [`Limits::max_headers`]
//!   fields. Oversize is 431 regardless of whether `httparse` ever sees the bytes, so a slow-loris
//!   peer cannot grow the buffer without bound.
//! * **Body bytes are coalesced into deterministic blocks** ([`BODY_BLOCK_BYTES`]) before they are
//!   emitted as [`Event::Body`]. Event boundaries therefore depend on the byte stream, not on how
//!   the transport fragmented its reads: one byte at a time and one big read produce the same
//!   events. A chunked body additionally flushes the tail of every chunk, so a chunk is never
//!   merged with the next one.
//! * **Outbound `encode_body` when the head said [`BodyMode::None`] writes nothing** (the bytes are
//!   dropped), and **it truncates at a declared `Content-Length`** instead of writing past it. The
//!   signature cannot report an error, and ADR-0007 C3 says the codec never emits more body bytes
//!   than the framing it derived allows. `finish` does not pad a short `Content-Length` body.
//! * **Outbound trailers are not implemented** (Tier B): `finish` writes `0\r\n\r\n` with no
//!   trailer fields. The inbound direction already parses trailers and reports them on
//!   [`Event::MessageEnd`].
//! * **Upgrade handover**: a server that encodes a `101` head, or a `2xx` to a `CONNECT` request,
//!   stops parsing; a client that receives either one does the same after emitting the
//!   [`Event::Response`] head. All bytes read past the head are handed over once as
//!   [`Event::Upgrade`] (post-handover reads are passed through as more `Upgrade` events). The
//!   client does not receive a [`Event::MessageEnd`] for an upgraded response. Bytes held while a
//!   server waits for JS to answer are bounded by [`Limits::max_head_bytes`].
//! * **EOF-framed bodies need an EOF signal**: [`BodyMode::Eof`] ends only when the transport calls
//!   [`Conn::end_of_stream`] (the locked interface has no other way to say "the socket closed").
//!   The same call turns a truncated head, length body or chunked body into one `ERR_HTTP_PARSE`.

use std::collections::VecDeque;

use ln_error::NodeError;

/// Which side of the connection this codec speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Server,
    Client,
}

/// Wire-order header list: `rawHeaders` in Node's terms. Names keep their original case and the
/// order is exactly the order received or authored; nothing here lowercases or re-sorts.
pub type Headers = Vec<(String, String)>;

/// How many body bytes follow a head. `None` is the no-body case (HEAD, 204, 304, 1xx).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyMode {
    None,
    Length(u64),
    Chunked,
    /// No `Content-Length` and not chunked: the body ends at EOF (responses only).
    Eof,
}

/// The parser's hard limits, mapped to Node's `--max-http-header-size` and
/// `server.maxHeadersCount`. Oversize is `431`, malformed is `400` (ADR-0007 §2.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_head_bytes: usize,
    pub max_headers: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_head_bytes: 16 * 1024,
            max_headers: 2000,
        }
    }
}

/// A framing or syntax failure. `status` is what a server should answer when it can still answer;
/// `code` is the stable JS `code` the error carries. Node reports llhttp's `HPE_*` codes here
/// instead (compat D42).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code,
            message: message.into(),
        }
    }

    /// Head larger than `Limits::max_head_bytes` or more fields than `max_headers`.
    pub fn too_large(limit: usize) -> Self {
        Self {
            status: 431,
            code: "ERR_HTTP_HEADERS_OVERFLOW",
            message: format!("HTTP head exceeds the configured limit of {limit} bytes"),
        }
    }

    /// The caller supplied a head that is not a legal request/response head.
    pub fn invalid_head(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code,
            message: message.into(),
        }
    }
}

impl From<ProtocolError> for NodeError {
    fn from(error: ProtocolError) -> Self {
        NodeError::new(error.code, error.message)
    }
}

/// One parsed inbound unit. Bodies are de-framed before they reach [`Event::Body`], so the JS layer
/// never sees chunk sizes; trailers arrive on [`Event::MessageEnd`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Request {
        method: String,
        /// Origin-form target for a normal request, authority-form for `CONNECT`.
        target: String,
        /// `0x10` or `0x11`.
        version: u8,
        headers: Headers,
        /// The peer's intent, from the version and `Connection`. The server's actual decision is
        /// JS's and travels back on `httpEnd`.
        keep_alive: bool,
        /// `Expect: 100-continue` was present.
        expect_continue: bool,
        body: BodyMode,
    },
    Response {
        status: u16,
        reason: String,
        version: u8,
        headers: Headers,
        keep_alive: bool,
        body: BodyMode,
    },
    Body {
        bytes: Vec<u8>,
    },
    MessageEnd {
        trailers: Headers,
    },
    /// `101 Switching Protocols` or a `CONNECT` 2xx: the bytes already read past the head, which
    /// the caller hands to the upgraded protocol. The codec stops parsing here.
    Upgrade {
        bytes: Vec<u8>,
    },
}

/// Inbound body bytes are coalesced into blocks of this size, so [`Event::Body`] boundaries are a
/// property of the byte stream and not of the transport's read size.
pub const BODY_BLOCK_BYTES: usize = 16 * 1024;

/// Where [`Conn::feed`] is in a message. Kept `Copy` so the driver loop can match on it without
/// holding a borrow across a state transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Head,
    Length(u64),
    Chunked,
    Eof,
    /// `101`/`CONNECT` handover: parsing has stopped and inbound bytes are passthrough.
    Upgrade,
    Failed,
}

/// The sub-state of a chunked body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkPhase {
    /// Waiting for `chunk-size [ chunk-ext ] CRLF`.
    Size,
    /// Copying `chunk-size` data bytes out of the buffer.
    Data,
    /// Waiting for the CRLF that follows the data.
    DataCrlf,
    /// Waiting for trailer fields; an empty line ends the message.
    Trailer,
}

/// One HTTP/1.1 connection's parser state.
#[derive(Debug)]
pub struct Conn {
    role: Role,
    limits: Limits,
    events: VecDeque<Event>,
    body_mode: BodyMode,
    /// Set after the first `ProtocolError`: the connection is unusable and `feed` is a no-op.
    failed: bool,

    /// Bytes read from the transport that the state machine has not consumed yet.
    inbuf: Vec<u8>,
    /// How far into `inbuf` the head scanner has looked; keeps a slow head linear instead of
    /// re-scanning it on every feed.
    head_scan: usize,
    state: State,

    /// Coalescing buffer for [`Event::Body`]; never grows past [`BODY_BLOCK_BYTES`].
    body_buf: Vec<u8>,
    chunk_phase: ChunkPhase,
    chunk_remaining: u64,
    /// How far into `inbuf` the chunk-size / trailer line scanner has looked.
    chunk_scan: usize,
    trailers: Headers,
    /// Bytes spent on the current trailer block, bounded by `max_head_bytes`.
    trailer_bytes: usize,

    /// The method of the last request this connection saw: parsed (server) or encoded (client).
    /// It decides whether a response has no body (HEAD) and whether a 2xx is an upgrade (CONNECT).
    request_method: Option<String>,
    /// A server holds bytes after an upgrade-eligible request until JS answers with `101`/2xx.
    awaiting_upgrade: bool,
    /// The current inbound request is upgrade-eligible; promote to `awaiting_upgrade` on
    /// [`Event::MessageEnd`] (a request with a body finishes the body first).
    upgrade_after_body: bool,

    /// Outbound framing, learned by [`Conn::encode_head`].
    out_body: BodyMode,
    out_remaining: u64,
    out_finished: bool,
}

impl Conn {
    pub fn new(role: Role, limits: Limits) -> Self {
        Conn {
            role,
            limits,
            events: VecDeque::new(),
            body_mode: BodyMode::None,
            failed: false,
            inbuf: Vec::new(),
            head_scan: 0,
            state: State::Head,
            body_buf: Vec::new(),
            chunk_phase: ChunkPhase::Size,
            chunk_remaining: 0,
            chunk_scan: 0,
            trailers: Vec::new(),
            trailer_bytes: 0,
            request_method: None,
            awaiting_upgrade: false,
            upgrade_after_body: false,
            out_body: BodyMode::None,
            out_remaining: 0,
            out_finished: false,
        }
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// The current message's body framing, as learned from the last head (inbound, or outbound via
    /// [`Conn::encode_head`]).
    pub fn body_mode(&self) -> BodyMode {
        self.body_mode
    }

    /// True once a parse failure has been reported; the caller closes the connection.
    pub fn is_failed(&self) -> bool {
        self.failed
    }

    /// Advance the state machine with bytes read from the socket. Queues zero or more events.
    ///
    /// A malformed message returns one error and enters the failed state (ADR-0007 C5). The caller
    /// emits it as a `clientError` event; the codec itself has no event for it.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), ProtocolError> {
        if self.failed || bytes.is_empty() {
            return Ok(());
        }
        // After an upgrade handover every inbound byte belongs to the upgraded protocol.
        if self.state == State::Upgrade {
            self.events.push_back(Event::Upgrade {
                bytes: bytes.to_vec(),
            });
            return Ok(());
        }
        self.inbuf.extend_from_slice(bytes);
        match self.advance() {
            Ok(()) => Ok(()),
            Err(error) => Err(self.fail(error)),
        }
    }

    /// Signal that the transport read EOF (a zero-length read).
    ///
    /// This is an additive extension to the locked interface: [`BodyMode::Eof`] bodies can only end
    /// at EOF, and a head/length/chunked message cut short is a malformed message. Call it once,
    /// after the last successful [`Conn::feed`]; afterwards the codec is `failed` if it reports an
    /// error. It is a no-op on an idle keep-alive connection, after a completed message, and in the
    /// upgraded state.
    pub fn end_of_stream(&mut self) -> Result<(), ProtocolError> {
        if self.failed {
            return Ok(());
        }
        match self.state {
            State::Eof => {
                self.end_message(Vec::new());
                Ok(())
            }
            State::Head if self.inbuf.is_empty() || self.awaiting_upgrade => Ok(()),
            State::Head => {
                let error = parse_error("connection closed before the HTTP head was complete");
                Err(self.fail(error))
            }
            State::Length(_) | State::Chunked => {
                let error =
                    parse_error("connection closed before the HTTP message body was complete");
                Err(self.fail(error))
            }
            State::Upgrade | State::Failed => Ok(()),
        }
    }

    /// Take the next queued event, in wire order.
    pub fn next_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// Validate a head the caller is about to send and record the body framing it implies.
    ///
    /// The bytes are passed through untouched: header order, case and spacing stay exactly as the
    /// JS layer authored them (ADR-0007 §2.5). Only the framing decision is taken from them.
    ///
    /// The head must be complete and terminated by CRLF CRLF; it is parsed with `httparse` and
    /// every byte must be consumed by that parse, so a head cannot smuggle a second head or a body
    /// through this entry point. A malformed caller-authored head is a programming error: it is
    /// reported as [`ProtocolError::invalid_head`] (500) and does **not** put the codec in the
    /// failed state, because it says nothing about the peer.
    pub fn encode_head(&mut self, head: &[u8]) -> Result<(), ProtocolError> {
        if !head.ends_with(b"\r\n\r\n") {
            return Err(invalid_head(
                "outbound HTTP head is not terminated by CRLF CRLF",
            ));
        }
        validate_line_endings(head).map_err(invalid_head)?;
        // The outbound head is caller-authored, so it has no configured header limit; sizing the
        // parse scratch from the actual line count keeps the parse allocation proportional.
        let field_count = count_head_fields(head);
        let mut scratch: Vec<httparse::Header<'_>> = vec![httparse::EMPTY_HEADER; field_count];
        let role = self.role;
        let response_to_head = self.request_method.as_deref() == Some("HEAD");

        let (method, headers, status) = match role {
            Role::Server => {
                let (status, headers) = parse_outbound_response(head, &mut scratch)?;
                (None, headers, Some(status))
            }
            Role::Client => {
                let (method, headers) = parse_outbound_request(head, &mut scratch)?;
                (Some(method), headers, None)
            }
        };

        let body = framing(role == Role::Client, status, response_to_head, &headers)
            .map_err(invalid_head)?;

        self.out_body = body;
        self.out_remaining = match body {
            BodyMode::Length(remaining) => remaining,
            _ => 0,
        };
        self.out_finished = false;
        self.body_mode = body;
        if let Some(method) = method {
            self.request_method = Some(method);
        }

        if role == Role::Server {
            let upgraded = status == Some(101)
                || (matches!(status, Some(200..=299))
                    && self.request_method.as_deref() == Some("CONNECT"));
            if upgraded {
                // The upgraded protocol's bytes are authored by JS, never framed by this codec.
                self.out_body = BodyMode::None;
                self.out_remaining = 0;
                self.body_mode = BodyMode::None;
                self.enter_upgrade();
            } else if !(100..200).contains(&status.unwrap_or(0)) {
                // A final non-101 response declines an upgrade-eligible request, so parsing
                // resumes. Interim 1xx (100 Continue, 103 Early Hints) leave the decision open.
                self.awaiting_upgrade = false;
            }
        }
        Ok(())
    }

    /// Frame one body chunk onto `out` according to the mode learned by [`Conn::encode_head`].
    ///
    /// Empty chunks write nothing in every mode (an empty chunked chunk would otherwise terminate
    /// the message). See the module docs for the `BodyMode::None` and `Content-Length` rules.
    pub fn encode_body(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
        if chunk.is_empty() {
            return;
        }
        match self.out_body {
            BodyMode::None => {}
            BodyMode::Length(_) => {
                if self.out_remaining == 0 {
                    return;
                }
                let take = (chunk.len() as u64).min(self.out_remaining) as usize;
                out.extend_from_slice(&chunk[..take]);
                self.out_remaining -= take as u64;
            }
            BodyMode::Chunked => {
                write_hex_size(out, chunk.len());
                out.extend_from_slice(b"\r\n");
                out.extend_from_slice(chunk);
                out.extend_from_slice(b"\r\n");
            }
            BodyMode::Eof => out.extend_from_slice(chunk),
        }
    }

    /// Finish the outbound message. For chunked bodies this writes `0\r\n\r\n` (plus trailers, once
    /// Tier B lands); for every other mode it writes nothing.
    ///
    /// Idempotent: a second call after the message is finished writes nothing. For a
    /// `Content-Length` body that was under-written this is a no-op (the caller is responsible for
    /// the exact length; the codec cannot invent bytes).
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if self.out_finished {
            return;
        }
        self.out_finished = true;
        if self.out_body == BodyMode::Chunked {
            out.extend_from_slice(b"0\r\n\r\n");
        }
        self.out_body = BodyMode::None;
        self.out_remaining = 0;
    }

    /// Write an interim `100 Continue` response (server role).
    pub fn write_continue(&mut self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"HTTP/1.1 100 Continue\r\n\r\n");
    }

    /// Queue an event. Exposed for the transport's own synthetic events (an upgraded connection
    /// re-uses the codec's leftovers) and for tests.
    pub fn push_event(&mut self, event: Event) {
        self.events.push_back(event);
    }

    // ---------------------------------------------------------------------------------------
    // Inbound state machine
    // ---------------------------------------------------------------------------------------

    /// Drain `inbuf` until the state machine needs more bytes. Each step is deterministic, which is
    /// what makes the event stream independent of read boundaries.
    fn advance(&mut self) -> Result<(), ProtocolError> {
        loop {
            match self.state {
                State::Head => {
                    if self.awaiting_upgrade {
                        // A server may not parse past an upgrade-eligible request before JS has
                        // answered: those bytes belong to the upgraded protocol.
                        if self.inbuf.len() > self.limits.max_head_bytes {
                            return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                        }
                        return Ok(());
                    }
                    if !self.step_head()? {
                        return Ok(());
                    }
                }
                State::Length(remaining) => {
                    if self.inbuf.is_empty() {
                        return Ok(());
                    }
                    let space = BODY_BLOCK_BYTES.saturating_sub(self.body_buf.len());
                    if space == 0 {
                        self.flush_body_block();
                        continue;
                    }
                    let take = remaining.min(self.inbuf.len() as u64).min(space as u64) as usize;
                    if take == 0 {
                        return Ok(());
                    }
                    self.body_buf.extend_from_slice(&self.inbuf[..take]);
                    self.inbuf.drain(..take);
                    let left = remaining - take as u64;
                    self.state = State::Length(left);
                    if self.body_buf.len() >= BODY_BLOCK_BYTES {
                        self.flush_body_block();
                    }
                    if left == 0 {
                        self.end_message(Vec::new());
                    }
                }
                State::Chunked => {
                    if !self.step_chunked()? {
                        return Ok(());
                    }
                }
                State::Eof => {
                    if self.inbuf.is_empty() {
                        return Ok(());
                    }
                    let space = BODY_BLOCK_BYTES.saturating_sub(self.body_buf.len());
                    if space == 0 {
                        self.flush_body_block();
                        continue;
                    }
                    let take = self.inbuf.len().min(space);
                    self.body_buf.extend_from_slice(&self.inbuf[..take]);
                    self.inbuf.drain(..take);
                    if self.body_buf.len() >= BODY_BLOCK_BYTES {
                        self.flush_body_block();
                    }
                }
                State::Upgrade => {
                    if self.inbuf.is_empty() {
                        return Ok(());
                    }
                    let bytes = std::mem::take(&mut self.inbuf);
                    self.events.push_back(Event::Upgrade { bytes });
                    return Ok(());
                }
                State::Failed => return Ok(()),
            }
        }
    }

    /// Parse one head if the buffer holds a complete one. Returns `false` when more bytes are
    /// needed.
    fn step_head(&mut self) -> Result<bool, ProtocolError> {
        let (head_len, field_count) = match self.find_head_end()? {
            Some(end) => {
                let head_len = end + 4;
                if head_len > self.limits.max_head_bytes {
                    return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                }
                let fields = count_head_fields(&self.inbuf[..head_len]);
                if fields > self.limits.max_headers {
                    return Err(too_many_headers(self.limits.max_headers));
                }
                (head_len, fields)
            }
            None => {
                if self.inbuf.len() > self.limits.max_head_bytes {
                    return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                }
                return Ok(false);
            }
        };
        self.finish_head(head_len, field_count)?;
        Ok(true)
    }

    /// Find `CRLF CRLF`, validating line endings as it goes and remembering how far it looked.
    fn find_head_end(&mut self) -> Result<Option<usize>, ProtocolError> {
        let len = self.inbuf.len();
        let mut i = self.head_scan;
        while i < len {
            match self.inbuf[i] {
                b'\r' => {
                    if i + 1 >= len {
                        break;
                    }
                    if self.inbuf[i + 1] != b'\n' {
                        return Err(parse_error(
                            "carriage return without a line feed in the HTTP head",
                        ));
                    }
                    // The CRLF at `i` may be the first half of the terminating CRLFCRLF, so do not
                    // advance past it until both of the next two bytes are available. Skipping it
                    // when the tail arrives in a later feed would lose the end of the head.
                    if i + 2 >= len {
                        self.head_scan = i;
                        return Ok(None);
                    }
                    if self.inbuf[i + 2] == b'\r' {
                        if i + 3 >= len {
                            self.head_scan = i;
                            return Ok(None);
                        }
                        if self.inbuf[i + 3] == b'\n' {
                            self.head_scan = 0;
                            return Ok(Some(i));
                        }
                    }
                    i += 2;
                }
                b'\n' => {
                    return Err(parse_error(
                        "line feed without a carriage return in the HTTP head",
                    ));
                }
                _ => i += 1,
            }
        }
        self.head_scan = i;
        Ok(None)
    }

    /// Parse the complete head in `inbuf[..head_len]`, queue its event, and move to the body state.
    fn finish_head(&mut self, head_len: usize, field_count: usize) -> Result<(), ProtocolError> {
        let role = self.role;
        let response_to_head = self.request_method.as_deref() == Some("HEAD");
        let response_to_connect = self.request_method.as_deref() == Some("CONNECT");

        let parsed = {
            let head = &self.inbuf[..head_len];
            let mut scratch: Vec<httparse::Header<'_>> = vec![httparse::EMPTY_HEADER; field_count];
            match role {
                Role::Server => parse_request_head(head, &mut scratch)?,
                Role::Client => {
                    parse_response_head(head, &mut scratch, response_to_head, response_to_connect)?
                }
            }
        };

        self.events.push_back(parsed.event);
        self.body_mode = parsed.body;
        if let Some(method) = parsed.request_method {
            self.request_method = Some(method);
        }
        self.inbuf.drain(..head_len);
        self.head_scan = 0;

        if role == Role::Client && parsed.upgrade {
            // The response head was delivered; the rest of the buffer is the upgraded protocol's.
            self.enter_upgrade();
            return Ok(());
        }

        self.upgrade_after_body = role == Role::Server && parsed.upgrade;
        match parsed.body {
            BodyMode::None | BodyMode::Length(0) => self.end_message(Vec::new()),
            BodyMode::Length(remaining) => self.state = State::Length(remaining),
            BodyMode::Chunked => {
                self.state = State::Chunked;
                self.chunk_phase = ChunkPhase::Size;
                self.chunk_remaining = 0;
                self.chunk_scan = 0;
                self.trailers.clear();
                self.trailer_bytes = 0;
            }
            BodyMode::Eof => self.state = State::Eof,
        }
        Ok(())
    }

    /// One step of the chunked decoder. Returns `false` when more bytes are needed.
    fn step_chunked(&mut self) -> Result<bool, ProtocolError> {
        match self.chunk_phase {
            ChunkPhase::Size => {
                let line_end =
                    match find_line(&self.inbuf, &mut self.chunk_scan).map_err(parse_error)? {
                        Some(end) => end,
                        None => {
                            if self.inbuf.len() > self.limits.max_head_bytes {
                                return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                            }
                            return Ok(false);
                        }
                    };
                if line_end + 2 > self.limits.max_head_bytes {
                    return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                }
                let line = &self.inbuf[..line_end];
                let hex_end = line.iter().position(|&b| b == b';').unwrap_or(line.len());
                let size = parse_hex_size(&line[..hex_end]).map_err(parse_error)?;
                self.inbuf.drain(..line_end + 2);
                self.chunk_scan = 0;
                if size == 0 {
                    self.chunk_phase = ChunkPhase::Trailer;
                    self.trailers.clear();
                    self.trailer_bytes = 0;
                } else {
                    self.chunk_remaining = size;
                    self.chunk_phase = ChunkPhase::Data;
                }
                Ok(true)
            }
            ChunkPhase::Data => {
                if self.inbuf.is_empty() {
                    return Ok(false);
                }
                let space = BODY_BLOCK_BYTES.saturating_sub(self.body_buf.len());
                if space == 0 {
                    self.flush_body_block();
                    return Ok(true);
                }
                let take = self
                    .chunk_remaining
                    .min(self.inbuf.len() as u64)
                    .min(space as u64) as usize;
                if take == 0 {
                    // Defensive: a zero-size chunk is handled in `Size` and must go to trailers.
                    self.chunk_phase = ChunkPhase::DataCrlf;
                    return Ok(true);
                }
                self.body_buf.extend_from_slice(&self.inbuf[..take]);
                self.inbuf.drain(..take);
                self.chunk_remaining -= take as u64;
                if self.body_buf.len() >= BODY_BLOCK_BYTES {
                    self.flush_body_block();
                }
                if self.chunk_remaining == 0 {
                    // Flush the chunk tail so chunks never merge into one body event.
                    self.flush_body_remainder();
                    self.chunk_phase = ChunkPhase::DataCrlf;
                }
                Ok(true)
            }
            ChunkPhase::DataCrlf => {
                if self.inbuf.is_empty() {
                    return Ok(false);
                }
                if self.inbuf[0] != b'\r' {
                    return Err(parse_error("missing CRLF after chunk data"));
                }
                if self.inbuf.len() < 2 {
                    return Ok(false);
                }
                if self.inbuf[1] != b'\n' {
                    return Err(parse_error(
                        "carriage return without a line feed after chunk data",
                    ));
                }
                self.inbuf.drain(..2);
                self.chunk_phase = ChunkPhase::Size;
                self.chunk_scan = 0;
                Ok(true)
            }
            ChunkPhase::Trailer => {
                let line_end =
                    match find_line(&self.inbuf, &mut self.chunk_scan).map_err(parse_error)? {
                        Some(end) => end,
                        None => {
                            if self.trailer_bytes + self.inbuf.len() > self.limits.max_head_bytes {
                                return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                            }
                            return Ok(false);
                        }
                    };
                if self.trailer_bytes + line_end + 2 > self.limits.max_head_bytes {
                    return Err(ProtocolError::too_large(self.limits.max_head_bytes));
                }
                let field = {
                    let line = &self.inbuf[..line_end];
                    parse_trailer_line(line).map_err(parse_error)?
                };
                self.inbuf.drain(..line_end + 2);
                self.trailer_bytes += line_end + 2;
                self.chunk_scan = 0;
                match field {
                    None => {
                        let trailers = std::mem::take(&mut self.trailers);
                        self.end_message(trailers);
                    }
                    Some(field) => {
                        if self.trailers.len() + 1 > self.limits.max_headers {
                            return Err(too_many_headers(self.limits.max_headers));
                        }
                        self.trailers.push(field);
                    }
                }
                Ok(true)
            }
        }
    }

    /// Complete the current message: flush the last body block, queue `MessageEnd`, reset to head
    /// state so a keep-alive connection can parse the next message in the same feed.
    fn end_message(&mut self, trailers: Headers) {
        self.flush_body_remainder();
        self.events.push_back(Event::MessageEnd { trailers });
        self.state = State::Head;
        self.head_scan = 0;
        self.trailers.clear();
        self.trailer_bytes = 0;
        if self.upgrade_after_body {
            self.upgrade_after_body = false;
            self.awaiting_upgrade = true;
        }
    }

    /// Emit the buffered body block if it is full. Boundaries are deterministic because the block
    /// only fills at exactly this many bytes.
    fn flush_body_block(&mut self) {
        if self.body_buf.len() >= BODY_BLOCK_BYTES {
            let bytes = std::mem::take(&mut self.body_buf);
            self.events.push_back(Event::Body { bytes });
        }
    }

    /// Emit whatever body bytes are buffered (the end of a body or of a chunk).
    fn flush_body_remainder(&mut self) {
        if !self.body_buf.is_empty() {
            let bytes = std::mem::take(&mut self.body_buf);
            self.events.push_back(Event::Body { bytes });
        }
    }

    /// Stop parsing inbound bytes and hand the buffered leftovers over exactly once.
    fn enter_upgrade(&mut self) {
        self.awaiting_upgrade = false;
        self.upgrade_after_body = false;
        self.body_buf.clear();
        self.state = State::Upgrade;
        self.head_scan = 0;
        let bytes = std::mem::take(&mut self.inbuf);
        self.events.push_back(Event::Upgrade { bytes });
    }

    /// Enter the failed state after a peer error, returning the one error this connection reports.
    fn fail(&mut self, error: ProtocolError) -> ProtocolError {
        self.failed = true;
        self.state = State::Failed;
        self.inbuf.clear();
        self.body_buf.clear();
        self.head_scan = 0;
        error
    }
}

/// The parts of an inbound head the codec needs after `httparse` has validated it.
struct ParsedHead {
    event: Event,
    /// Set for a request: the method this connection's next response is answering.
    request_method: Option<String>,
    body: BodyMode,
    /// `101`/CONNECT handover applies to this head.
    upgrade: bool,
}

fn parse_request_head<'b>(
    head: &'b [u8],
    scratch: &mut [httparse::Header<'b>],
) -> Result<ParsedHead, ProtocolError> {
    let mut request = httparse::Request::new(scratch);
    match request.parse(head) {
        Ok(httparse::Status::Complete(consumed)) if consumed == head.len() => {
            let method = request
                .method
                .ok_or_else(|| parse_error("missing request method"))?;
            let target = request
                .path
                .ok_or_else(|| parse_error("missing request target"))?;
            let minor = request
                .version
                .ok_or_else(|| parse_error("missing HTTP version"))?;
            let version = version_byte(minor)
                .ok_or_else(|| parse_error("unsupported HTTP version; expected HTTP/1.0 or 1.1"))?;
            let headers = owned_headers(request.headers);
            let keep_alive = keep_alive_for(version, &headers);
            let expect_continue = has_expect_continue(&headers);
            let body = framing(true, None, false, &headers).map_err(parse_error)?;
            let upgrade = method.eq_ignore_ascii_case("CONNECT")
                || header_present(&headers, "upgrade")
                || connection_tokens(&headers, "upgrade");
            Ok(ParsedHead {
                event: Event::Request {
                    method: method.to_string(),
                    target: target.to_string(),
                    version,
                    headers,
                    keep_alive,
                    expect_continue,
                    body,
                },
                request_method: Some(method.to_string()),
                body,
                upgrade,
            })
        }
        Ok(httparse::Status::Complete(_)) => Err(parse_error("trailing bytes after the HTTP head")),
        Ok(httparse::Status::Partial) => Err(parse_error("incomplete HTTP request head")),
        Err(error) => Err(from_httparse(error)),
    }
}

fn parse_response_head<'b>(
    head: &'b [u8],
    scratch: &mut [httparse::Header<'b>],
    response_to_head: bool,
    response_to_connect: bool,
) -> Result<ParsedHead, ProtocolError> {
    let mut response = httparse::Response::new(scratch);
    match response.parse(head) {
        Ok(httparse::Status::Complete(consumed)) if consumed == head.len() => {
            let status = response
                .code
                .ok_or_else(|| parse_error("missing HTTP status code"))?;
            if !(100..=999).contains(&status) {
                return Err(parse_error("invalid HTTP status code"));
            }
            let minor = response
                .version
                .ok_or_else(|| parse_error("missing HTTP version"))?;
            let version = version_byte(minor)
                .ok_or_else(|| parse_error("unsupported HTTP version; expected HTTP/1.0 or 1.1"))?;
            let reason = response.reason.unwrap_or("").to_string();
            let headers = owned_headers(response.headers);
            let keep_alive = keep_alive_for(version, &headers);
            let mut body =
                framing(false, Some(status), response_to_head, &headers).map_err(parse_error)?;
            let upgrade = status == 101 || ((200..300).contains(&status) && response_to_connect);
            if upgrade {
                // The head is a handover: the bytes after it are the upgraded protocol's, not a
                // body this codec will ever deliver.
                body = BodyMode::None;
            }
            Ok(ParsedHead {
                event: Event::Response {
                    status,
                    reason,
                    version,
                    headers,
                    keep_alive,
                    body,
                },
                request_method: None,
                body,
                upgrade,
            })
        }
        Ok(httparse::Status::Complete(_)) => Err(parse_error("trailing bytes after the HTTP head")),
        Ok(httparse::Status::Partial) => Err(parse_error("incomplete HTTP response head")),
        Err(error) => Err(from_httparse(error)),
    }
}

/// Validate a caller-authored request head and return its method and headers.
fn parse_outbound_request<'b>(
    head: &'b [u8],
    scratch: &mut [httparse::Header<'b>],
) -> Result<(String, Headers), ProtocolError> {
    let mut request = httparse::Request::new(scratch);
    match request.parse(head) {
        Ok(httparse::Status::Complete(consumed)) if consumed == head.len() => {
            let method = request
                .method
                .ok_or_else(|| invalid_head("outbound request has no method"))?;
            version_byte(
                request
                    .version
                    .ok_or_else(|| invalid_head("outbound request has no HTTP version"))?,
            )
            .ok_or_else(|| invalid_head("outbound request has an unsupported HTTP version"))?;
            if request.path.unwrap_or("").is_empty() {
                return Err(invalid_head("outbound request has no target"));
            }
            Ok((method.to_string(), owned_headers(request.headers)))
        }
        Ok(httparse::Status::Complete(_)) => Err(invalid_head(
            "outbound request head has trailing bytes after the terminating CRLF CRLF",
        )),
        Ok(httparse::Status::Partial) => Err(invalid_head("outbound request head is incomplete")),
        Err(error) => Err(invalid_head(format!(
            "malformed outbound request head: {error}"
        ))),
    }
}

/// Validate a caller-authored response head and return its status and headers.
fn parse_outbound_response<'b>(
    head: &'b [u8],
    scratch: &mut [httparse::Header<'b>],
) -> Result<(u16, Headers), ProtocolError> {
    let mut response = httparse::Response::new(scratch);
    match response.parse(head) {
        Ok(httparse::Status::Complete(consumed)) if consumed == head.len() => {
            let status = response
                .code
                .ok_or_else(|| invalid_head("outbound response has no status code"))?;
            if !(100..=999).contains(&status) {
                return Err(invalid_head(format!(
                    "outbound response status {status} is outside 100..=999"
                )));
            }
            version_byte(
                response
                    .version
                    .ok_or_else(|| invalid_head("outbound response has no HTTP version"))?,
            )
            .ok_or_else(|| invalid_head("outbound response has an unsupported HTTP version"))?;
            Ok((status, owned_headers(response.headers)))
        }
        Ok(httparse::Status::Complete(_)) => Err(invalid_head(
            "outbound response head has trailing bytes after the terminating CRLF CRLF",
        )),
        Ok(httparse::Status::Partial) => Err(invalid_head("outbound response head is incomplete")),
        Err(error) => Err(invalid_head(format!(
            "malformed outbound response head: {error}"
        ))),
    }
}

// -------------------------------------------------------------------------------------------
// Header helpers
// -------------------------------------------------------------------------------------------

fn parse_error(message: impl Into<String>) -> ProtocolError {
    ProtocolError::bad_request("ERR_HTTP_PARSE", message)
}

fn too_many_headers(limit: usize) -> ProtocolError {
    // Same status/code as `too_large`; only the message names the field-count limit instead of the
    // byte limit.
    let mut error = ProtocolError::too_large(limit);
    error.message = format!("HTTP head has more fields than the configured limit of {limit}");
    error
}

fn invalid_head(message: impl Into<String>) -> ProtocolError {
    ProtocolError::invalid_head("ERR_HTTP_INVALID_HEAD", message)
}

fn from_httparse(error: httparse::Error) -> ProtocolError {
    parse_error(format!("malformed HTTP head: {error}"))
}

fn version_byte(minor: u8) -> Option<u8> {
    match minor {
        0 => Some(0x10),
        1 => Some(0x11),
        _ => None,
    }
}

fn owned_headers(headers: &[httparse::Header<'_>]) -> Headers {
    headers
        .iter()
        .map(|header| (header.name.to_string(), latin1(header.value)))
        .collect()
}

/// Header values are opaque bytes (obs-text is legal); Node hands them to JS as latin1 code
/// points, so map each byte to the code point of the same value instead of lossy UTF-8.
fn latin1(bytes: &[u8]) -> String {
    let mut string = String::with_capacity(bytes.len());
    for &byte in bytes {
        string.push(char::from(byte));
    }
    string
}

fn header_present(headers: &Headers, name: &str) -> bool {
    headers
        .iter()
        .any(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
}

fn has_expect_continue(headers: &Headers) -> bool {
    headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("expect") && value.trim().eq_ignore_ascii_case("100-continue")
    })
}

fn connection_tokens(headers: &Headers, token: &str) -> bool {
    headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("connection")
            && value
                .split(',')
                .any(|candidate| candidate.trim().eq_ignore_ascii_case(token))
    })
}

fn keep_alive_for(version: u8, headers: &Headers) -> bool {
    if connection_tokens(headers, "close") {
        return false;
    }
    if version == 0x10 {
        connection_tokens(headers, "keep-alive")
    } else {
        true
    }
}

/// The final transfer coding is `chunked` (`Some(true)`), present but not chunked (`Some(false)`),
/// or absent (`None`). `chunked` anywhere but last is an error, per RFC 9112 §6.1.
fn transfer_encoding(headers: &Headers) -> Result<Option<bool>, &'static str> {
    let mut present = false;
    let mut chunked = false;
    for value in headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
        .map(|(_, value)| value.as_str())
    {
        present = true;
        for coding in value.split(',') {
            let coding = coding.split(';').next().unwrap_or("").trim();
            if coding.is_empty() {
                return Err("empty transfer coding");
            }
            if chunked {
                return Err("chunked is not the final transfer coding");
            }
            if coding.eq_ignore_ascii_case("chunked") {
                chunked = true;
            }
        }
    }
    if !present {
        return Ok(None);
    }
    Ok(Some(chunked))
}

/// Parse every `Content-Length`, accepting only identical decimal values. Conflicts are rejected
/// so a message cannot be framed one way by us and another way by the next hop.
fn content_length(headers: &Headers) -> Result<Option<u64>, &'static str> {
    let mut length: Option<u64> = None;
    for value in headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.as_str())
    {
        for part in value.split(',') {
            let part = part.trim();
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("invalid Content-Length");
            }
            let parsed: u64 = part.parse().map_err(|_| "invalid Content-Length")?;
            match length {
                Some(existing) if existing != parsed => {
                    return Err("conflicting Content-Length values");
                }
                _ => length = Some(parsed),
            }
        }
    }
    Ok(length)
}

/// Decide the body framing of a message. `is_request` selects the request rules (no EOF bodies);
/// `response_to_head` suppresses the body of a response to HEAD.
fn framing(
    is_request: bool,
    status: Option<u16>,
    response_to_head: bool,
    headers: &Headers,
) -> Result<BodyMode, &'static str> {
    let transfer = transfer_encoding(headers)?;
    let length = content_length(headers)?;
    if transfer.is_some() && length.is_some() {
        return Err("both Transfer-Encoding and Content-Length are present");
    }

    if is_request {
        return match transfer {
            Some(true) => Ok(BodyMode::Chunked),
            Some(false) => Err("a request Transfer-Encoding must end with chunked"),
            None => Ok(match length {
                Some(length) => BodyMode::Length(length),
                None => BodyMode::None,
            }),
        };
    }

    let status = status.unwrap_or(0);
    if (100..200).contains(&status) || status == 204 || status == 304 || response_to_head {
        return Ok(BodyMode::None);
    }
    match transfer {
        Some(true) => Ok(BodyMode::Chunked),
        // A response whose final coding is not chunked is close-delimited.
        Some(false) => Ok(BodyMode::Eof),
        None => Ok(match length {
            Some(length) => BodyMode::Length(length),
            None => BodyMode::Eof,
        }),
    }
}

/// Count header fields in a complete head (start line excluded). A line that starts with SP/HTAB is
/// a continuation (obs-fold) and belongs to the previous field; `httparse` will reject it, but
/// counting it as a separate field would misclassify the request as oversize first.
fn count_head_fields(head: &[u8]) -> usize {
    let mut seen_start_line = false;
    let mut fields = 0;
    for raw_line in head.split(|&byte| byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        if !seen_start_line {
            seen_start_line = true;
            continue;
        }
        if line[0] != b' ' && line[0] != b'\t' {
            fields += 1;
        }
    }
    fields
}

/// Reject bare CR/LF in caller-authored bytes: a head is only legal if every line ends in CRLF and
/// no value smuggles a line break.
fn validate_line_endings(bytes: &[u8]) -> Result<(), &'static str> {
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if i + 1 >= bytes.len() || bytes[i + 1] != b'\n' {
                    return Err("outbound HTTP head contains a bare carriage return");
                }
                i += 2;
            }
            b'\n' => return Err("outbound HTTP head contains a bare line feed"),
            _ => i += 1,
        }
    }
    Ok(())
}

fn is_token_byte(byte: u8) -> bool {
    matches!(byte,
        b'A'..=b'Z'
        | b'a'..=b'z'
        | b'0'..=b'9'
        | b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_'
        | b'`' | b'|' | b'~')
}

fn is_header_value_byte(byte: u8) -> bool {
    byte == b'\t' || (0x20..=0x7e).contains(&byte) || byte >= 0x80
}

fn trim_ows(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && (bytes[start] == b' ' || bytes[start] == b'\t') {
        start += 1;
    }
    while end > start && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}

/// Find the CR of the next CRLF. Returns `Ok(None)` when more bytes are needed. `scan` remembers
/// how far the previous call looked, so a byte-at-a-time peer stays linear.
fn find_line(buf: &[u8], scan: &mut usize) -> Result<Option<usize>, &'static str> {
    let mut i = *scan;
    while i < buf.len() {
        match buf[i] {
            b'\r' => {
                if i + 1 >= buf.len() {
                    *scan = i;
                    return Ok(None);
                }
                if buf[i + 1] != b'\n' {
                    return Err("carriage return without a line feed");
                }
                *scan = 0;
                return Ok(Some(i));
            }
            b'\n' => return Err("line feed without a carriage return"),
            _ => i += 1,
        }
    }
    *scan = i;
    Ok(None)
}

/// Parse one trailer field. `Ok(None)` is the empty line that ends the trailer block.
fn parse_trailer_line(line: &[u8]) -> Result<Option<(String, String)>, &'static str> {
    if line.is_empty() {
        return Ok(None);
    }
    let colon = line
        .iter()
        .position(|&byte| byte == b':')
        .ok_or("trailer field without a colon")?;
    let name = &line[..colon];
    if name.is_empty() || !name.iter().all(|&byte| is_token_byte(byte)) {
        return Err("invalid trailer field name");
    }
    let value = trim_ows(&line[colon + 1..]);
    if !value.iter().all(|&byte| is_header_value_byte(byte)) {
        return Err("invalid trailer field value");
    }
    Ok(Some((
        String::from_utf8_lossy(name).into_owned(),
        latin1(value),
    )))
}

fn parse_hex_size(line: &[u8]) -> Result<u64, &'static str> {
    if line.is_empty() {
        return Err("empty chunk size");
    }
    let mut size: u64 = 0;
    for &byte in line {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err("invalid chunk size"),
        };
        size = size
            .checked_mul(16)
            .and_then(|size| size.checked_add(digit as u64))
            .ok_or("chunk size overflow")?;
    }
    Ok(size)
}

fn write_hex_size(out: &mut Vec<u8>, size: usize) {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut buf = [0u8; 2 * std::mem::size_of::<usize>()];
    let mut index = buf.len();
    let mut value = size;
    loop {
        index -= 1;
        buf[index] = DIGITS[value & 0xf];
        value >>= 4;
        if value == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[index..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_connection_has_no_events_and_no_body() {
        let mut conn = Conn::new(Role::Server, Limits::default());
        assert!(conn.next_event().is_none());
        assert_eq!(conn.body_mode(), BodyMode::None);
        assert!(!conn.is_failed());
    }

    #[test]
    fn the_default_head_limit_is_nodes_sixteen_kilobytes() {
        assert_eq!(Limits::default().max_head_bytes, 16 * 1024);
        assert_eq!(Limits::default().max_headers, 2000);
    }

    #[test]
    fn protocol_errors_become_coded_node_errors() {
        let error: NodeError = ProtocolError::too_large(16 * 1024).into();
        assert_eq!(error.code, "ERR_HTTP_HEADERS_OVERFLOW");
        assert!(error.message.contains("16384"));

        let error: NodeError = ProtocolError::bad_request("ERR_HTTP_PARSE", "bad method").into();
        assert_eq!(error.code, "ERR_HTTP_PARSE");
    }

    #[test]
    fn continue_is_a_complete_interim_response() {
        let mut conn = Conn::new(Role::Server, Limits::default());
        let mut out = Vec::new();
        conn.write_continue(&mut out);
        assert_eq!(out, b"HTTP/1.1 100 Continue\r\n\r\n");
    }

    /// C1/H1: the codec crosses the thread boundary, so its events must be `Send`.
    #[test]
    fn events_are_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Event>();
        assert_send::<ProtocolError>();
        assert_send::<Conn>();
    }

    #[test]
    fn chunk_sizes_are_lowercase_hex() {
        let mut out = Vec::new();
        write_hex_size(&mut out, 0);
        assert_eq!(out, b"0");
        out.clear();
        write_hex_size(&mut out, 0x1a);
        assert_eq!(out, b"1a");
        out.clear();
        write_hex_size(&mut out, 4096);
        assert_eq!(out, b"1000");
    }

    #[test]
    fn head_field_counting_ignores_continuations() {
        let head = b"GET / HTTP/1.1\r\nA: b\r\n c\r\nD: e\r\n\r\n";
        assert_eq!(count_head_fields(head), 2);
    }
}
