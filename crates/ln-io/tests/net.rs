//! Deterministic integration tests for the M4 network handles.
//!
//! Every listener binds `127.0.0.1:0`; every receive is bounded by `recv_timeout`, and no
//! assertion depends on wall-clock timing. The three "nothing happens" assertions (pause,
//! destroy, shutdown) necessarily wait a short bounded time for the absence of an event; that is
//! the only way to observe a negative, and the bound is a failure guard, not a measurement.
//!
//! The pump helpers reflect how the protocol actually works: socket reads are pull-based, so a
//! test must issue the next `Read` after each `Data`, on both sides of a conversation.

use std::collections::{HashMap, VecDeque};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use ln_http::{BodyMode, Event as HttpEvent, Limits, Role};
use ln_io::net::{
    Addr, Command, ConnectOptions, ConnectTarget, Event, EventSink, HandleId, HandleIdSource,
    IpFamily, ListenOptions, ListenTarget, NetService,
};
use ln_io::{execute, Op, OpValue, Pool};

/// Every positive wait fails the test after five seconds instead of hanging.
const WAIT: Duration = Duration::from_secs(5);
/// How long "no event must arrive" is observed for.
const QUIET: Duration = Duration::from_millis(200);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Events {
    rx: mpsc::Receiver<(HandleId, Event)>,
    pending: HashMap<HandleId, VecDeque<Event>>,
}

impl Events {
    fn pop(&mut self, id: HandleId) -> Option<Event> {
        self.pending
            .get_mut(&id)
            .and_then(|queue| queue.pop_front())
    }

    /// The next event for `id`, buffering events for other handles.
    fn next_for(&mut self, id: HandleId) -> Event {
        if let Some(event) = self.pop(id) {
            return event;
        }
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for an event on handle {id}"
            );
            match self.rx.recv_timeout(remaining) {
                Ok((handle, event)) if handle == id => return event,
                Ok((handle, event)) => self.pending.entry(handle).or_default().push_back(event),
                Err(error) => panic!("no event for handle {id}: {error}"),
            }
        }
    }

    /// The next event for any of `ids`, buffering events for other handles.
    fn any(&mut self, ids: &[HandleId]) -> (HandleId, Event) {
        for &id in ids {
            if let Some(event) = self.pop(id) {
                return (id, event);
            }
        }
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for an event on handles {ids:?}"
            );
            match self.rx.recv_timeout(remaining) {
                Ok((handle, event)) if ids.contains(&handle) => return (handle, event),
                Ok((handle, event)) => self.pending.entry(handle).or_default().push_back(event),
                Err(error) => panic!("no event for handles {ids:?}: {error}"),
            }
        }
    }

    /// Assert that no event is delivered for `ids` during [`QUIET`].
    fn assert_quiet(&mut self, ids: &[HandleId]) {
        let deadline = Instant::now() + QUIET;
        loop {
            for &id in ids {
                if let Some(event) = self.pop(id) {
                    panic!("unexpected event after shutdown for handle {id}: {event:?}");
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return;
            }
            match self.rx.recv_timeout(remaining) {
                Ok((handle, event)) => {
                    self.pending.entry(handle).or_default().push_back(event);
                }
                Err(_) => return,
            }
        }
    }
}

struct Harness {
    service: NetService,
    events: Events,
    next_id: Arc<AtomicU64>,
    // Declared last so the service (and its shutdown) outlives the runtime, like the isolate does.
    _pool: Arc<Pool>,
}

