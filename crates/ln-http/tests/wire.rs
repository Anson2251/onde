//! Wire-level tests for the sans-io HTTP/1.1 codec.
//!
//! Every test feeds byte strings; there is no socket anywhere in this file. The fixtures are the
//! cases RFC 9112, Node's raw-wire tests and the M4 plan (§5) call out as easy to get wrong, plus
//! the fragment-invariance property that makes the state machine independent of read boundaries.

use ln_http::{BodyMode, Conn, Event, Headers, Limits, ProtocolError, Role, BODY_BLOCK_BYTES};

const GET_HEAD: &[u8] = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
const HEAD_HEAD: &[u8] = b"HEAD / HTTP/1.1\r\nHost: example.com\r\n\r\n";
const CONNECT_HEAD: &[u8] = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";

fn server() -> Conn {
    Conn::new(Role::Server, Limits::default())
}

fn client() -> Conn {
    Conn::new(Role::Client, Limits::default())
}

fn drain(conn: &mut Conn) -> Vec<Event> {
    let mut events = Vec::new();
    while let Some(event) = conn.next_event() {
        events.push(event);
    }
    events
}

fn feed_all(conn: &mut Conn, bytes: &[u8]) -> Result<Vec<Event>, ProtocolError> {
    conn.feed(bytes)?;
    Ok(drain(conn))
}

fn feed_fragmented(
    conn: &mut Conn,
    bytes: &[u8],
    fragment: usize,
) -> Result<Vec<Event>, ProtocolError> {
    let mut events = Vec::new();
    for part in bytes.chunks(fragment) {
        conn.feed(part)?;
        events.extend(drain(conn));
    }
    Ok(events)
}

fn expect_request(event: &Event) -> (&str, &str, u8, &Headers, bool, bool, BodyMode) {
    match event {
        Event::Request {
            method,
            target,
            version,
            headers,
            keep_alive,
            expect_continue,
            body,
        } => (
            method,
            target,
            *version,
            headers,
            *keep_alive,
            *expect_continue,
            *body,
        ),
        other => panic!("expected a request event, got {other:?}"),
    }
}

fn expect_response(event: &Event) -> (u16, &str, u8, &Headers, bool, BodyMode) {
    match event {
        Event::Response {
            status,
            reason,
            version,
            headers,
            keep_alive,
            body,
        } => (*status, reason, *version, headers, *keep_alive, *body),
        other => panic!("expected a response event, got {other:?}"),
    }
}

fn body_bytes(event: &Event) -> &[u8] {
    match event {
        Event::Body { bytes } => bytes,
        other => panic!("expected a body event, got {other:?}"),
    }
}

