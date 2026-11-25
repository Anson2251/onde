//! The byte transport under a connection handle.
//!
//! Three kinds: TCP, Unix and TLS. All are `tokio` streams, all are split into a read half and a
//! write half so the connection task can wait on a read and a write at the same time (a single
//! task, never a task per direction: the event order in [ADR-0006] is per handle).
//!
//! TLS is a **wrapper**, not a third protocol (ADR-0006 §2.9): the handshake has already finished
//! by the time a `Transport::Tls` exists (the connect task performs it for a client, the accepted
//! connection's child task for a server), so the halves below are ordinary `AsyncRead`/
//! `AsyncWrite` ends. No rustls type is named outside [`TlsKind`], and `connection.rs` only ever
//! sees `Reader`/`Writer`.
//!
//! [ADR-0006]: ../../../docs/adr/0006-handles-and-events.md

use std::io;
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf as TcpReadHalf, OwnedWriteHalf as TcpWriteHalf};
use tokio::net::unix::{OwnedReadHalf as UnixReadHalf, OwnedWriteHalf as UnixWriteHalf};
use tokio::net::{TcpStream, UnixStream};

// rustls-only: the TLS variants below are the only things that name these types.
#[cfg(feature = "tls")]
use std::os::fd::{AsRawFd, BorrowedFd, RawFd};
#[cfg(feature = "tls")]
use std::pin::Pin;
#[cfg(feature = "tls")]
use std::task::{Context, Poll};
#[cfg(feature = "tls")]
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
#[cfg(feature = "tls")]
use tokio_rustls::{client as tls_client, server as tls_server};

/// One connected transport, immediately before it is split for its task.
pub(crate) enum Transport {
    Tcp(TcpStream),
    Unix(UnixStream),
    /// Boxed: a rustls session is ~1.2 KiB against a plain socket's ~40 bytes, and the enum lives
    /// in every connection task (clippy's `large_enum_variant`).
    #[cfg(feature = "tls")]
    Tls(Box<TlsKind>),
}

impl Transport {
    /// Split into the two directions a handle's task drives concurrently.
    pub(crate) fn into_halves(self) -> (Reader, Writer) {
        match self {
            Transport::Tcp(stream) => {
                let (reader, writer) = stream.into_split();
                (Reader::Tcp(reader), Writer::Tcp(writer))
            }
            Transport::Unix(stream) => {
                let (reader, writer) = stream.into_split();
                (Reader::Unix(reader), Writer::Unix(writer))
            }
            #[cfg(feature = "tls")]
            Transport::Tls(stream) => {
                // `tokio::io::split` rather than `into_split`: a TLS stream is one object with two
                // directions, and the halves only borrow it for the duration of one poll.
                let fd = stream.tcp().as_raw_fd();
                let (reader, writer) = tokio::io::split(*stream);
                (Reader::Tls(reader), Writer::Tls { half: writer, fd })
            }
        }
    }
}

/// A finished TLS session over a TCP socket, client or server role.
///
/// One enum rather than two `Transport` variants because the connection task must not care which
/// side of the handshake it is on; the only difference is a type parameter inside tokio-rustls.
#[cfg(feature = "tls")]
pub(crate) enum TlsKind {
    Client(tls_client::TlsStream<TcpStream>),
    Server(tls_server::TlsStream<TcpStream>),
}

#[cfg(feature = "tls")]
impl TlsKind {
    /// The TCP socket under the session, for the live socket options (`setNoDelay`,
    /// `setKeepAlive`) that belong to the OS socket, not to the TLS layer.
    fn tcp(&self) -> &TcpStream {
        match self {
            TlsKind::Client(stream) => stream.get_ref().0,
            TlsKind::Server(stream) => stream.get_ref().0,
        }
    }
}

#[cfg(feature = "tls")]
impl AsyncRead for TlsKind {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TlsKind::Client(stream) => Pin::new(stream).poll_read(cx, buffer),
            TlsKind::Server(stream) => Pin::new(stream).poll_read(cx, buffer),
        }
    }
}