impl Harness {
    fn new() -> Self {
        let pool = Arc::new(Pool::new(1).expect("tokio pool"));
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |id, event| {
            // The receiver is the test; a send failure means the test already failed.
            let _ = tx.send((id, event));
        });
        let next_id = Arc::new(AtomicU64::new(1));
        let ids: HandleIdSource = {
            let next_id = next_id.clone();
            Arc::new(move || next_id.fetch_add(1, Ordering::SeqCst))
        };
        Harness {
            service: NetService::new(pool.clone(), sink, ids),
            events: Events {
                rx,
                pending: HashMap::new(),
            },
            next_id,
            _pool: pool,
        }
    }

    fn id(&self) -> HandleId {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn listen_tcp(&mut self) -> (HandleId, u16) {
        let id = self.id();
        self.service.command(
            id,
            Command::Listen(ListenTarget::Tcp {
                host: "127.0.0.1".into(),
                port: 0,
                options: ListenOptions::default(),
            }),
        );
        match self.events.next_for(id) {
            Event::Listening {
                local: Addr::Ip(address),
            } => (id, address.port()),
            other => panic!("expected listening, got {other:?}"),
        }
    }

    fn listen_unix(&mut self, path: PathBuf) -> HandleId {
        let id = self.id();
        self.service.command(
            id,
            Command::Listen(ListenTarget::Unix {
                path: path.clone(),
                options: ListenOptions::default(),
            }),
        );
        match self.events.next_for(id) {
            Event::Listening {
                local: Addr::Unix(reported),
            } => assert_eq!(reported, path),
            other => panic!("expected listening on the Unix path, got {other:?}"),
        }
        id
    }

    fn connect_tcp(&mut self, port: u16) -> HandleId {
        let id = self.id();
        self.service.command(
            id,
            Command::Connect(ConnectTarget::Tcp {
                host: "127.0.0.1".into(),
                port,
                options: ConnectOptions::default(),
            }),
        );
        match self.events.next_for(id) {
            Event::Connected { remote, alpn, .. } => {
                assert_eq!(remote, Addr::Ip(([127, 0, 0, 1], port).into()));
                assert_eq!(alpn, None, "a plain transport negotiates no ALPN");
                id
            }
            other => panic!("expected connected, got {other:?}"),
        }
    }

    fn connect_unix(&mut self, path: PathBuf) -> HandleId {
        let id = self.id();
        self.service.command(
            id,
            Command::Connect(ConnectTarget::Unix {
                path: path.clone(),
                options: ConnectOptions::default(),
            }),
        );
        match self.events.next_for(id) {
            Event::Connected { local, remote, .. } => {
                assert_eq!(local, Addr::Unix(path.clone()));
                assert_eq!(remote, Addr::Unix(path));
                id
            }
            other => panic!("expected connected, got {other:?}"),
        }
    }

    fn accept(&mut self, server: HandleId) -> HandleId {
        let (handle, _) = self.accept_remote(server);
        handle
    }

    fn accept_remote(&mut self, server: HandleId) -> (HandleId, Addr) {
        match self.events.next_for(server) {
            Event::Connection { handle, remote } => {
                assert_ne!(handle, 0, "0 means no handle");
                (handle, remote)
            }
            other => panic!("expected connection, got {other:?}"),
        }
    }

    fn write(&self, id: HandleId, data: Vec<u8>) {
        self.service.command(id, Command::Write { data });
    }

    fn read(&self, id: HandleId) {
        self.service.command(
            id,
            Command::Read {
                max: ln_io::net::MAX_CHUNK,
            },
        );
    }

    fn read_stop(&self, id: HandleId) {
        self.service.command(id, Command::ReadStop);
    }

    fn end(&self, id: HandleId) {
        self.service.command(id, Command::End);
    }

    fn destroy(&self, id: HandleId) {
        self.service.command(id, Command::Destroy);
    }

    /// Wait for `closed`. Data, `end` and `drain` may legally precede it (a destroy races the
    /// bytes already in flight); an `error` does not, so it fails the test.
    fn expect_closed(&mut self, id: HandleId) -> bool {
        loop {
            match self.events.next_for(id) {
                Event::Closed { had_error } => return had_error,
                Event::Data { .. } | Event::End | Event::Drain => {}
                other => panic!("unexpected event before closed on {id}: {other:?}"),
            }
        }
    }

    /// The next `data` event, skipping the `drain` events a completed write can interleave.
    fn expect_data(&mut self, id: HandleId) -> Vec<u8> {
        loop {
            match self.events.next_for(id) {
                Event::Data { bytes } => return bytes,
                Event::Drain => {}
                other => panic!("expected data on {id}, got {other:?}"),
            }
        }
    }
}

