//! One listening handle: bind (asynchronously), report `listening`, then accept forever.
//!
//! Argument errors were already thrown synchronously by `host.net` on the isolate thread, so every
//! failure here — including `EADDRINUSE` — is an `error` event on the server, exactly as Node
//! delivers it (m4-plan §4).
//!
//! Each accepted connection is a **new handle**: the listener mints an id through the same
//! allocator JS uses ([`Shared::mint`]), registers the connection task, and only then emits
//! `connection`. That order is what guarantees `connection` arrives before any `data`: no read can
//! be issued for the child handle until JS has seen the event.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ln_error::NodeError;
use ln_perm::{Capability, Request};
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use tokio::net::{lookup_host, TcpListener, UnixListener};
use tokio::sync::mpsc::UnboundedReceiver;

use super::connection::Connection;
use super::error::{from_errno, from_io, from_io_at, from_io_detail};
use super::registry::Shared;
// The resolver errors moved with `dns.lookup`, which is an op and no longer lives under `net`.
use crate::dns::{not_found, resolve_error};
// TLS is rustls-only: a `net`-only build never builds a config and never names the module.
#[cfg(feature = "tls")]
use super::tls::{self, ServerTls};
use super::transport::Transport;
use super::{Addr, Command, Event, HandleId, ListenOptions, ListenTarget};
use crate::{perm, Permit};

/// How long the accept loop sleeps after `EMFILE`/`ENFILE` before trying again. Long enough not to
/// spin on a full fd table (m4-plan §4), short enough that a freed fd is picked up promptly.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(75);

enum Bound {
    Tcp {
        listener: TcpListener,
        local: SocketAddr,
    },
    Unix {
        listener: UnixListener,
        path: PathBuf,
    },
}

impl Bound {
    fn local(&self) -> Addr {
        match self {
            Bound::Tcp { local, .. } => Addr::Ip(*local),
            Bound::Unix { path, .. } => Addr::Unix(path.clone()),
        }
    }

    async fn accept(&self) -> io::Result<(Transport, Addr)> {
        match self {
            Bound::Tcp { listener, .. } => {
                let (stream, peer) = listener.accept().await?;
                // Nagle off, matching Node's `server.noDelay` default: a response head and body
                // written as separate segments otherwise wait for a delayed ACK (~40 ms).
                let _ = stream.set_nodelay(true);
                // The accepted socket's `localAddress` is the server's bound address, which
                // `listening` already reported; the event only carries the peer.
                Ok((Transport::Tcp(stream), Addr::Ip(peer)))
            }
            Bound::Unix { listener, path } => {
                let (stream, _peer) = listener.accept().await?;
                let address = Addr::Unix(path.clone());
                Ok((Transport::Unix(stream), address))
            }
        }
    }
}