fn headers(pairs: &[(&str, &str)]) -> Headers {
    pairs
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

fn assert_parse_error(error: &ProtocolError, context: &str) {
    assert_eq!(error.status, 400, "{context}: {error:?}");
    assert_eq!(error.code, "ERR_HTTP_PARSE", "{context}: {error:?}");
    assert!(!error.message.is_empty(), "{context}: empty message");
}

// -------------------------------------------------------------------------------------------
// Inbound heads
// -------------------------------------------------------------------------------------------

#[test]
fn a_request_head_preserves_wire_order_case_and_duplicates() {
    let wire = b"GET /search?q=1 HTTP/1.1\r\nhost: example.com\r\nX-Mixed-Case: Value\r\nCookie: a=1\r\nCookie: b=2\r\nX-Dup: one\r\nX-Dup: two\r\n\r\n";
    let events = feed_all(&mut server(), wire).expect("valid request");
    assert_eq!(events.len(), 2, "{events:?}");

    let (method, target, version, got_headers, keep_alive, expect_continue, body) =
        expect_request(&events[0]);
    assert_eq!(method, "GET");
    assert_eq!(target, "/search?q=1");
    assert_eq!(version, 0x11);
    assert_eq!(
        got_headers,
        &headers(&[
            ("host", "example.com"),
            ("X-Mixed-Case", "Value"),
            ("Cookie", "a=1"),
            ("Cookie", "b=2"),
            ("X-Dup", "one"),
            ("X-Dup", "two"),
        ])
    );
    assert!(keep_alive);
    assert!(!expect_continue);
    assert_eq!(body, BodyMode::None);
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
}

#[test]
fn a_response_head_preserves_order_case_and_duplicate_set_cookie() {
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");

    let wire = b"HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\nX-Lower: v\r\n\r\n";
    let events = feed_all(&mut conn, wire).expect("valid response");
    // No Content-Length or Transfer-Encoding: the body is close-delimited.
    assert_eq!(events.len(), 1, "{events:?}");
    let (status, reason, version, got_headers, keep_alive, body) = expect_response(&events[0]);
    assert_eq!(
        (status, reason, version, keep_alive, body),
        (200, "OK", 0x11, true, BodyMode::Eof)
    );
    assert_eq!(
        got_headers,
        &headers(&[
            ("Set-Cookie", "a=1"),
            ("set-cookie", "b=2"),
            ("X-Lower", "v"),
        ])
    );
}

#[test]
fn a_response_reason_phrase_may_be_empty() {
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");
    let events = feed_all(&mut conn, b"HTTP/1.1 204\r\n\r\n").expect("valid response");
    let (status, reason, _, _, _, body) = expect_response(&events[0]);
    assert_eq!(status, 204);
    assert_eq!(reason, "");
    assert_eq!(body, BodyMode::None);
}

#[test]
fn obs_fold_is_rejected_in_requests_and_responses() {
    // RFC 9112 §5.2: a field line starting with SP/HTAB is obsolete line folding, which a
    // conforming parser must reject (it is a request-smuggling vector).
    let mut request = server();
    let error = request
        .feed(b"GET / HTTP/1.1\r\nHost: example.com\r\n folded value\r\n\r\n")
        .expect_err("obs-fold must be rejected");
    assert_parse_error(&error, "request obs-fold");
    assert!(request.is_failed());

    let mut response = client();
    response.encode_head(GET_HEAD).expect("outbound GET head");
    let error = response
        .feed(b"HTTP/1.1 200 OK\r\nX-Long: a\r\n b\r\n\r\n")
        .expect_err("obs-fold must be rejected");
    assert_parse_error(&error, "response obs-fold");
    assert!(response.is_failed());
}

#[test]
fn header_bytes_are_latin1_decoded_not_lossily_utf8_decoded() {
    // obs-text is legal in a field value. Node hands raw bytes to JS as latin1 code points, so
    // 0xE9 must become U+00E9 ("é"), not a replacement character.
    let mut conn = server();
    let events = feed_all(&mut conn, b"GET / HTTP/1.1\r\nX-Name: caf\xe9\r\n\r\n")
        .expect("valid obs-text header");
    let (_, _, _, got_headers, _, _, _) = expect_request(&events[0]);
    assert_eq!(got_headers, &headers(&[("X-Name", "café")]));
}

// -------------------------------------------------------------------------------------------
// Chunked bodies
// -------------------------------------------------------------------------------------------

const CHUNKED_REQUEST: &[u8] = b"POST /upload HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\nTrailer: X-Checksum\r\n\r\n5;ext=1;flag\r\nhello\r\n6\r\n world\r\n0\r\nX-Checksum: abc\r\nX-Empty:  \r\n\r\n";

#[test]
fn chunked_bodies_ignore_extensions_and_report_trailers() {
    let events = feed_all(&mut server(), CHUNKED_REQUEST).expect("valid chunked request");
    assert_eq!(events.len(), 4, "{events:?}");
    let (_, _, _, _, _, _, body) = expect_request(&events[0]);
    assert_eq!(body, BodyMode::Chunked);
    assert_eq!(body_bytes(&events[1]), b"hello");
    assert_eq!(body_bytes(&events[2]), b" world");
    assert_eq!(
        events[3],
        Event::MessageEnd {
            trailers: headers(&[("X-Checksum", "abc"), ("X-Empty", "")]),
        }
    );
}

#[test]
fn chunked_bodies_are_identical_split_at_every_boundary() {
    let mut whole = server();
    let expected = feed_all(&mut whole, CHUNKED_REQUEST).expect("whole buffer");

    for split in 1..CHUNKED_REQUEST.len() {
        let mut conn = server();
        let mut events = Vec::new();
        conn.feed(&CHUNKED_REQUEST[..split]).expect("first half");
        events.extend(drain(&mut conn));
        conn.feed(&CHUNKED_REQUEST[split..]).expect("second half");
        events.extend(drain(&mut conn));
        assert_eq!(events, expected, "split at byte {split}");
    }

    let mut byte_wise = server();
    let events = feed_fragmented(&mut byte_wise, CHUNKED_REQUEST, 1).expect("one byte at a time");
    assert_eq!(events, expected);
}

#[test]
fn zero_length_chunked_body_ends_immediately() {
    let events = feed_all(
        &mut server(),
        b"GET / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    )
    .expect("valid zero-length chunked body");
    assert_eq!(events.len(), 2, "{events:?}");
    let (_, _, _, _, _, _, body) = expect_request(&events[0]);
    assert_eq!(body, BodyMode::Chunked);
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
}

#[test]
fn bad_chunk_sizes_and_truncated_chunks_are_400() {
    let head = b"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n";

    for (name, tail) in [
        ("non-hex size", &b"zz\r\n"[..]),
        ("empty size", &b"\r\n"[..]),
        ("trailing space", &b"5 \r\n"[..]),
        ("overflowing size", &b"fffffffffffffffff\r\n"[..]),
        ("bare LF after size", &b"5\nhello\r\n"[..]),
        ("bare CR after data", &b"5\r\nhelloX\r\n"[..]),
    ] {
        let mut conn = server();
        conn.feed(head).expect("head is valid");
        let request_events = drain(&mut conn);
        assert_eq!(request_events.len(), 1, "{name}: {request_events:?}");
        let error = conn.feed(tail).expect_err(name);
        assert_parse_error(&error, name);
        assert!(conn.is_failed(), "{name}");
    }

    // A chunked body cut short is only detectable at EOF.
    let mut conn = server();
    feed_all(&mut conn, head).expect("head is valid");
    conn.feed(b"5\r\nhel")
        .expect("partial chunk data is not an error yet");
    let error = conn
        .end_of_stream()
        .expect_err("truncated chunk must fail at EOF");
    assert_parse_error(&error, "truncated chunk");
}

#[test]
fn trailers_are_bounded_by_the_header_limits() {
    let limits = Limits {
        max_head_bytes: 4096,
        max_headers: 1,
    };
    let mut conn = Conn::new(Role::Server, limits);
    conn.feed(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nA: 1\r\nB: 2\r\n\r\n")
        .expect_err("two trailers exceed max_headers=1");
    assert!(conn.is_failed());

    let limits = Limits {
        max_head_bytes: 80,
        max_headers: 100,
    };
    let mut conn = Conn::new(Role::Server, limits);
    let mut wire = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Long: ".to_vec();
    wire.extend_from_slice(&[b'a'; 200]);
    wire.extend_from_slice(b"\r\n\r\n");
    let error = conn.feed(&wire).expect_err("oversize trailer block");
    assert_eq!(error.status, 431);
    assert_eq!(error.code, "ERR_HTTP_HEADERS_OVERFLOW");
}

#[test]
fn a_chunked_response_with_trailers_is_de_framed() {
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");
    let wire =
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Sum\r\n\r\nA;x\r\n0123456789\r\n0\r\nX-Sum: 42\r\n\r\n";
    let events = feed_all(&mut conn, wire).expect("valid chunked response");
    assert_eq!(events.len(), 3, "{events:?}");
    let (_, _, _, _, _, body) = expect_response(&events[0]);
    assert_eq!(body, BodyMode::Chunked);
    assert_eq!(body_bytes(&events[1]), b"0123456789");
    assert_eq!(
        events[2],
        Event::MessageEnd {
            trailers: headers(&[("X-Sum", "42")]),
        }
    );
}

// -------------------------------------------------------------------------------------------
// Content-Length and EOF bodies
// -------------------------------------------------------------------------------------------

#[test]
fn content_length_bodies_are_exactly_framed() {
    let wire =
        b"POST /submit HTTP/1.1\r\nHost: example.com\r\nContent-Length: 11\r\n\r\nhello world";
    let events = feed_all(&mut server(), wire).expect("valid length body");
    assert_eq!(events.len(), 3, "{events:?}");
    let (_, _, _, _, _, _, body) = expect_request(&events[0]);
    assert_eq!(body, BodyMode::Length(11));
    assert_eq!(body_bytes(&events[1]), b"hello world");
    assert_eq!(events[2], Event::MessageEnd { trailers: vec![] });
}

#[test]
fn a_zero_content_length_has_no_body_event() {
    let wire = b"POST /empty HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n";
    let mut conn = server();
    let events = feed_all(&mut conn, wire).expect("valid zero-length body");
    assert_eq!(events.len(), 2, "{events:?}");
    let (_, _, _, _, _, _, body) = expect_request(&events[0]);
    assert_eq!(body, BodyMode::Length(0));
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert_eq!(conn.body_mode(), BodyMode::Length(0));
}

#[test]
fn an_eof_response_body_ends_at_end_of_stream() {
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");
    let events = feed_all(
        &mut conn,
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nuntil the socket closes",
    )
    .expect("valid EOF body");
    assert_eq!(events.len(), 1, "{events:?}");
    let (_, _, _, _, _, body) = expect_response(&events[0]);
    assert_eq!(body, BodyMode::Eof);
    assert_eq!(conn.body_mode(), BodyMode::Eof);

    // The tail of the body is flushed when the transport reports EOF, together with MessageEnd.
    conn.end_of_stream().expect("EOF ends the message");
    let events = drain(&mut conn);
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(body_bytes(&events[0]), b"until the socket closes");
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert!(!conn.is_failed());
}

#[test]
fn identical_duplicate_content_lengths_are_ok_and_conflicts_are_rejected() {
    let mut conn = server();
    let events = feed_all(
        &mut conn,
        b"POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello",
    )
    .expect("identical duplicates are legal");
    assert_eq!(body_bytes(&events[1]), b"hello");

    let mut conn = server();
    let error = conn
        .feed(b"POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello")
        .expect_err("conflicting Content-Length is smuggling");
    assert_parse_error(&error, "conflicting content-length");

    let mut conn = server();
    let events = feed_all(
        &mut conn,
        b"POST / HTTP/1.1\r\nContent-Length: 5, 5\r\n\r\nhello",
    )
    .expect("identical comma list is legal");
    assert_eq!(body_bytes(&events[1]), b"hello");
}

// -------------------------------------------------------------------------------------------
// No-body responses
// -------------------------------------------------------------------------------------------

#[test]
fn head_204_304_and_1xx_consume_no_body() {
    // A 200 to HEAD with Content-Length: 5: the length is metadata, not a body. If the codec
    // consumed five bytes here the next message on the connection would be shredded.
    let mut conn = client();
    conn.encode_head(HEAD_HEAD).expect("outbound HEAD head");
    let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n";
    let events = feed_all(&mut conn, wire).expect("HEAD response");
    assert_eq!(events.len(), 2, "{events:?}");
    let (status, _, _, _, _, body) = expect_response(&events[0]);
    assert_eq!((status, body), (200, BodyMode::None));
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });

    // 204 with a metadata Content-Length; the same no-body guarantee.
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");
    let wire =
        b"HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n";
    let events = feed_all(&mut conn, wire).expect("204 responses");
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(expect_response(&events[0]).5, BodyMode::None);
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert_eq!(expect_response(&events[2]).5, BodyMode::None);

    // 304 with a metadata Content-Length. Another response follows in the same buffer: if the
    // codec treated the nine bytes as a body it would desynchronize instead of parsing it.
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");
    let wire = b"HTTP/1.1 304 Not Modified\r\nETag: \"abc\"\r\nContent-Length: 9\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n";
    let events = feed_all(&mut conn, wire).expect("304 response");
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(expect_response(&events[0]).5, BodyMode::None);
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert_eq!(expect_response(&events[2]).0, 204);

    // 1xx (not 101) is an interim response with no body; the final response follows it.
    let mut conn = client();
    conn.encode_head(GET_HEAD).expect("outbound GET head");
    let wire = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    let events = feed_all(&mut conn, wire).expect("100 then 200");
    assert_eq!(events.len(), 5, "{events:?}");
    let (status, _, _, _, _, body) = expect_response(&events[0]);
    assert_eq!((status, body), (100, BodyMode::None));
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert_eq!(expect_response(&events[2]).0, 200);
    assert_eq!(body_bytes(&events[3]), b"ok");
}

// -------------------------------------------------------------------------------------------
// keep-alive
// -------------------------------------------------------------------------------------------

fn request_keep_alive(wire: &[u8]) -> bool {
    let events = feed_all(&mut server(), wire).expect("valid request");
    expect_request(&events[0]).4
}

#[test]
fn keep_alive_follows_version_and_connection_headers() {
    assert!(request_keep_alive(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    assert!(!request_keep_alive(
        b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    ));
    assert!(!request_keep_alive(
        b"GET / HTTP/1.1\r\nHost: x\r\nConnection: Close\r\n\r\n"
    ));
    assert!(!request_keep_alive(b"GET / HTTP/1.0\r\nHost: x\r\n\r\n"));
    assert!(request_keep_alive(
        b"GET / HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\n\r\n"
    ));
    assert!(request_keep_alive(
        b"GET / HTTP/1.0\r\nHost: x\r\nConnection: Keep-Alive\r\n\r\n"
    ));
    assert!(!request_keep_alive(
        b"GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive, close\r\n\r\n"
    ));

    let response_keep_alive = |wire: &[u8]| {
        let mut conn = client();
        conn.encode_head(GET_HEAD).expect("outbound GET head");
        let events = feed_all(&mut conn, wire).expect("valid response");
        expect_response(&events[0]).4
    };
    assert!(response_keep_alive(
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
    ));
    assert!(!response_keep_alive(
        b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    ));
    assert!(!response_keep_alive(
        b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"
    ));
    assert!(response_keep_alive(
        b"HTTP/1.0 200 OK\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n"
    ));
}

#[test]
fn a_keep_alive_connection_parses_the_next_message_after_message_end() {
    let mut conn = server();
    let wire = b"GET /one HTTP/1.1\r\nHost: x\r\n\r\nGET /two HTTP/1.1\r\nHost: x\r\n\r\n";
    let events = feed_all(&mut conn, wire).expect("two pipelined requests");
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(expect_request(&events[0]).1, "/one");
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert_eq!(expect_request(&events[2]).1, "/two");
    assert_eq!(events[3], Event::MessageEnd { trailers: vec![] });
}

// -------------------------------------------------------------------------------------------
// Limits and the malformed corpus
// -------------------------------------------------------------------------------------------

#[test]
fn oversized_heads_are_431_and_stop_growing_the_buffer() {
    let limits = Limits {
        max_head_bytes: 64,
        max_headers: 10,
    };
    let mut conn = Conn::new(Role::Server, limits);
    let mut reported = None;
    for _ in 0..200 {
        if let Err(error) = conn.feed(b"X") {
            reported = Some(error);
            break;
        }
    }
    let error = reported.expect("slow-loris head must hit the limit");
    assert_eq!(error.status, 431);
    assert_eq!(error.code, "ERR_HTTP_HEADERS_OVERFLOW");
    assert!(conn.is_failed());
    // C5: exactly one error; further bytes are ignored, never events.
    assert!(conn.feed(b"more bytes").is_ok());
    assert!(conn.next_event().is_none());

    // A complete head that is itself larger than the limit is 431 too.
    let limits = Limits {
        max_head_bytes: 64,
        max_headers: 10,
    };
    let mut conn = Conn::new(Role::Server, limits);
    let mut wire = b"GET / HTTP/1.1\r\nX-Pad: ".to_vec();
    wire.extend_from_slice(&[b'a'; 100]);
    wire.extend_from_slice(b"\r\n\r\n");
    assert_eq!(conn.feed(&wire).unwrap_err().status, 431);
}

#[test]
fn too_many_headers_are_431_before_httparse_runs() {
    let limits = Limits {
        max_head_bytes: 4096,
        max_headers: 2,
    };
    let mut conn = Conn::new(Role::Server, limits);
    let error = conn
        .feed(b"GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n")
        .expect_err("three headers exceed max_headers=2");
    assert_eq!(error.status, 431);
    assert_eq!(error.code, "ERR_HTTP_HEADERS_OVERFLOW");

    let mut conn = Conn::new(Role::Server, limits);
    let events = feed_all(&mut conn, b"GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\n\r\n")
        .expect("exactly max_headers is fine");
    assert_eq!(events.len(), 2);
}

struct BadHead {
    name: &'static str,
    role: Role,
    outbound: Option<&'static [u8]>,
    wire: &'static [u8],
}

#[test]
fn the_malformed_head_corpus_is_400_and_fails_once() {
    let cases = [
        BadHead {
            name: "bare LF inside a head",
            role: Role::Server,
            outbound: None,
            wire: b"GET / HTTP/1.1\r\nHost: x\nFoo: y\r\n\r\n",
        },
        BadHead {
            name: "bare LF terminators only",
            role: Role::Server,
            outbound: None,
            wire: b"GET / HTTP/1.1\nHost: x\n\n",
        },
        BadHead {
            name: "header without a colon",
            role: Role::Server,
            outbound: None,
            wire: b"GET / HTTP/1.1\r\nHost example.com\r\n\r\n",
        },
        BadHead {
            name: "space before the colon",
            role: Role::Server,
            outbound: None,
            wire: b"GET / HTTP/1.1\r\nHost : example.com\r\n\r\n",
        },
        BadHead {
            name: "NUL in a header value",
            role: Role::Server,
            outbound: None,
            wire: b"GET / HTTP/1.1\r\nHost: ex\x00ample\r\n\r\n",
        },
        BadHead {
            name: "Content-Length plus Transfer-Encoding",
            role: Role::Server,
            outbound: None,
            wire: b"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n",
        },
        BadHead {
            name: "request Transfer-Encoding without chunked",
            role: Role::Server,
            outbound: None,
            wire: b"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: gzip\r\n\r\n",
        },
        BadHead {
            name: "invalid Content-Length",
            role: Role::Server,
            outbound: None,
            wire: b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: five\r\n\r\n",
        },
        BadHead {
            name: "HTTP/0.9 request",
            role: Role::Server,
            outbound: None,
            wire: b"GET /\r\n\r\n",
        },
        BadHead {
            name: "garbage request line",
            role: Role::Server,
            outbound: None,
            wire: b"HELLO\r\n\r\n",
        },
        BadHead {
            name: "two-digit response status",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 20 OK\r\n\r\n",
        },
        BadHead {
            name: "response CL plus TE",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n",
        },
    ];

    for case in &cases {
        let mut conn = Conn::new(case.role, Limits::default());
        if let Some(outbound) = case.outbound {
            conn.encode_head(outbound).expect("outbound head");
        }
        let error = conn.feed(case.wire).expect_err(case.name);
        assert_parse_error(&error, case.name);
        assert!(conn.is_failed(), "{}", case.name);
        assert!(
            conn.next_event().is_none(),
            "{}: a head error must not queue events",
            case.name
        );
        // C5: one error, then silence, even if the peer keeps talking.
        assert!(
            conn.feed(b"GET / HTTP/1.1\r\n\r\n").is_ok(),
            "{}",
            case.name
        );
        assert!(conn.next_event().is_none(), "{}", case.name);
    }
}

#[test]
fn a_truncated_head_is_only_an_error_at_end_of_stream() {
    let mut conn = server();
    conn.feed(b"GET / HTTP/1.1\r\nHost: x")
        .expect("partial head is not an error yet");
    assert!(drain(&mut conn).is_empty());
    let error = conn.end_of_stream().expect_err("truncated head at EOF");
    assert_parse_error(&error, "truncated head");
    assert!(conn.is_failed());

    // A truncated length body has already delivered the head; EOF is still one error.
    let mut conn = server();
    feed_all(
        &mut conn,
        b"POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhel",
    )
    .expect("partial body is not an error yet");
    let error = conn.end_of_stream().expect_err("truncated body at EOF");
    assert_parse_error(&error, "truncated length body");
}

// -------------------------------------------------------------------------------------------
// Fragment invariance
// -------------------------------------------------------------------------------------------

struct Fixture {
    name: &'static str,
    role: Role,
    outbound: Option<&'static [u8]>,
    wire: &'static [u8],
    eof: bool,
}

fn run_fixture(fixture: &Fixture, fragment: usize) -> Result<Vec<Event>, ProtocolError> {
    let mut conn = Conn::new(fixture.role, Limits::default());
    if let Some(outbound) = fixture.outbound {
        conn.encode_head(outbound)?;
    }
    if fragment == 0 {
        conn.feed(fixture.wire)?;
    } else {
        for part in fixture.wire.chunks(fragment) {
            conn.feed(part)?;
        }
    }
    let mut events = drain(&mut conn);
    if fixture.eof {
        conn.end_of_stream()?;
        events.extend(drain(&mut conn));
    }
    Ok(events)
}

#[test]
fn every_valid_fixture_is_fragment_invariant() {
    let fixtures = [
        Fixture {
            name: "plain request",
            role: Role::Server,
            outbound: None,
            wire: GET_HEAD,
            eof: false,
        },
        Fixture {
            name: "request with a length body",
            role: Role::Server,
            outbound: None,
            wire: b"POST /submit HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/plain\r\nContent-Length: 11\r\n\r\nhello world",
            eof: false,
        },
        Fixture {
            name: "request with a chunked body and trailers",
            role: Role::Server,
            outbound: None,
            wire: CHUNKED_REQUEST,
            eof: false,
        },
        Fixture {
            name: "HTTP/1.0 request",
            role: Role::Server,
            outbound: None,
            wire: b"GET / HTTP/1.0\r\nHost: x\r\n\r\n",
            eof: false,
        },
        Fixture {
            name: "response with a length body",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello",
            eof: false,
        },
        Fixture {
            name: "response with a chunked body",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
            eof: false,
        },
        Fixture {
            name: "204 response",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n",
            eof: false,
        },
        Fixture {
            name: "response to HEAD",
            role: Role::Client,
            outbound: Some(HEAD_HEAD),
            wire: b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n",
            eof: false,
        },
        Fixture {
            name: "304 response",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 304 Not Modified\r\nETag: \"x\"\r\n\r\n",
            eof: false,
        },
        Fixture {
            name: "100 then 200",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
            eof: false,
        },
        Fixture {
            name: "EOF body",
            role: Role::Client,
            outbound: Some(GET_HEAD),
            wire: b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nbody until EOF",
            eof: true,
        },
        Fixture {
            name: "two pipelined requests",
            role: Role::Server,
            outbound: None,
            wire: b"GET /one HTTP/1.1\r\nHost: x\r\n\r\nGET /two HTTP/1.1\r\nHost: x\r\n\r\n",
            eof: false,
        },
    ];

    for fixture in &fixtures {
        let whole = run_fixture(fixture, 0)
            .unwrap_or_else(|error| panic!("{}: whole feed failed: {error:?}", fixture.name));
        assert!(!whole.is_empty(), "{}: no events", fixture.name);
        for fragment in [1usize, 7, fixture.wire.len()] {
            let fragmented = run_fixture(fixture, fragment).unwrap_or_else(|error| {
                panic!("{}: {fragment}-byte feed failed: {error:?}", fixture.name)
            });
            assert_eq!(
                fragmented, whole,
                "{}: events differ when fed {fragment} bytes at a time",
                fixture.name
            );
        }
    }
}

#[test]
fn large_bodies_are_coalesced_into_deterministic_blocks() {
    let body = vec![b'a'; BODY_BLOCK_BYTES * 2 + 10];

    let mut length_wire = b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ".to_vec();
    length_wire.extend_from_slice(body.len().to_string().as_bytes());
    length_wire.extend_from_slice(b"\r\n\r\n");
    length_wire.extend_from_slice(&body);

    let mut chunked_wire =
        b"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    chunked_wire.extend_from_slice(format!("{:x}", body.len()).as_bytes());
    chunked_wire.extend_from_slice(b"\r\n");
    chunked_wire.extend_from_slice(&body);
    chunked_wire.extend_from_slice(b"\r\n0\r\n\r\n");

    for (name, wire) in [("length", length_wire), ("chunked", chunked_wire)] {
        let mut whole = server();
        let expected = feed_all(&mut whole, &wire).expect("whole feed");
        let expected_sizes: Vec<usize> = expected
            .iter()
            .filter_map(|event| match event {
                Event::Body { bytes } => Some(bytes.len()),
                _ => None,
            })
            .collect();
        assert_eq!(
            expected_sizes,
            vec![BODY_BLOCK_BYTES, BODY_BLOCK_BYTES, 10],
            "{name}: body blocks"
        );

        let mut byte_wise = server();
        let actual = feed_fragmented(&mut byte_wise, &wire, 1).expect("byte-wise feed");
        assert_eq!(actual, expected, "{name}: one-byte feed differs");

        let mut seven = server();
        let actual = feed_fragmented(&mut seven, &wire, 7).expect("seven-byte feed");
        assert_eq!(actual, expected, "{name}: seven-byte feed differs");
    }
}

// -------------------------------------------------------------------------------------------
// Upgrade passthrough
// -------------------------------------------------------------------------------------------

const UPGRADE_REQUEST: &[u8] =
    b"GET /chat HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
const SWITCHING_PROTOCOLS: &[u8] =
    b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";

#[test]
fn a_server_hands_over_buffered_bytes_once_it_encodes_101() {
    let mut conn = server();
    let mut wire = UPGRADE_REQUEST.to_vec();
    wire.extend_from_slice(b"EARLY-FRAME");
    let events = feed_all(&mut conn, &wire).expect("upgrade request");
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(matches!(&events[0], Event::Request { .. }));
    assert_eq!(events[1], Event::MessageEnd { trailers: vec![] });
    assert!(
        conn.next_event().is_none(),
        "the upgrade bytes are held until JS answers"
    );

    conn.encode_head(SWITCHING_PROTOCOLS).expect("101 head");
    assert_eq!(
        conn.next_event(),
        Some(Event::Upgrade {
            bytes: b"EARLY-FRAME".to_vec()
        })
    );
    assert!(conn.next_event().is_none());

    // Post-handover reads are passthrough, and the codec never tries to parse them.
    conn.feed(b"LATER-FRAME").expect("passthrough");
    assert_eq!(
        conn.next_event(),
        Some(Event::Upgrade {
            bytes: b"LATER-FRAME".to_vec()
        })
    );
    assert!(!conn.is_failed());
}

#[test]
fn a_server_hands_over_bytes_for_a_connect_2xx() {
    let mut conn = server();
    let mut wire = CONNECT_HEAD.to_vec();
    wire.extend_from_slice(b"\x16\x03\x01TLS");
    let events = feed_all(&mut conn, &wire).expect("CONNECT request");
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(expect_request(&events[0]).0, "CONNECT");
    assert!(conn.next_event().is_none());

    conn.encode_head(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .expect("2xx to CONNECT");
    assert_eq!(
        conn.next_event(),
        Some(Event::Upgrade {
            bytes: b"\x16\x03\x01TLS".to_vec()
        })
    );
}

#[test]
fn an_interim_1xx_does_not_cancel_a_pending_upgrade() {
    let mut conn = server();
    let mut wire = UPGRADE_REQUEST.to_vec();
    wire.extend_from_slice(b"EARLY");
    feed_all(&mut conn, &wire).expect("upgrade request");

    conn.encode_head(b"HTTP/1.1 100 Continue\r\n\r\n")
        .expect("interim 100");
    assert!(conn.next_event().is_none());
    conn.encode_head(SWITCHING_PROTOCOLS).expect("final 101");
    assert_eq!(
        conn.next_event(),
        Some(Event::Upgrade {
            bytes: b"EARLY".to_vec()
        })
    );
}

#[test]
fn a_server_that_declines_an_upgrade_resumes_parsing() {
    let mut conn = server();
    let events = feed_all(&mut conn, UPGRADE_REQUEST).expect("upgrade request");
    assert_eq!(events.len(), 2, "{events:?}");

    let mut out = Vec::new();
    conn.encode_head(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n")
        .expect("decline with 200");
    conn.encode_body(b"no", &mut out);
    conn.finish(&mut out);
    assert_eq!(out, b"no");

    let events = feed_all(&mut conn, GET_HEAD).expect("next request after decline");
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(expect_request(&events[0]).1, "/");
}

#[test]
fn a_client_hands_over_after_101_with_the_response_first() {
    let mut conn = client();
    conn.encode_head(UPGRADE_REQUEST)
        .expect("outbound upgrade head");
    let mut wire = SWITCHING_PROTOCOLS.to_vec();
    wire.extend_from_slice(b"FRAME");
    let events = feed_all(&mut conn, &wire).expect("101 response");
    assert_eq!(events.len(), 2, "{events:?}");
    let (status, _, _, _, _, body) = expect_response(&events[0]);
    assert_eq!((status, body), (101, BodyMode::None));
    assert_eq!(
        events[1],
        Event::Upgrade {
            bytes: b"FRAME".to_vec()
        }
    );
    assert!(!conn.is_failed());
}

#[test]
fn a_client_hands_over_bytes_for_a_connect_2xx_and_not_for_a_407() {
    let mut conn = client();
    conn.encode_head(CONNECT_HEAD)
        .expect("outbound CONNECT head");
    let events = feed_all(&mut conn, b"HTTP/1.1 200 Connection Established\r\n\r\nTLS")
        .expect("2xx to CONNECT");
    assert_eq!(events.len(), 2, "{events:?}");
    let (status, _, _, _, _, body) = expect_response(&events[0]);
    assert_eq!((status, body), (200, BodyMode::None));
    assert_eq!(
        events[1],
        Event::Upgrade {
            bytes: b"TLS".to_vec()
        }
    );

    // A non-2xx is a normal response with a normal body, not an upgrade.
    let mut conn = client();
    conn.encode_head(CONNECT_HEAD)
        .expect("outbound CONNECT head");
    let events = feed_all(
        &mut conn,
        b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 3\r\n\r\nbad",
    )
    .expect("407 to CONNECT");
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(expect_response(&events[0]).0, 407);
    assert_eq!(body_bytes(&events[1]), b"bad");
    assert_eq!(events[2], Event::MessageEnd { trailers: vec![] });
}

// -------------------------------------------------------------------------------------------
// Outbound
// -------------------------------------------------------------------------------------------

#[test]
fn a_chunked_request_round_trips_through_a_second_connection() {
    let mut client = Conn::new(Role::Client, Limits::default());
    let mut out = Vec::new();
    client
        .encode_head(
            b"POST /upload HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n",
        )
        .expect("chunked request head");
    assert_eq!(client.body_mode(), BodyMode::Chunked);
    client.encode_body(b"hello", &mut out);
    client.encode_body(b"", &mut out); // an empty chunk must not terminate the message
    client.encode_body(b" world", &mut out);
    client.finish(&mut out);
    client.finish(&mut out); // idempotent
    assert_eq!(out, b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");

    let mut wire =
        b"POST /upload HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n"
            .to_vec();
    wire.extend_from_slice(&out);
    let mut server = Conn::new(Role::Server, Limits::default());
    let events = feed_all(&mut server, &wire).expect("our own chunked bytes must parse");
    assert_eq!(events.len(), 4, "{events:?}");
    let (method, target, _, _, _, _, body) = expect_request(&events[0]);
    assert_eq!(
        (method, target, body),
        ("POST", "/upload", BodyMode::Chunked)
    );
    assert_eq!(body_bytes(&events[1]), b"hello");
    assert_eq!(body_bytes(&events[2]), b" world");
    assert_eq!(events[3], Event::MessageEnd { trailers: vec![] });
}

#[test]
fn a_chunked_response_round_trips_through_a_client() {
    let mut server = Conn::new(Role::Server, Limits::default());
    feed_all(&mut server, GET_HEAD).expect("inbound GET");
    server
        .encode_head(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
        .expect("chunked response head");
    let mut out = Vec::new();
    server.encode_body(b"chunk-one", &mut out);
    server.finish(&mut out);
    assert_eq!(out, b"9\r\nchunk-one\r\n0\r\n\r\n");

    let mut wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    wire.extend_from_slice(&out);
    let mut client = Conn::new(Role::Client, Limits::default());
    client.encode_head(GET_HEAD).expect("outbound GET");
    let events = feed_all(&mut client, &wire).expect("our own chunked bytes must parse");
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(expect_response(&events[0]).5, BodyMode::Chunked);
    assert_eq!(body_bytes(&events[1]), b"chunk-one");
    assert_eq!(events[2], Event::MessageEnd { trailers: vec![] });
}

#[test]
fn outbound_content_length_truncates_and_a_declared_no_body_ignores_body_bytes() {
    let mut conn = server();
    conn.encode_head(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
        .expect("length response");
    assert_eq!(conn.body_mode(), BodyMode::Length(5));
    let mut out = Vec::new();
    conn.encode_body(b"abcdefgh", &mut out); // exceeds the declared length
    conn.encode_body(b"more", &mut out); // already full
    conn.finish(&mut out);
    assert_eq!(out, b"abcde");

    let mut conn = server();
    conn.encode_head(b"HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n")
        .expect("204 response");
    assert_eq!(conn.body_mode(), BodyMode::None);
    let mut out = Vec::new();
    conn.encode_body(b"dropped", &mut out);
    conn.finish(&mut out);
    assert!(out.is_empty());
}

#[test]
fn a_server_remembers_head_and_connect_methods_for_outbound_framing() {
    let mut conn = server();
    feed_all(&mut conn, HEAD_HEAD).expect("inbound HEAD");
    conn.encode_head(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
        .expect("response to HEAD");
    assert_eq!(conn.body_mode(), BodyMode::None);
    let mut out = Vec::new();
    conn.encode_body(b"never sent", &mut out);
    conn.finish(&mut out);
    assert!(out.is_empty());

    // CONNECT: the request method the server remembers turns a 2xx into an upgrade handover.
    let mut conn = server();
    let mut request_and_bytes = CONNECT_HEAD.to_vec();
    request_and_bytes.extend_from_slice(b"early bytes");
    let events = feed_all(&mut conn, &request_and_bytes).expect("CONNECT with early bytes");
    assert_eq!(events.len(), 2, "{events:?}");
    conn.encode_head(b"HTTP/1.1 200 OK\r\n\r\n")
        .expect("2xx to CONNECT");
    assert_eq!(
        conn.next_event(),
        Some(Event::Upgrade {
            bytes: b"early bytes".to_vec()
        })
    );
}

#[test]
fn outbound_head_validation_rejects_malformed_heads_with_500() {
    let cases: &[(&str, &[u8])] = &[
        (
            "not terminated by CRLF CRLF",
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n",
        ),
        (
            "second head after a blank line",
            b"HTTP/1.1 200 OK\r\nX: y\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
        ),
        ("bare LF inside the head", b"HTTP/1.1 200 OK\nX: y\r\n\r\n"),
        (
            "bare CR inside a value",
            b"HTTP/1.1 200 OK\r\nX: a\rb\r\n\r\n",
        ),
        ("bad status code", b"HTTP/1.1 099 OK\r\n\r\n"),
        (
            "space before the colon",
            b"HTTP/1.1 200 OK\r\nX-Name : value\r\n\r\n",
        ),
        (
            "Transfer-Encoding plus Content-Length",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n",
        ),
        (
            "request Transfer-Encoding without chunked",
            b"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: gzip\r\n\r\n",
        ),
    ];

    for (name, head) in cases {
        let mut conn = server();
        let error = conn.encode_head(head).expect_err(name);
        assert_eq!(error.status, 500, "{name}: {error:?}");
        assert_eq!(error.code, "ERR_HTTP_INVALID_HEAD", "{name}: {error:?}");
        // A caller bug is not a peer parse failure.
        assert!(!conn.is_failed(), "{name}");
    }

    // The role decides which head is expected: a server never authors a request line.
    let mut conn = server();
    assert_eq!(conn.encode_head(GET_HEAD).unwrap_err().status, 500);
    // ...and a client never authors a response line.
    let mut conn = client();
    assert_eq!(
        conn.encode_head(b"HTTP/1.1 200 OK\r\n\r\n")
            .unwrap_err()
            .status,
        500
    );

    // A rejected head leaves the codec usable for a legal one.
    let mut conn = server();
    assert!(conn.encode_head(b"nonsense").is_err());
    conn.encode_head(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        .expect("valid head still works");
}

#[test]
fn encode_head_never_re_serializes_caller_bytes() {
    // encode_head only observes; a legal caller-authored head is not echoed or normalized.
    let mut conn = client();
    let head =
        b"POST /x HTTP/1.1\r\nhost:   Example.COM\r\nX-Odd:   spaced  \r\nContent-Length: 4\r\n\r\n";
    conn.encode_head(head).expect("legal head");
    let mut out = Vec::new();
    conn.encode_body(b"body", &mut out);
    conn.finish(&mut out);
    assert_eq!(out, b"body");
}

#[test]
fn expect_continue_is_surfaced_and_write_continue_is_an_interim_response() {
    let mut conn = server();
    let events = feed_all(
        &mut conn,
        b"POST /upload HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 3\r\n\r\nabc",
    )
    .expect("valid expect-continue request");
    let (_, _, _, _, _, expect_continue, body) = expect_request(&events[0]);
    assert!(expect_continue);
    assert_eq!(body, BodyMode::Length(3));

    let mut out = Vec::new();
    conn.write_continue(&mut out);
    assert_eq!(out, b"HTTP/1.1 100 Continue\r\n\r\n");

    let mut conn = server();
    let events = feed_all(
        &mut conn,
        b"POST / HTTP/1.1\r\nExpect: 100-Continue\r\n\r\n",
    )
    .expect("case-insensitive Expect");
    assert!(expect_request(&events[0]).5);
}

#[test]
fn arbitrary_and_mutated_peer_bytes_never_panic() {
    let inputs: [(&[u8], Role); 5] = [
        (GET_HEAD, Role::Server),
        (CHUNKED_REQUEST, Role::Server),
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc",
            Role::Client,
        ),
        (
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n\r\n",
            Role::Client,
        ),
        (b"\x00\r\n\r\n\xff\xff", Role::Server),
    ];
    let replacements = [0x00u8, 0x0a, 0x0d, 0x3a, 0x20, 0x7f, 0xff];

    for (wire, role) in inputs {
        for index in 0..wire.len() {
            for replacement in replacements {
                let mut mutated = wire.to_vec();
                mutated[index] = replacement;
                let mut conn = Conn::new(role, Limits::default());
                let _ = conn.feed(&mutated);
                let _ = conn.end_of_stream();
                while conn.next_event().is_some() {}
            }
        }
    }
}
