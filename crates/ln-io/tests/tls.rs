//! TLS end-to-end tests at the handle-service boundary: a real listener on `127.0.0.1:0`, a real
//! connector, the fixture CA and a real rustls handshake.
//!
//! This is the layer the JavaScript surface actually drives, so it is where "the server handshake
//! runs in the child task, not the accept loop" and "a failed handshake emits `error` then
//! `closed`" are observable. `crates/ln-io/src/net/tls.rs` owns the config-level and raw-pair
//! tests; nothing here inspects a rustls type.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use ln_io::net::{
    Addr, Command, ConnectOptions, ConnectTarget, Event, EventSink, HandleId, HandleIdSource,
    ListenOptions, ListenTarget, NetService, TlsClientOptions, TlsServerOptions,
};
use ln_io::Pool;

const WAIT: Duration = Duration::from_secs(5);

const CA: &[u8] = include_bytes!("../../../test/fixtures/tls/ca-cert.pem");
const SERVER_CERT: &[u8] = include_bytes!("../../../test/fixtures/tls/server-cert.pem");
const SERVER_KEY: &[u8] = include_bytes!("../../../test/fixtures/tls/server-key.pem");
const OTHER_CA: &[u8] = include_bytes!("../../../test/fixtures/tls/other-ca-cert.pem");

struct Events {
    rx: mpsc::Receiver<(HandleId, Event)>,
    pending: HashMap<HandleId, VecDeque<Event>>,
}

impl Events {
    fn next_for(&mut self, id: HandleId) -> Event {
        if let Some(event) = self
            .pending
            .get_mut(&id)
            .and_then(|queue| queue.pop_front())
        {
            return event;
        }
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for handle {id}");
            match self.rx.recv_timeout(remaining) {
                Ok((handle, event)) if handle == id => return event,
                Ok((handle, event)) => self.pending.entry(handle).or_default().push_back(event),
                Err(error) => panic!("no event for handle {id}: {error}"),
            }
        }
    }

    /// The next event that is not a write-queue `Drain` (writes always produce one).
    fn next_payload(&mut self, id: HandleId) -> Event {
        loop {
            match self.next_for(id) {
                Event::Drain => continue,
                event => return event,
            }
        }
    }
}

struct Harness {
    service: NetService,
    events: Events,
    next_id: Arc<AtomicU64>,
    _pool: Arc<Pool>,
}