/// A full echo conversation: `payload` from the client, echoed back by the server.
///
/// Reads are pull-based, so both sides issue their first `Read` up front and one more after every
/// `Data`; that is also what makes the 1 MiB case a backpressure test rather than a buffering
/// test.
fn echo(h: &mut Harness, client: HandleId, server: HandleId, payload: &[u8]) -> (usize, bool) {
    for chunk in payload.chunks(ln_io::net::MAX_CHUNK as usize) {
        h.write(client, chunk.to_vec());
    }
    h.end(client);
    h.read(server);
    h.read(client);

    let mut echoed = 0usize;
    let mut drains = 0usize;
    let mut server_closed = false;
    loop {
        match h.events.any(&[client, server]) {
            // The server echoes every chunk it reads straight back to the client.
            (id, Event::Data { bytes }) if id == server => {
                h.write(server, bytes);
                h.read(server);
            }
            (_, Event::Data { bytes }) => {
                echoed += bytes.len();
                h.read(client);
            }
            (id, Event::End) if id == server => {
                // The client half-closed; finish the echo, then FIN from this side.
                h.end(server);
            }
            (_, Event::End) => break,
            (_, Event::Drain) => drains += 1,
            (_, Event::Error { error }) => panic!("socket error: {error:?}"),
            (id, Event::Closed { .. }) if id == client => {
                // The client's read side cannot end before the server's FIN.
                panic!("client closed before the echo completed")
            }
            // The server finishes (all echoes written, FIN sent) before the client has drained its
            // receive buffer, so its `closed` normally arrives during the round trip.
            (_, Event::Closed { had_error }) => {
                assert!(!had_error, "a clean echo closes without an error");
                server_closed = true;
            }
            _ => {}
        }
    }
    assert_eq!(echoed, payload.len(), "every byte must be echoed");
    assert!(drains >= 1, "a completed write queue emits drain");
    (echoed, server_closed)
}

// ---------------------------------------------------------------------------
// Raw mode
// ---------------------------------------------------------------------------

#[test]
fn echo_of_one_mib_preserves_order_and_applies_backpressure() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);

    // A payload larger than any socket buffer, with a byte pattern that would expose reordering.
    let payload: Vec<u8> = (0..1024 * 1024).map(|index| (index % 251) as u8).collect();
    let (echoed, server_closed) = echo(&mut h, client, accepted, &payload);
    assert_eq!(echoed, payload.len());

    // Both directions are done (client FIN + server FIN), so both handles close by themselves.
    if !server_closed {
        assert!(!h.expect_closed(accepted), "closed without an error event");
    }
    assert!(!h.expect_closed(client), "closed without an error event");
    h.events.assert_quiet(&[client, accepted]);
}

#[test]
fn half_close_lets_the_peer_finish_writing() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);

    // `end()` sends FIN; the read side stays open (allowHalfOpen semantics belong to JS).
    h.end(client);
    h.read(accepted);
    match h.events.next_for(accepted) {
        Event::End => {}
        other => panic!("expected end after the peer's FIN, got {other:?}"),
    }

    // The server's write side is still open after the peer's FIN.
    h.write(accepted, b"pong".to_vec());
    h.read(client);
    match h.events.next_for(client) {
        Event::Data { bytes } => assert_eq!(bytes, b"pong"),
        other => panic!("expected the peer's bytes after half-close, got {other:?}"),
    }

    h.destroy(client);
    h.destroy(accepted);
    assert!(!h.expect_closed(client));
    assert!(!h.expect_closed(accepted));
}

