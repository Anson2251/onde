//! The byte transport under a connection handle.
//!
//! Today there are two: TCP and Unix. Both are `tokio` streams, both are split into a read half
//! and a write half so the connection task can wait on a read and a write at the same time (a
//! single task, never a task per direction: the event order in [ADR-0006] is per handle).
//!
//! **TLS is WP6's seam.** It lands here as a third variant (`Transport::Tls(..)`) plus a matching
//! arm in [`Transport::into_halves`], a `Reader`/`Writer` pair built with `tokio::io::split`, and
//! nothing else in `connection.rs` changes. No rustls type is named in this file on purpose: the
//! connection task only ever sees `Reader`/`Writer`.
//!
//! [ADR-0006]: ../../../docs/adr/0006-handles-and-events.md

use std::io;
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf as TcpReadHalf, OwnedWriteHalf as TcpWriteHalf};
use tokio::net::unix::{OwnedReadHalf as UnixReadHalf, OwnedWriteHalf as UnixWriteHalf};
use tokio::net::{TcpStream, UnixStream};

/// One connected transport, immediately before it is split for its task.
pub(crate) enum Transport {
    Tcp(TcpStream),
    Unix(UnixStream),
    // WP6 adds `Tls(Box<tokio_rustls::...>)` here; `into_halves` is the only other change.
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
        }
    }
}

/// The read direction.
pub(crate) enum Reader {
    Tcp(TcpReadHalf),
    Unix(UnixReadHalf),
}

impl Reader {
    /// One read. Cancel safe: if the future is dropped before it completes, no bytes are consumed,
    /// which is what lets `ReadStop` drop an in-flight pull without losing data.
    pub(crate) async fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Reader::Tcp(half) => half.read(buffer).await,
            Reader::Unix(half) => half.read(buffer).await,
        }
    }
}

/// The write direction, plus the live socket options Node lets JS change after connect.
pub(crate) enum Writer {
    Tcp(TcpWriteHalf),
    Unix(UnixWriteHalf),
}

impl Writer {
    /// One write. Cancel safe in the same sense as [`Reader::read`].
    pub(crate) async fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Writer::Tcp(half) => half.write(bytes).await,
            Writer::Unix(half) => half.write(bytes).await,
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
        }
    }

    pub(crate) fn set_no_delay(&self, no_delay: bool) -> io::Result<()> {
        match self {
            Writer::Tcp(half) => half.as_ref().set_nodelay(no_delay),
            // TCP options do not exist on a Unix socket; Node's calls are no-ops there too.
            Writer::Unix(_) => Ok(()),
        }
    }

    /// `socket.setKeepAlive(enable, initialDelay)`. `delay_ms == 0` leaves the OS default timings.
    pub(crate) fn set_keep_alive(&self, enable: bool, delay_ms: u32) -> io::Result<()> {
        match self {
            Writer::Tcp(half) => set_tcp_keep_alive(half.as_ref(), enable, delay_ms),
            Writer::Unix(_) => Ok(()),
        }
    }
}

/// `SO_KEEPALIVE` plus `TCP_KEEPIDLE`/`TCP_KEEPINTVL`, which tokio does not expose on a live
/// stream. `delay_ms == 0` enables keep-alive with the OS's default probe timing.
pub(crate) fn set_tcp_keep_alive(
    socket: &impl std::os::fd::AsFd,
    enable: bool,
    delay_ms: u32,
) -> io::Result<()> {
    let socket = SockRef::from(socket);
    socket.set_keepalive(enable)?;
    if enable && delay_ms > 0 {
        let delay = Duration::from_millis(u64::from(delay_ms));
        socket.set_tcp_keepalive(&TcpKeepalive::new().with_time(delay).with_interval(delay))?;
    }
    Ok(())
}