impl Harness {
    fn new() -> Self {
        let pool = Arc::new(Pool::new(1).expect("tokio pool"));
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |id, event| {
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

    fn server_options() -> ListenOptions {
        ListenOptions {
            tls: Some(TlsServerOptions {
                cert_pem: SERVER_CERT.to_vec(),
                key_pem: SERVER_KEY.to_vec(),
                alpn: vec!["http/1.1".to_owned()],
            }),
            ..ListenOptions::default()
        }
    }

    fn client_options(ca: Option<&[u8]>, reject_unauthorized: bool) -> ConnectOptions {
        ConnectOptions {
            tls: Some(TlsClientOptions {
                servername: None,
                reject_unauthorized,
                ca_pem: ca.map(<[u8]>::to_vec),
                alpn: vec!["http/1.1".to_owned()],
            }),
            ..ConnectOptions::default()
        }
    }

    fn listen_tls(&mut self) -> (HandleId, u16) {
        let id = self.id();
        self.service.command(
            id,
            Command::Listen(ListenTarget::Tcp {
                host: "127.0.0.1".into(),
                port: 0,
                options: Self::server_options(),
            }),
        );
        match self.events.next_for(id) {
            Event::Listening {
                local: Addr::Ip(address),
            } => (id, address.port()),
            other => panic!("expected listening, got {other:?}"),
        }
    }

    fn connect_tls(&mut self, port: u16, options: ConnectOptions) -> HandleId {
        let id = self.id();
        self.service.command(
            id,
            Command::Connect(ConnectTarget::Tcp {
                host: "127.0.0.1".into(),
                port,
                options,
            }),
        );
        id
    }

    fn expect_connected(&mut self, id: HandleId) -> (Option<String>, Option<String>) {
        match self.events.next_for(id) {
            Event::Connected { alpn, protocol, .. } => (alpn, protocol),
            other => panic!("expected connected, got {other:?}"),
        }
    }

    fn read(&self, id: HandleId) {
        self.service.command(id, Command::Read { max: 64 * 1024 });
    }

    fn write(&self, id: HandleId, bytes: &[u8]) {
        self.service.command(
            id,
            Command::Write {
                data: bytes.to_vec(),
            },
        );
    }

    fn destroy(&self, id: HandleId) {
        self.service.command(id, Command::Destroy);
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.service.shutdown();
    }
}

/// The whole path: TLS listener → per-connection child task handshake → `connection` →
// the same echo semantics as a plain socket, with ALPN and the TLS version reported.
#[test]
fn a_tls_connection_echoes_with_alpn_and_a_tls_version() {
    let mut harness = Harness::new();
    let (server, port) = harness.listen_tls();

    let client = harness.connect_tls(port, Harness::client_options(Some(CA), true));
    let (alpn, protocol) = harness.expect_connected(client);
    assert_eq!(alpn.as_deref(), Some("http/1.1"));
    assert!(
        protocol
            .as_deref()
            .is_some_and(|protocol| protocol.starts_with("TLSv")),
        "the client reports a TLS version: {protocol:?}"
    );

    // The server only announces the connection once its handshake succeeded.
    let (accepted, server_alpn, server_protocol) = match harness.events.next_for(server) {
        Event::Connection {
            handle,
            remote,
            alpn,
            protocol,
        } => {
            // The peer address is the client's ephemeral port; only the loopback host is stable.
            match remote {
                Addr::Ip(address) => assert_eq!(address.ip().to_string(), "127.0.0.1"),
                other => panic!("expected an IP address, got {other:?}"),
            }
            (handle, alpn, protocol)
        }
        other => panic!("expected connection, got {other:?}"),
    };
    // The server's `connection` event already carries the handshake's results, so the socket JS
    // builds from it is complete (`secureConnection` sees a described socket).
    assert_eq!(server_alpn.as_deref(), Some("http/1.1"));
    assert!(server_protocol.is_some_and(|protocol| protocol.starts_with("TLSv")));

    harness.read(accepted);
    harness.write(client, b"ping");
    match harness.events.next_payload(accepted) {
        Event::Data { bytes } => assert_eq!(bytes, b"ping"),
        other => panic!("expected data, got {other:?}"),
    }
    harness.write(accepted, b"pong");
    harness.read(client);
    match harness.events.next_payload(client) {
        Event::Data { bytes } => assert_eq!(bytes, b"pong"),
        other => panic!("expected data, got {other:?}"),
    }

    harness.destroy(client);
    harness.destroy(accepted);
    harness.destroy(server);
}

/// The fixture CA is not in the bundled Mozilla store, so verification without `ca` must fail,
/// and the failure arrives as `error` + `closed { hadError: true }`, exactly like a refused TCP
/// connect.
#[test]
fn an_untrusted_server_fails_verification_and_closes_with_had_error() {
    let mut harness = Harness::new();
    let (server, port) = harness.listen_tls();

    let client = harness.connect_tls(port, Harness::client_options(Some(OTHER_CA), true));
    match harness.events.next_for(client) {
        Event::Error { error } => {
            assert_eq!(error.code, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
        }
        other => panic!("expected error, got {other:?}"),
    }
    match harness.events.next_for(client) {
        Event::Closed { had_error } => assert!(had_error),
        other => panic!("expected closed, got {other:?}"),
    }

    // No `connection` is ever announced for a failed handshake, so JS never sees a broken socket;
    // the server stays usable.
    harness.destroy(server);
}

/// `rejectUnauthorized: false` completes the handshake even without the CA (and with a name that
/// does not match): the signature is still checked, the chain is not.
#[test]
fn reject_unauthorized_false_connects_without_the_ca() {
    let mut harness = Harness::new();
    let (server, port) = harness.listen_tls();

    let mut options = Harness::client_options(None, false);
    if let Some(tls) = options.tls.as_mut() {
        tls.servername = Some("wrong.example".to_owned());
    }
    let client = harness.connect_tls(port, options);
    let (alpn, protocol) = harness.expect_connected(client);
    assert_eq!(alpn.as_deref(), Some("http/1.1"));
    assert!(protocol.is_some());

    let accepted = match harness.events.next_for(server) {
        Event::Connection { handle, .. } => handle,
        other => panic!("expected connection, got {other:?}"),
    };
    harness.destroy(client);
    harness.destroy(accepted);
    harness.destroy(server);
}

/// A plaintext client against a TLS listener is a handshake failure, not a panic, and the server
/// survives it (the accept loop never blocks on the handshake).
#[test]
fn a_plaintext_client_against_a_tls_listener_is_a_clean_failure() {
    let mut harness = Harness::new();
    let (server, port) = harness.listen_tls();

    let plain = harness.id();
    harness.service.command(
        plain,
        Command::Connect(ConnectTarget::Tcp {
            host: "127.0.0.1".into(),
            port,
            options: ConnectOptions::default(),
        }),
    );
    harness.expect_connected(plain);
    harness.read(plain);
    harness.write(plain, b"GET / HTTP/1.1\r\nHost: x\r\n\r\n");

    // The TLS child fails its handshake: rustls sends a fatal alert (bytes the plaintext peer
    // simply reads) and the TCP connection closes. No `connection` reaches the server.
    loop {
        harness.read(plain);
        match harness.events.next_payload(plain) {
            Event::Data { .. } => continue,
            Event::End => break,
            other => panic!("expected end after the failed handshake, got {other:?}"),
        }
    }
    harness.destroy(plain);
    match harness.events.next_payload(plain) {
        Event::Closed { had_error } => assert!(!had_error),
        other => panic!("expected closed, got {other:?}"),
    }

    // The listener is still healthy: a correct TLS client can still connect.
    let client = harness.connect_tls(port, Harness::client_options(Some(CA), true));
    harness.expect_connected(client);
    harness.destroy(client);
    harness.destroy(server);
}