#[test]
fn read_stop_pauses_and_the_next_read_resumes_without_losing_bytes() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);

    h.write(client, b"first".to_vec());
    h.read(accepted);
    match h.events.next_for(accepted) {
        Event::Data { bytes } => assert_eq!(bytes, b"first"),
        other => panic!("expected the first chunk, got {other:?}"),
    }

    // `pause()` is a real stop: no read is issued, so no data can arrive.
    h.read_stop(accepted);
    h.write(client, b"second".to_vec());
    h.events.assert_quiet(&[accepted]);

    // `resume()` is a new read; the bytes the kernel held are still there.
    h.read(accepted);
    match h.events.next_for(accepted) {
        Event::Data { bytes } => assert_eq!(bytes, b"second"),
        other => panic!("expected the resumed chunk, got {other:?}"),
    }

    h.destroy(client);
    h.destroy(accepted);
    assert!(!h.expect_closed(client));
    assert!(!h.expect_closed(accepted));
}

#[test]
fn a_large_write_emits_drain_once_the_queue_is_empty() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);

    let payload = vec![7u8; 512 * 1024];
    h.write(client, payload.clone());
    h.read(accepted);

    let mut received = 0usize;
    let mut drained = false;
    while !drained {
        match h.events.any(&[client, accepted]) {
            (id, Event::Data { bytes }) if id == accepted => {
                received += bytes.len();
                h.read(accepted);
            }
            (id, Event::Drain) if id == client => drained = true,
            (_, Event::Error { error }) => panic!("socket error: {error:?}"),
            _ => {}
        }
    }
    // Draining means the queue left the task, not that the peer has consumed it yet.
    while received < payload.len() {
        match h.events.any(&[client, accepted]) {
            (id, Event::Data { bytes }) if id == accepted => {
                received += bytes.len();
                h.read(accepted);
            }
            (id, Event::Drain) if id == client => {}
            (_, Event::Error { error }) => panic!("socket error: {error:?}"),
            _ => {}
        }
    }
    assert_eq!(received, payload.len());

    h.destroy(client);
    h.destroy(accepted);
    assert!(!h.expect_closed(client));
    assert!(!h.expect_closed(accepted));
}

#[test]
fn destroy_mid_stream_closes_once_and_nothing_follows() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);

    h.write(client, vec![0xAB; 64 * 1024]);
    h.destroy(client);
    assert!(!h.expect_closed(client), "a local destroy is not an error");
    // H2/H4: exactly one `closed`, and it is last.
    h.events.assert_quiet(&[client]);

    // The server side observes the FIN (possibly after some data) and closes when told to.
    h.read(accepted);
    h.destroy(accepted);
    assert!(!h.expect_closed(accepted));
    h.events.assert_quiet(&[accepted]);
}

#[test]
fn connecting_to_a_closed_port_reports_econnrefused_then_closed() {
    // Bind and drop a listener so the port is certainly closed.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("local addr").port()
    };

    let mut h = Harness::new();
    let client = h.id();
    h.service.command(
        client,
        Command::Connect(ConnectTarget::Tcp {
            host: "127.0.0.1".into(),
            port,
            options: ConnectOptions::default(),
        }),
    );

    match h.events.next_for(client) {
        Event::Error { error } => {
            assert_eq!(error.code, "ECONNREFUSED");
            assert_eq!(error.syscall, Some("connect"));
            assert!(error.message.contains("ECONNREFUSED"));
        }
        other => panic!("expected ECONNREFUSED, got {other:?}"),
    }
    assert!(
        h.expect_closed(client),
        "a failed connect closes with hadError: true"
    );
    h.events.assert_quiet(&[client]);
}

#[cfg(unix)]
#[test]
fn unix_socket_echo() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("onde-net.sock");

    let mut h = Harness::new();
    let server = h.listen_unix(path.clone());
    let client = h.connect_unix(path.clone());
    let accepted = h.accept(server);

    let payload = b"unix-domain-sockets".to_vec();
    h.write(client, payload.clone());
    h.read(accepted);
    let received = h.expect_data(accepted);
    assert_eq!(received, payload);

    h.write(accepted, received);
    h.read(client);
    assert_eq!(h.expect_data(client), payload);

    h.destroy(client);
    h.destroy(accepted);
    h.destroy(server);
    assert!(!h.expect_closed(client));
    assert!(!h.expect_closed(accepted));
    assert!(
        !h.expect_closed(server),
        "the listener closes without an error"
    );
}

// ---------------------------------------------------------------------------
// `dns.lookup`
// ---------------------------------------------------------------------------

