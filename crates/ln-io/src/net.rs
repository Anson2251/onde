//! The M4 network protocol: live handles, commands and events.
//!
//! [ADR-0006](../../docs/adr/0006-handles-and-events.md) splits host capabilities in two: an
//! [`Op`](crate::Op) is bounded work with one result ([ADR-0005](../../docs/adr/0005-ops-protocol.md)),
//! a **handle** is a live connection that emits events until it closes. A TCP socket, a TLS
//! session and an HTTP/1.1 connection are handles; `dns.lookup` stays an op.
//!
//! This file is the locked M4 interface shared by `ln-runtime` and WP1's transport tasks. WP1
//! implements the tasks behind it; everyone else codes against these types. Extend, do not rename.
//!
//! One id space: handle ids and op ids come from the same `RequestId` sequence (see
//! `docs/m4-plan.md` §2.1), so an id in a `Completion` is never ambiguous.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use ln_error::NodeError;
use ln_http::{Limits, Role};

mod connection;
pub(crate) mod dns;
mod error;
mod listener;
mod registry;
mod service;
mod tls;
mod transport;

pub use service::NetService;

/// Identifies one live connection for its lifetime. Same id space as [`crate::RequestId`].
pub type HandleId = u64;

/// The largest chunk a single `read` command may pull. Node's streams use 64 KiB; keeping the
/// bound here is what makes the slow-loris criterion a property of the design (ADR-0006 H7).
pub const MAX_CHUNK: u32 = 64 * 1024;

/// Address family requested by the JS layer (`net.connect({ family })`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IpFamily {
    V4,
    V6,
    #[default]
    Either,
}

/// A bound or connected endpoint, as `server.address()` / `socket.address()` report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Addr {
    Ip(SocketAddr),
    Unix(PathBuf),
}

impl Addr {
    /// Node's `family` string: `"IPv4"`, `"IPv6"` or `"unix"`.
    pub fn family(&self) -> &'static str {
        match self {
            Addr::Ip(address) if address.is_ipv4() => "IPv4",
            Addr::Ip(_) => "IPv6",
            Addr::Unix(_) => "unix",
        }
    }

    /// The port; Unix sockets have none, so `0`.
    pub fn port(&self) -> u16 {
        match self {
            Addr::Ip(address) => address.port(),
            Addr::Unix(_) => 0,
        }
    }

    pub fn ip(&self) -> Option<IpAddr> {
        match self {
            Addr::Ip(address) => Some(address.ip()),
            Addr::Unix(_) => None,
        }
    }
}

impl From<SocketAddr> for Addr {
    fn from(address: SocketAddr) -> Self {
        Addr::Ip(address)
    }
}

/// Address-family filter shared by `net.connect({ family })`, `server.listen` and
/// `dns.lookup({ family })`: `Either` accepts both, the others keep one family only.
pub(crate) fn family_matches(address: IpAddr, family: IpFamily) -> bool {
    match family {
        IpFamily::Either => true,
        IpFamily::V4 => address.is_ipv4(),
        IpFamily::V6 => address.is_ipv6(),
    }
}

/// TLS options for the client role. PEM bytes, not paths: the JS layer reads the files with
/// `fs.readFileSync`, so there is one file-reading path and one error shape.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TlsClientOptions {
    /// SNI name. `None` means "use the connect host", as Node does.
    pub servername: Option<String>,
    /// `rejectUnauthorized`, default `true` in Node.
    pub reject_unauthorized: bool,
    /// Extra or replacement roots, as PEM.
    pub ca_pem: Option<Vec<u8>>,
    /// ALPN protocols in preference order; `https` passes `["http/1.1"]`.
    pub alpn: Vec<String>,
}

impl TlsClientOptions {
    /// Node's defaults: verification on, no extra roots, no ALPN.
    pub fn new() -> Self {
        Self {
            servername: None,
            reject_unauthorized: true,
            ca_pem: None,
            alpn: Vec::new(),
        }
    }
}

/// TLS options for the server role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsServerOptions {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    pub alpn: Vec<String>,
}