/// Run a listening handle until it is destroyed or the service shuts down.
pub(crate) async fn run(
    shared: Arc<Shared>,
    id: HandleId,
    target: ListenTarget,
    mut commands: UnboundedReceiver<Command>,
) {
    // The TLS config is built once, before binding: a malformed chain is one server `error`, and
    // every accepted connection then shares the cached config (m4-plan §2.5). A `net`-only build
    // has no `node:tls` to ask for TLS, so it never builds one.
    #[cfg(feature = "tls")]
    let tls = match tls_config(&target) {
        Ok(tls) => tls,
        Err(error) => {
            shared.emit(id, Event::Error { error });
            shared.emit(id, Event::Closed { had_error: true });
            shared.unregister(id);
            return;
        }
    };

    let bound = match bind(&target, shared.permit()).await {
        Ok(bound) => bound,
        Err(error) => {
            // A listen failure is an event on the server, never a throw (m4-plan §4).
            shared.emit(id, Event::Error { error });
            shared.emit(id, Event::Closed { had_error: true });
            shared.unregister(id);
            return;
        }
    };
    shared.emit(
        id,
        Event::Listening {
            local: bound.local(),
        },
    );

    let mut had_error = false;
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                // The channel closing means the service dropped the handle (shutdown).
                Some(Command::Destroy) | None => break,
                // A server has no other commands; unknown ones are ignored, never a panic (H5).
                Some(_) => {}
            },
            accepted = bound.accept() => match accepted {
                Ok((transport, remote)) => {
                    let handle = shared.mint();
                    if handle == 0 {
                        // `0` means "no handle" (ADR-0006 §2.1); never advertise one.
                        continue;
                    }
                    // The handshake runs in the child task and the child emits `connection` itself
                    // once TLS is up, so a slow handshake cannot stall this loop and a failed one
                    // never shows JS a socket (see `Connection::accept_tls`). A `net`-only build
                    // has no config to hold: TLS options cannot reach a listener without
                    // `node:tls`, so every accepted transport there is plain.
                    #[cfg(feature = "tls")]
                    if let Some(config) = tls.clone() {
                        // A TLS listener is always TCP (`tls_config` refuses Unix), so a non-TCP
                        // transport cannot be a TLS one and is dropped without `connection`.
                        if let Transport::Tcp(stream) = transport {
                            let connection_shared = shared.clone();
                            let remote = remote.clone();
                            // The child emits `connection` itself, so a failed spawn (an id
                            // collision) has nothing to report here.
                            let _ = shared.spawn_connection_task(handle, move |commands| {
                                Connection::accept_tls(
                                    connection_shared,
                                    handle,
                                    id,
                                    stream,
                                    config,
                                    remote,
                                    commands,
                                )
                            });
                        }
                        continue;
                    }
                    let connection = Connection::new(shared.clone(), handle, transport);
                    if !shared.spawn_connection(handle, connection) {
                        // An id collision is an allocator bug; refusing to emit
                        // `connection` for a handle nobody can address is the safe answer.
                        continue;
                    }
                    shared.emit(
                        id,
                        Event::Connection {
                            handle,
                            remote,
                            alpn: None,
                            protocol: None,
                        },
                    );
                }
                Err(error) => {
                    let errno = error.raw_os_error().unwrap_or(libc::EIO);
                    if backoff_errno(errno) {
                        // Out of file descriptors: report it and stop spinning. The fd count is
                        // asserted flat by the M4 fd-leak test, so this must not allocate.
                        had_error = true;
                        shared.emit(id, Event::Error {
                            error: from_errno(errno, "accept", None, None),
                        });
                        tokio::time::sleep(ACCEPT_BACKOFF).await;
                    } else if retryable_errno(errno) {
                        // A connection that died between SYN and accept is not the server's error.
                        continue;
                    } else {
                        shared.emit(id, Event::Error { error: from_io(&error, "accept") });
                        had_error = true;
                        break;
                    }
                }
            },
        }
    }

    shared.emit(id, Event::Closed { had_error });
    shared.unregister(id);
}

/// `EMFILE`/`ENFILE` are the fd-table-full cases; `ENOBUFS`/`ENOMEM` are the same backoff shape.
fn backoff_errno(errno: i32) -> bool {
    matches!(
        errno,
        libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM
    )
}

/// Transient accept failures libuv simply retries.
fn retryable_errno(errno: i32) -> bool {
    matches!(
        errno,
        libc::ECONNABORTED
            | libc::EPROTO
            | libc::EINTR
            | libc::ENETDOWN
            | libc::ENETUNREACH
            | libc::EHOSTUNREACH
            | libc::EHOSTDOWN
    )
}

/// The listener's TLS config, if it asked for one.
///
/// TLS over a Unix socket is refused rather than downgraded to plaintext: the transport halves are
/// TCP-shaped, and a silent plaintext listener is a security bug, not a compatibility gap.
#[cfg(feature = "tls")]
fn tls_config(target: &ListenTarget) -> Result<Option<ServerTls>, NodeError> {
    let (options, unix) = match target {
        ListenTarget::Tcp { options, .. } => (options, false),
        ListenTarget::Unix { options, .. } => (options, true),
    };
    match &options.tls {
        None => Ok(None),
        Some(_) if unix => Err(NodeError::new(
            "ERR_TLS_UNSUPPORTED_TRANSPORT",
            "TLS over a Unix socket is not supported",
        )),
        Some(options) => tls::server_tls(options).map(Some),
    }
}