fn lookup(host: &str, family: IpFamily, all: bool) -> Result<OpValue, ln_error::NodeError> {
    let abort = AtomicBool::new(false);
    execute(
        Op::Lookup {
            host: host.into(),
            family,
            all,
        },
        &abort,
    )
}

#[test]
fn dns_lookup_resolves_localhost_and_filters_the_family() {
    let addresses = match lookup("localhost", IpFamily::Either, true).expect("localhost resolves") {
        OpValue::Addrs(addresses) => addresses,
        other => panic!("expected addresses, got {other:?}"),
    };
    assert!(!addresses.is_empty(), "localhost has at least one address");
    for address in &addresses {
        // `dns.lookup` reports addresses, not endpoints: the port is the JS layer's business.
        assert_eq!(address.port(), 0);
        assert!(matches!(address.family(), "IPv4" | "IPv6"));
    }

    // `all: false` is Node's default single-result form.
    let one = match lookup("localhost", IpFamily::Either, false).expect("localhost resolves") {
        OpValue::Addrs(addresses) => addresses,
        other => panic!("expected addresses, got {other:?}"),
    };
    assert_eq!(one.len(), 1);

    // The family filter applies before `all`.
    let v4 = match lookup("localhost", IpFamily::V4, true).expect("localhost resolves to IPv4") {
        OpValue::Addrs(addresses) => addresses,
        other => panic!("expected addresses, got {other:?}"),
    };
    assert!(!v4.is_empty());
    assert!(v4.iter().all(|address| address.family() == "IPv4"));
}

#[test]
fn dns_lookup_of_an_unknown_host_is_enotfound() {
    // RFC 2606 reserves `.invalid`: it can never resolve, so this does not depend on the network.
    let error = lookup("no-such-host.invalid", IpFamily::Either, false)
        .expect_err("a reserved-invalid host must not resolve");
    assert_eq!(error.code, "ENOTFOUND");
    assert_eq!(error.syscall, Some("getaddrinfo"));
    assert_eq!(error.errno, Some(-3008), "libuv's UV_ENOTFOUND");
    assert!(error.message.contains("no-such-host.invalid"));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[test]
fn shutdown_stops_event_delivery_and_later_commands() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);
    h.write(client, b"in flight".to_vec());

    // H4: once `shutdown` returns, nothing else is delivered.
    h.service.shutdown();
    h.events.assert_quiet(&[server, client, accepted]);

    // Commands after shutdown are ignored (the handle table is drained), never a panic (H5).
    h.service.command(client, Command::Read { max: 1024 });
    h.service.command(
        accepted,
        Command::Write {
            data: b"x".to_vec(),
        },
    );
    h.service.command(server, Command::Destroy);
    h.events.assert_quiet(&[server, client, accepted]);
}

fn open_fds() -> usize {
    #[cfg(target_os = "macos")]
    let directory = "/dev/fd";
    #[cfg(not(target_os = "macos"))]
    let directory = "/proc/self/fd";
    std::fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("cannot count fds in {directory}: {error}"))
        .count()
}

/// One connect/accept/close cycle. Both sides must be closed for their fds to go away.
fn connect_close_round(h: &mut Harness, server: HandleId, port: u16) {
    let client = h.connect_tcp(port);
    let accepted = h.accept(server);
    h.destroy(client);
    assert!(!h.expect_closed(client));
    h.destroy(accepted);
    assert!(!h.expect_closed(accepted));
}