/// `net.connect` arguments, independent of whether the endpoint is TCP or Unix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectOptions {
    pub family: IpFamily,
    pub local_address: Option<String>,
    pub local_port: Option<u16>,
    /// `setNoDelay(true)` before the first write, so a request is not delayed by Nagle.
    pub no_delay: bool,
    /// `setKeepAlive(enable, initialDelay)`; `None` leaves the OS default alone.
    pub keep_alive_ms: Option<u32>,
    pub tls: Option<TlsClientOptions>,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        ConnectOptions {
            family: IpFamily::Either,
            local_address: None,
            local_port: None,
            no_delay: true,
            keep_alive_ms: None,
            tls: None,
        }
    }
}

/// `server.listen` arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenOptions {
    pub backlog: i32,
    pub ipv6_only: bool,
    /// Node's `exclusive`: do not share the port with a previous listener.
    pub exclusive: bool,
    pub tls: Option<TlsServerOptions>,
}

impl Default for ListenOptions {
    fn default() -> Self {
        ListenOptions {
            backlog: 511,
            ipv6_only: false,
            exclusive: false,
            tls: None,
        }
    }
}

/// Where to listen: `{ host, port }` or `{ path }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenTarget {
    Tcp {
        host: String,
        port: u16,
        options: ListenOptions,
    },
    Unix {
        path: PathBuf,
        options: ListenOptions,
    },
}

/// Where to connect. `host` is a name or a literal address; resolution happens inside the task
/// with the OS resolver, exactly like Node's default `dns.lookup`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectTarget {
    Tcp {
        host: String,
        port: u16,
        options: ConnectOptions,
    },
    Unix {
        path: PathBuf,
        options: ConnectOptions,
    },
}

/// A command from the isolate thread to a handle's task.
///
/// Commands are ordered per handle and are never dropped: the task's queue is unbounded in count
/// but bounded in bytes by the JS writable's high-water mark, which is what applies backpressure
/// (ADR-0006 H7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Listen(ListenTarget),
    Connect(ConnectTarget),
    /// Pull one chunk, at most `max` bytes (`MAX_CHUNK` is the cap).
    Read {
        max: u32,
    },
    /// Stop pulling: `socket.pause()` in raw mode, `IncomingMessage.pause()` in parsed mode. Bytes
    /// already buffered are delivered after a new `Read`. Bounding this way is what keeps a slow
    /// HTTP consumer from growing the parked event queue (ADR-0006 H7).
    ReadStop,
    Write {
        data: Vec<u8>,
    },
    /// Flush queued writes, then send FIN; the read side stays open (half-close).
    End,
    /// Close immediately. `closed` is still emitted exactly once.
    Destroy,
    /// Close immediately with a TCP reset (`SO_LINGER` on with a zero timeout) instead of a FIN,
    /// like Node's `socket.resetAndDestroy()`. Queued writes are discarded, as in Node.
    Reset,
    /// Leave parsed mode and go back to raw `data` events (`'upgrade'`, `CONNECT`).
    Detach,
    /// Start the HTTP codec on this connection (ADR-0007).
    HttpAttach {
        role: Role,
        limits: Limits,
    },
    /// A request/response head authored by the JS layer, validated but not re-serialized.
    HttpHead {
        bytes: Vec<u8>,
    },
    /// One body chunk in parsed mode; the codec applies the framing.
    HttpBody {
        bytes: Vec<u8>,
    },
    /// Finish the message. `keep_alive` is JS's decision (ADR-0007 §2.7).
    HttpEnd {
        keep_alive: bool,
    },
    /// Write an interim `100 Continue` (`res.writeContinue()`). Parsed mode only, before the final
    /// head; it never touches the outbound framing.
    HttpContinue,
    SetNoDelay(bool),
    SetKeepAlive {
        enable: bool,
        initial_delay_ms: u32,
    },
    /// Take one loop ref (idempotent).
    ///
    /// Accepted and deliberately ignored by the task: loop refcounts are per handle and owned by
    /// the handle table in `ln-runtime` (WP3), not by the task (ADR-0006 §2.4, H3). `unref` is not
    /// a read stop, so a socket keeps reading either way.
    Ref,
    /// Release the handle's loop ref (idempotent). The handle keeps running.
    Unref,
}

