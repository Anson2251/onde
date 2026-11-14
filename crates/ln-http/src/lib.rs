//! Sans-io HTTP/1.1 codec: bytes in, events out. No socket, no tokio, no engine, no clock.
//!
//! The design is [ADR-0007](../../docs/adr/0007-http-codec.md); the contract with the transport is
//! [m4-plan.md](../../docs/m4-plan.md) §2.4. One [`Conn`] drives a client or a server connection
//! over any byte stream, which is what lets the parser be tested with vectors and reused over TCP,
//! TLS and Unix sockets.
//!
//! **This file is the locked M4 interface.** WP2 implements the bodies marked `todo!("WP2")`;
//! extend the types, do not rename them.
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

/// One HTTP/1.1 connection's parser state.
#[derive(Debug)]
pub struct Conn {
    role: Role,
    limits: Limits,
    events: VecDeque<Event>,
    body_mode: BodyMode,
    /// Set after the first `ProtocolError`: the connection is unusable and `feed` is a no-op.
    failed: bool,
}

impl Conn {
    pub fn new(role: Role, limits: Limits) -> Self {
        Conn {
            role,
            limits,
            events: VecDeque::new(),
            body_mode: BodyMode::None,
            failed: false,
        }
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// The current message's body framing, as learned from the last head.
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
        let _ = bytes;
        todo!("WP2: head parse + body framing")
    }

    /// Take the next queued event, in wire order.
    pub fn next_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// Validate a head the caller is about to send and record the body framing it implies.
    ///
    /// The bytes are passed through untouched: header order, case and spacing stay exactly as the
    /// JS layer authored them (ADR-0007 §2.5). Only the framing decision is taken from them.
    pub fn encode_head(&mut self, head: &[u8]) -> Result<(), ProtocolError> {
        let _ = head;
        todo!("WP2: head validation + framing detection")
    }

    /// Frame one body chunk onto `out` according to the mode learned by [`Conn::encode_head`].
    pub fn encode_body(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
        let _ = (chunk, out);
        todo!("WP2: content-length / chunked encode")
    }

    /// Finish the outbound message. For chunked bodies this writes `0\r\n\r\n` (plus trailers, once
    /// Tier B lands); for every other mode it writes nothing.
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        let _ = out;
        todo!("WP2: chunked terminator")
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
}