#[cfg(feature = "tls")]
impl AsyncWrite for TlsKind {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            TlsKind::Client(stream) => Pin::new(stream).poll_write(cx, bytes),
            TlsKind::Server(stream) => Pin::new(stream).poll_write(cx, bytes),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TlsKind::Client(stream) => Pin::new(stream).poll_flush(cx),
            TlsKind::Server(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    /// `close_notify` (plus the TCP FIN): the TLS spelling of `shutdown(SHUT_WR)`.
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TlsKind::Client(stream) => Pin::new(stream).poll_shutdown(cx),
            TlsKind::Server(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

/// The read direction.
pub(crate) enum Reader {
    Tcp(TcpReadHalf),
    Unix(UnixReadHalf),
    #[cfg(feature = "tls")]
    Tls(ReadHalf<TlsKind>),
}

impl Reader {
    /// One read. Cancel safe: if the future is dropped before it completes, no bytes are consumed,
    /// which is what lets `ReadStop` drop an in-flight pull without losing data.
    pub(crate) async fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Reader::Tcp(half) => half.read(buffer).await,
            Reader::Unix(half) => half.read(buffer).await,
            #[cfg(feature = "tls")]
            Reader::Tls(half) => half.read(buffer).await,
        }
    }
}

/// The write direction, plus the live socket options Node lets JS change after connect.
pub(crate) enum Writer {
    Tcp(TcpWriteHalf),
    Unix(UnixWriteHalf),
    /// The write half plus the underlying socket's fd: `setNoDelay`/`setKeepAlive` are OS socket
    /// options, and `tokio::io::WriteHalf` does not hand back the wrapped stream. The fd stays
    /// valid because the `TlsKind` holding it lives in the same `Writer`.
    #[cfg(feature = "tls")]
    Tls {
        half: WriteHalf<TlsKind>,
        fd: RawFd,
    },
}

impl Writer {
    /// One write. Cancel safe in the same sense as [`Reader::read`].
    pub(crate) async fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Writer::Tcp(half) => half.write(bytes).await,
            Writer::Unix(half) => half.write(bytes).await,
            #[cfg(feature = "tls")]
            Writer::Tls { half, .. } => half.write(bytes).await,
        }
    }

    /// Write the whole buffer, for the short canned responses the task authors itself.
    pub(crate) async fn write_all(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let written = self.write(bytes).await?;
            if written == 0 {
                return Err(io::Error::from_raw_os_error(libc::EPIPE));
            }
            bytes = &bytes[written..];
        }
        Ok(())
    }

    /// `shutdown(SHUT_WR)`: the FIN half of `socket.end()`. The read direction stays open.
    pub(crate) async fn shutdown(&mut self) -> io::Result<()> {
        match self {
            Writer::Tcp(half) => half.shutdown().await,
            Writer::Unix(half) => half.shutdown().await,
            #[cfg(feature = "tls")]
            Writer::Tls { half, .. } => half.shutdown().await,
        }
    }

    pub(crate) fn set_no_delay(&self, no_delay: bool) -> io::Result<()> {
        match self {
            Writer::Tcp(half) => half.as_ref().set_nodelay(no_delay),
            // The TLS layer sits on a TCP socket: the option belongs to the socket underneath.
            #[cfg(feature = "tls")]
            Writer::Tls { fd, .. } => with_socket(*fd, |socket| socket.set_tcp_nodelay(no_delay)),
            // TCP options do not exist on a Unix socket; Node's calls are no-ops there too.
            Writer::Unix(_) => Ok(()),
        }
    }

    /// `socket.setKeepAlive(enable, initialDelay)`. `delay_ms == 0` leaves the OS default timings.
    pub(crate) fn set_keep_alive(&self, enable: bool, delay_ms: u32) -> io::Result<()> {
        match self {
            Writer::Tcp(half) => set_tcp_keep_alive(half.as_ref(), enable, delay_ms),
            #[cfg(feature = "tls")]
            Writer::Tls { fd, .. } => {
                with_socket(*fd, |socket| keep_alive(&socket, enable, delay_ms))
            }
            Writer::Unix(_) => Ok(()),
        }
    }

    /// Arm the close path for a TCP reset rather than a FIN: `SO_LINGER` on with a zero timeout,
    /// which is what Node's `socket.resetAndDestroy()` sets before closing. The socket then sends
    /// RST, so the peer observes `ECONNRESET` instead of a clean EOF.
    ///
    /// A Unix socket has no TCP reset; returning `Ok` keeps the call shape uniform (the close
    /// itself still happens, just as a local teardown).
    pub(crate) fn set_reset_on_close(&self) -> io::Result<()> {
        match self {
            Writer::Tcp(half) => SockRef::from(half.as_ref()).set_linger(Some(Duration::ZERO)),
            #[cfg(feature = "tls")]
            Writer::Tls { fd, .. } => {
                with_socket(*fd, |socket| socket.set_linger(Some(Duration::ZERO)))
            }
            Writer::Unix(_) => Ok(()),
        }
    }

    /// Read and clear the socket's pending error (`SO_ERROR`).
    ///
    /// On some kernels a read after a peer RST completes as a zero-length read rather than
    /// `ECONNRESET`; this is the second chance to tell a reset from a clean FIN before the
    /// transport reports EOF. `Ok(None)` means no error was pending.
    pub(crate) fn take_error(&self) -> io::Result<Option<io::Error>> {
        match self {
            Writer::Tcp(half) => half.as_ref().take_error(),
            Writer::Unix(half) => half.as_ref().take_error(),
            #[cfg(feature = "tls")]
            Writer::Tls { fd, .. } => with_socket(*fd, |socket| socket.take_error()),
        }
    }
}

/// Run one `setsockopt` against a borrowed fd.
///
/// SAFETY: the caller passes an fd it owns (the `TlsKind` in the same `Writer` guarantees the
/// lifetime); `BorrowedFd` does not close it on drop.
#[cfg(feature = "tls")]
fn with_socket<R>(
    fd: RawFd,
    operation: impl FnOnce(SockRef<'_>) -> io::Result<R>,
) -> io::Result<R> {
    let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
    operation(SockRef::from(&borrowed))
}

/// `SO_KEEPALIVE` plus `TCP_KEEPIDLE`/`TCP_KEEPINTVL`, which tokio does not expose on a live
/// stream. `delay_ms == 0` enables keep-alive with the OS's default probe timing.
pub(crate) fn set_tcp_keep_alive(
    socket: &impl std::os::fd::AsFd,
    enable: bool,
    delay_ms: u32,
) -> io::Result<()> {
    keep_alive(&SockRef::from(socket), enable, delay_ms)
}

/// The `SockRef` half of [`set_tcp_keep_alive`], shared with the TLS writer (which only has the
/// underlying socket's fd).
fn keep_alive(socket: &SockRef<'_>, enable: bool, delay_ms: u32) -> io::Result<()> {
    socket.set_keepalive(enable)?;
    if enable && delay_ms > 0 {
        let delay = Duration::from_millis(u64::from(delay_ms));
        socket.set_tcp_keepalive(&TcpKeepalive::new().with_time(delay).with_interval(delay))?;
    }
    Ok(())
}