/// One event from a handle's task to the isolate thread. Delivered as
/// `__ln_handle_event(id, name, payload)` after conversion; payloads are plain Rust (ADR-0006 H1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Listening {
        local: Addr,
    },
    /// A server accepted a connection. `handle` is minted by the task and observed by the id
    /// allocator before the event is dispatched.
    ///
    /// For a TLS listener the event is emitted by the connection's own child task **after** the
    /// handshake, so a peer that never completes one never becomes a visible socket, and the
    /// ALPN/TLS-version details are already known when JS builds the `net.Socket`.
    Connection {
        handle: HandleId,
        remote: Addr,
        /// `"http/1.1"` when ALPN negotiated it, else `None`.
        alpn: Option<String>,
        /// The negotiated TLS version (`"TLSv1.3"`), or `None` for a plain transport.
        protocol: Option<String>,
    },
    Connected {
        local: Addr,
        remote: Addr,
        /// `"http/1.1"` when ALPN negotiated it, else `None`.
        alpn: Option<String>,
        /// The negotiated TLS version as `socket.getProtocol()` reports it (`"TLSv1.3"`), or
        /// `None` for a plain transport.
        protocol: Option<String>,
    },
    /// Raw-mode bytes.
    Data {
        bytes: Vec<u8>,
    },
    /// The peer closed its write side. `allowHalfOpen` handling belongs to JS.
    End,
    /// The write queue is empty (`'drain'`).
    Drain,
    /// The idle timer fired. Advisory: JS decides whether to destroy the socket.
    Timeout,
    Error {
        error: NodeError,
    },
    /// Always last, exactly once (ADR-0006 H2).
    Closed {
        had_error: bool,
    },
    /// Parsed mode: a request or response head, a de-framed body chunk, the end of a message, or
    /// an upgrade handover.
    Http(ln_http::Event),
    /// Parsed mode: the peer sent bytes that are not a legal HTTP message. The connection is
    /// already closed; JS must not write a response.
    ClientError {
        error: NodeError,
    },
}

/// Mints handle ids for handles a task creates itself (accepted connections).
///
/// There is one id space per isolate: the same allocator backs `host.nextRequestId()`, so ids
/// minted by a pool task can never collide with ids minted on the isolate thread (see
/// `docs/m4-plan.md` §2.1). `ln-runtime` supplies this closure; `ln-io` only calls it.
pub type HandleIdSource = Arc<dyn Fn() -> HandleId + Send + Sync>;

/// Where a handle's task delivers events. `ln-runtime`'s sink parks them per handle and wakes the
/// loop with one `Completion(id)`; `ln-io` never touches `ln-sched` (ADR-0006 §2.3).
pub type EventSink = Arc<dyn Fn(HandleId, Event) + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    /// H1: commands and events cross a thread boundary, so they must be `Send` by construction.
    #[test]
    fn protocol_values_are_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Command>();
        assert_send::<Event>();
        assert_send::<EventSink>();
        assert_send::<HandleIdSource>();
        assert_send::<ConnectTarget>();
        assert_send::<ListenTarget>();
        assert_send::<TlsClientOptions>();
        assert_send::<TlsServerOptions>();
    }

    #[test]
    fn addresses_report_node_family_names() {
        let v4: Addr = "127.0.0.1:8080".parse::<SocketAddr>().unwrap().into();
        assert_eq!(v4.family(), "IPv4");
        assert_eq!(v4.port(), 8080);
        let v6: Addr = "[::1]:0".parse::<SocketAddr>().unwrap().into();
        assert_eq!(v6.family(), "IPv6");
        let unix = Addr::Unix(PathBuf::from("/tmp/s.sock"));
        assert_eq!(unix.family(), "unix");
        assert_eq!(unix.port(), 0);
        assert_eq!(unix.ip(), None);
    }

    #[test]
    fn tls_client_defaults_match_node() {
        let tls = TlsClientOptions::new();
        assert!(tls.reject_unauthorized);
        assert!(tls.alpn.is_empty());
        assert!(tls.servername.is_none());
    }

    #[test]
    fn connect_and_listen_defaults_match_node() {
        assert!(ConnectOptions::default().no_delay);
        assert_eq!(ConnectOptions::default().family, IpFamily::Either);
        assert_eq!(ListenOptions::default().backlog, 511);
        assert_eq!(ConnectOptions::default().keep_alive_ms, None);
    }

    #[test]
    fn the_read_cap_is_sixty_four_kilobytes() {
        assert_eq!(MAX_CHUNK, 65536);
    }
}