async fn bind(target: &ListenTarget, permit: &Permit) -> Result<Bound, NodeError> {
    match target {
        ListenTarget::Tcp {
            host,
            port,
            options,
        } => bind_tcp(host, *port, options, permit).await,
        ListenTarget::Unix { path, options } => {
            // `ipv6Only`/`exclusive`/`backlog` have no meaning on a Unix socket; Node ignores them.
            let _ = options;
            // With no policy the path is used as given (Node's behaviour and the reported
            // `path`); under enforcement it is resolved and checked first.
            let resolved = if permit.enforced() {
                let resolved = perm::resolve_create(path, "listen")?;
                permit.check(&Request::Unix {
                    capability: Capability::NetListen,
                    resolved: &resolved,
                })?;
                resolved
            } else {
                path.clone()
            };
            let listener = std::os::unix::net::UnixListener::bind(&resolved)
                .map_err(|error| from_io_at(&error, "listen", &resolved))?;
            listener
                .set_nonblocking(true)
                .map_err(|error| from_io(&error, "listen"))?;
            let listener =
                UnixListener::from_std(listener).map_err(|error| from_io(&error, "listen"))?;
            Ok(Bound::Unix {
                listener,
                path: resolved,
            })
        }
    }
}

async fn bind_tcp(
    host: &str,
    port: u16,
    options: &ListenOptions,
    permit: &Permit,
) -> Result<Bound, NodeError> {
    if permit.enforced() && !host.is_empty() && host.parse::<std::net::IpAddr>().is_err() {
        permit.check(&Request::Host { host })?;
    }
    let candidates = listen_addresses(host, port, options).await?;
    let host_name = if host.is_empty() { None } else { Some(host) };
    let candidates =
        perm::allowed_endpoints(permit, Capability::NetListen, host_name, port, candidates)?;
    let mut last_error = None;
    for address in candidates {
        match bind_tcp_socket(address, options) {
            Ok(listener) => {
                let local = listener.local_addr().unwrap_or(address);
                let listener =
                    TcpListener::from_std(listener).map_err(|error| from_io(&error, "listen"))?;
                return Ok(Bound::Tcp { listener, local });
            }
            Err(error) => {
                let errno = error.raw_os_error().unwrap_or(libc::EIO);
                last_error = Some(from_io_detail(&error, "listen", &address.to_string()));
                // Node retries the unspecified address as IPv4 only when IPv6 is unavailable on
                // the platform; every other failure is the server's `error` event.
                let ipv6_unavailable = matches!(
                    errno,
                    libc::EADDRNOTAVAIL | libc::EAFNOSUPPORT | libc::EPROTONOSUPPORT
                );
                if !ipv6_unavailable {
                    break;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| not_found(host)))
}

async fn listen_addresses(
    host: &str,
    port: u16,
    options: &ListenOptions,
) -> Result<Vec<SocketAddr>, NodeError> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(address, port)]);
    }
    if host.is_empty() {
        let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port);
        if options.ipv6_only {
            return Ok(vec![v6]);
        }
        // Node binds `::` dual-stack, falling back to `0.0.0.0` when the platform refuses IPv6.
        return Ok(vec![
            v6,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
        ]);
    }
    let resolved = lookup_host((host, port))
        .await
        .map_err(|error| resolve_error(host, &error))?;
    let addresses: Vec<SocketAddr> = resolved.collect();
    if addresses.is_empty() {
        Err(not_found(host))
    } else {
        Ok(addresses)
    }
}

fn bind_tcp_socket(
    address: SocketAddr,
    options: &ListenOptions,
) -> io::Result<std::net::TcpListener> {
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    // libuv sets SO_REUSEADDR for a normal listener: it makes a rebind succeed while the previous
    // socket is still in TIME_WAIT. `exclusive` is the opposite request ("do not share the port
    // with a previous listener"), which on Unix is exactly what turning SO_REUSEADDR off does.
    // SO_REUSEPORT is deliberately not used: Node rejects a second listener on a live port with
    // EADDRINUSE, and cluster's fd sharing is not something a socket option can reproduce.
    socket.set_reuse_address(!options.exclusive)?;
    if address.is_ipv6() {
        socket.set_only_v6(options.ipv6_only)?;
    }
    socket.bind(&SockAddr::from(address))?;
    socket.listen(options.backlog.max(1))?;
    socket.set_nonblocking(true)?;
    Ok(std::net::TcpListener::from(socket))
}