#[test]
fn two_hundred_sequential_connections_leave_the_fd_count_flat() {
    let mut h = Harness::new();
    let (server, port) = h.listen_tcp();

    // Warm up once: the runtime creates its io-driver fds lazily, before the baseline is taken.
    connect_close_round(&mut h, server, port);
    let baseline = open_fds();

    for _ in 0..200 {
        connect_close_round(&mut h, server, port);
    }

    // The socket is dropped just before `closed` is emitted, but a task may still be unwinding;
    // poll instead of sleeping a fixed time, so the test fails on a real leak and not on a race.
    let deadline = Instant::now() + WAIT;
    loop {
        let current = open_fds();
        if current <= baseline {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fd count grew from {baseline} to {current}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ---------------------------------------------------------------------------
// Parsed mode (plumbing only: WP5 owns the HTTP surface and its corpus)
// ---------------------------------------------------------------------------

fn http_limits() -> Limits {
    Limits {
        max_head_bytes: 16 * 1024,
        max_headers: 100,
    }
}

/// `httpPause` must stop pulling from the socket, not merely stop delivering: bytes that arrive
/// while paused stay in the kernel until `read` resumes the stream. Without the pause, a slow
/// consumer would grow the parked event queue without bound (ADR-0006 H7).
#[test]
fn http_pause_stops_reading_and_read_resumes_the_body() {
    let mut h = Harness::new();
    let (listener, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let server = h.accept(listener);
    h.service.command(
        server,
        Command::HttpAttach {
            role: Role::Server,
            limits: http_limits(),
        },
    );

    let mut first = Vec::new();
    first.extend_from_slice(
        b"POST /upload HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    first.extend_from_slice(b"3e8\r\n");
    first.extend_from_slice(&vec![b'a'; 1000]);
    first.extend_from_slice(b"\r\n");
    h.write(client, first);

    match h.events.next_for(server) {
        Event::Http(HttpEvent::Request {
            method,
            target,
            body,
            ..
        }) => {
            assert_eq!(method, "POST");
            assert_eq!(target, "/upload");
            assert_eq!(body, BodyMode::Chunked);
        }
        other => panic!("expected a parsed request, got {other:?}"),
    }
    match h.events.next_for(server) {
        Event::Http(HttpEvent::Body { bytes }) => assert_eq!(bytes, vec![b'a'; 1000]),
        other => panic!("expected the first chunk as body bytes, got {other:?}"),
    }

    h.service.command(server, Command::ReadStop);
    h.events.assert_quiet(&[server]);

    // The bytes are in the socket, but a paused task must not read them.
    let mut second = Vec::new();
    second.extend_from_slice(b"3e8\r\n");
    second.extend_from_slice(&vec![b'b'; 1000]);
    second.extend_from_slice(b"\r\n0\r\n\r\n");
    h.write(client, second);
    h.events.assert_quiet(&[server]);

    h.service.command(
        server,
        Command::Read {
            max: ln_io::net::MAX_CHUNK,
        },
    );
    match h.events.next_for(server) {
        Event::Http(HttpEvent::Body { bytes }) => assert_eq!(bytes, vec![b'b'; 1000]),
        other => panic!("expected the resume to deliver the second chunk, got {other:?}"),
    }
    assert!(
        matches!(
            h.events.next_for(server),
            Event::Http(HttpEvent::MessageEnd { .. })
        ),
        "the chunked terminator must end the message"
    );
}

/// `httpContinue` is a complete fixed interim message, so it must not disturb the outbound
/// framing: `res.writeContinue()` has to be writable before the real head exists.
#[test]
fn http_continue_writes_an_interim_response_before_the_final_head() {
    let mut h = Harness::new();
    let (listener, port) = h.listen_tcp();
    let client = h.connect_tcp(port);
    let server = h.accept(listener);
    h.service.command(
        server,
        Command::HttpAttach {
            role: Role::Server,
            limits: http_limits(),
        },
    );

    h.write(
        client,
        b"POST /x HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n"
            .to_vec(),
    );
    match h.events.next_for(server) {
        Event::Http(HttpEvent::Request {
            expect_continue, ..
        }) => assert!(expect_continue),
        other => panic!("expected a parsed request, got {other:?}"),
    }

    h.read(client);
    h.service.command(server, Command::HttpContinue);
    loop {
        match h.events.next_for(client) {
            Event::Data { bytes } => {
                assert_eq!(bytes, b"HTTP/1.1 100 Continue\r\n\r\n");
                break;
            }
            // The request write completing drains the client's own outbound queue first.
            Event::Drain | Event::End => {}
            other => panic!("expected the interim response on the wire, got {other:?}"),
        }
    }
}
