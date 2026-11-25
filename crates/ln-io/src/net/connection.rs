//! One connection handle: the task that owns a socket from `connect`/`accept` to `closed`.
//!
//! The task is a single state machine over three event sources, all of them `await` points:
//! commands from the isolate thread, reads from the peer, writes to the peer. It never blocks and
//! never reads ahead: in raw mode a socket is pulled only by a `Read` command (ADR-0006 §2.3), and
//! in parsed mode the codec's message boundaries stop the pull between messages.
//!
//! Two orderings are load-bearing and are documented where they are enforced:
//!
//! - **H2/H4**: `Closed` is emitted exactly once, always last, and only after the socket has been
//!   dropped. Every exit path sets [`Connection::finished`]; [`Connection::close`] is the single
//!   place that emits the event.
//! - **At most one read in flight**: a `Read` with a read already outstanding is ignored, and
//!   `ReadStop` clears the outstanding request. Dropping the read future is cancel safe, so no
//!   byte is lost: whatever the kernel had not handed over stays in its buffer.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ln_error::NodeError;
use ln_http::{Conn, Event as HttpEvent, ProtocolError, Role};
use tokio::net::{lookup_host, TcpSocket, TcpStream, UnixStream};
use tokio::sync::mpsc::UnboundedReceiver;

use super::error::{from_io, from_io_at, from_io_detail};
use super::registry::Shared;
// The resolver errors moved with `dns.lookup`, which is an op and no longer lives under `net`.
use crate::dns::{not_found, resolve_error};
// TLS is rustls-only: without the feature there is no handshake to perform or name.
#[cfg(feature = "tls")]
use super::tls::{self, ServerTls};
use super::transport::{set_tcp_keep_alive, Reader, Transport, Writer};
use super::{
    family_matches, Addr, Command, ConnectOptions, ConnectTarget, Event, HandleId, IpFamily,
    MAX_CHUNK,
};

/// How much a parsed-mode read pulls at a time. Bounded (H7) and small enough that a quiet
/// connection costs little; the codec's own head limit is tighter than this.
const HTTP_READ_CHUNK: usize = 16 * 1024;

/// The scratch buffer every connection starts with, before it has proved that anything is being
/// delivered. A half-open peer never fills it, so it never grows (m7-plan §6.1): at 2,000 idle
/// connections this is the difference between 8 MiB and 128 MiB of resident buffers.
const INITIAL_READ_CHUNK: usize = 1024;

/// Consecutive full reads after which the buffer may take the size the consumer asked for. Two is
/// enough to tell a stream being consumed from a peer that sent a partial head and went quiet, and
/// it costs a busy socket two small reads at connection start.
const GROW_AFTER_FULL_READS: u8 = 2;

/// Raw or parsed mode. Parsed mode is `httpAttach`; `detach` returns to raw (H6).
enum Mode {
    Raw,
    // Boxed: a `Conn` carries the codec's buffer, and the enum lives inside every connection task.
    Http { conn: Box<Conn>, role: Role },
}

pub(crate) struct Connection {
    shared: Arc<Shared>,
    id: HandleId,
    reader: Option<Reader>,
    writer: Option<Writer>,
    mode: Mode,
    /// A `Read` command waiting for the socket, at most one (ADR-0006 §2.4).
    read_request: Option<u32>,
    /// The scratch buffer for one read, sized by the outstanding request (bounded by `MAX_CHUNK`).
    read_buf: Vec<u8>,
    /// Reads that filled `read_buf`, which is how the buffer decides to grow (H7). Monotonic: a
    /// paced stream returns partial reads by design, so resetting on one would shrink a grown buffer
    /// back to `INITIAL_READ_CHUNK` and regrow it on every burst (measured: a 1 MiB stream at
    /// 8 KiB/5 ms produced 384 events instead of ~16 at the requested chunk).
    read_chunks: u8,
    write_queue: std::collections::VecDeque<Vec<u8>>,
    write_offset: usize,
    /// A `Write` queued bytes that have not produced a `Drain` yet.
    drain_pending: bool,
    /// `End` was commanded: flush, then `shutdown(SHUT_WR)`.
    ending: bool,
    /// The write direction has been shut (`SHUT_WR` sent, or a local close is in progress).
    write_shutdown: bool,
    /// Close as soon as the queued writes are out (a server answering with `Connection: close`).
    close_when_flushed: bool,
    peer_eof: bool,
    had_error: bool,
    finished: bool,
    /// Parsed mode only: a complete message was delivered; wait for JS before pulling again.
    http_idle: bool,
    /// Parsed mode only: JS paused the body stream (`IncomingMessage.pause()`), so stop pulling.
    /// Bounds the parked events for a slow consumer (H7); `Read` resumes.
    http_paused: bool,
    /// Client role: this request asked to close, so close once its response completes.
    close_after_response: bool,
    /// Server role: a request was delivered and JS still owes a response, so a peer FIN must not
    /// close the socket before that response is written.
    http_awaiting_outbound: bool,
    /// Bytes read past the end of the last parsed message. Parsed mode never hands them to the
    /// codec twice (H6): they wait here, bounded by one read, until the next message starts (fed
    /// to the codec) or until `detach` (handed to JS as `data`).
    http_surplus: Vec<u8>,
}

impl Connection {
    pub(crate) fn new(shared: Arc<Shared>, id: HandleId, transport: Transport) -> Self {
        let (reader, writer) = transport.into_halves();
        Connection {
            shared,
            id,
            reader: Some(reader),
            writer: Some(writer),
            mode: Mode::Raw,
            read_request: None,
            read_buf: Vec::new(),
            read_chunks: 0,
            write_queue: std::collections::VecDeque::new(),
            write_offset: 0,
            drain_pending: false,
            ending: false,
            write_shutdown: false,
            close_when_flushed: false,
            peer_eof: false,
            had_error: false,
            finished: false,
            http_idle: false,
            http_paused: false,
            close_after_response: false,
            http_awaiting_outbound: false,
            http_surplus: Vec::new(),
        }
    }

    /// The connect half of a handle: resolve, connect, apply socket options, perform the TLS
    /// handshake if the caller asked for one, then become a task.
    ///
    /// A failed connect (including a failed handshake) emits `error` and then
    /// `closed { hadError: true }`, never panics and never leaves the id registered.
    pub(crate) async fn connect(
        shared: Arc<Shared>,
        id: HandleId,
        target: ConnectTarget,
        commands: UnboundedReceiver<Command>,
    ) {
        match establish(&target).await {
            Ok(established) => {
                shared.emit(
                    id,
                    Event::Connected {
                        local: established.local,
                        remote: established.remote,
                        alpn: established.alpn,
                        protocol: established.protocol,
                    },
                );
                Connection::new(shared, id, established.transport)
                    .run(commands)
                    .await;
            }
            Err(error) => {
                shared.emit(id, Event::Error { error });
                shared.emit(id, Event::Closed { had_error: true });
                shared.unregister(id);
            }
        }
    }

    /// The TLS half of a server accept: handshake in **this** connection's child task (never the
    /// accept loop, so a slow or hostile handshake cannot stall it), then the ordinary run loop.
    ///
    /// The listener has already minted and registered `id`, so commands JS issues against the
    /// handle queue up while the handshake runs. `connection` is emitted only once the handshake
    /// has succeeded: a peer that never completes one never becomes a socket JS can see, and a
    /// failed handshake is reported on the (invisible) child handle as `error` + `closed`, never as
    /// a `connection` event.
    #[cfg(feature = "tls")]
    pub(crate) async fn accept_tls(
        shared: Arc<Shared>,
        id: HandleId,
        server: HandleId,
        stream: TcpStream,
        config: ServerTls,
        remote: Addr,
        commands: UnboundedReceiver<Command>,
    ) {
        match tls::accept(stream, config).await {
            Ok(accepted) => {
                // The server may have been destroyed while the handshake was in flight; a socket
                // nobody owns must not start a run loop that outlives the process's interest.
                if !shared.contains(server) {
                    shared.unregister(id);
                    return;
                }
                shared.emit(
                    server,
                    Event::Connection {
                        handle: id,
                        remote,
                        alpn: accepted.alpn,
                        protocol: accepted.protocol,
                    },
                );
                Connection::new(shared, id, accepted.transport)
                    .run(commands)
                    .await;
            }
            Err(error) => fail_before_connected(&shared, id, error),
        }
    }

    /// Drive the handle until it closes. `Closed` is the last thing that leaves this function.
    pub(crate) async fn run(mut self, mut commands: UnboundedReceiver<Command>) {
        // The two futures a single `select!` waits on. Building them from disjoint fields keeps
        // the borrow checker happy and, more importantly, makes "one read in flight" structural.
        enum Step {
            Command(Option<Command>),
            Read(io::Result<usize>),
            Write(io::Result<usize>),
        }

        loop {
            if self.finished {
                break;
            }
            // A new parsed-mode message started and bytes of it were already read: give them to
            // the codec before reading more (H6: never parsed twice, never lost).
            self.feed_http_surplus().await;
            if self.finished {
                break;
            }
            // `End` with an empty queue, or the queue emptied by the last write: send FIN.
            self.maybe_shutdown_write().await;
            if self.finished {
                break;
            }

            let want_read = self.wants_read();
            let want_write = !self.write_queue.is_empty();

            if !want_read && !want_write {
                match commands.recv().await {
                    Some(command) => self.on_command(command),
                    // The service dropped the handle's channel (shutdown): stop quietly (H4).
                    None => self.finished = true,
                }
                continue;
            }
            if want_read {
                self.size_read_buffer();
            }

            let step = {
                let Some(reader) = self.reader.as_mut() else {
                    self.finished = true;
                    continue;
                };
                let Some(writer) = self.writer.as_mut() else {
                    self.finished = true;
                    continue;
                };
                let read_len = self.read_buf.len();
                let write_offset = self.write_offset;
                let pending = match self.write_queue.front() {
                    Some(chunk) if write_offset <= chunk.len() => &chunk[write_offset..],
                    _ => &[][..],
                };
                let read_buf = &mut self.read_buf[..read_len];
                tokio::select! {
                    command = commands.recv() => Step::Command(command),
                    read = reader.read(read_buf), if want_read => Step::Read(read),
                    written = writer.write(pending), if want_write => Step::Write(written),
                }
            };

            match step {
                Step::Command(Some(command)) => self.on_command(command),
                Step::Command(None) => self.finished = true,
                Step::Read(Ok(0)) => self.on_eof().await,
                Step::Read(Ok(count)) => self.on_read(count).await,
                Step::Read(Err(error)) => self.on_io_error(&error, "read"),
                Step::Write(Ok(0)) => {
                    // A successful zero-byte write to a stream means the peer is gone.
                    let error = io::Error::from_raw_os_error(libc::EPIPE);
                    self.on_io_error(&error, "write");
                }
                Step::Write(Ok(count)) => self.on_written(count),
                Step::Write(Err(error)) => self.on_io_error(&error, "write"),
            }
        }

        self.close();
    }

    /// Emit `closed` and leave the id table. The socket is dropped first, so a `closed` handler
    /// sees the fd already released, exactly like Node's `'close'`.
    fn close(&mut self) {
        self.reader = None;
        self.writer = None;
        self.emit(Event::Closed {
            had_error: self.had_error,
        });
        self.shared.unregister(self.id);
    }

    fn emit(&self, event: Event) {
        self.shared.emit(self.id, event);
    }

    fn queue_bytes(&mut self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        self.write_queue.push_back(bytes);
        self.drain_pending = true;
    }

    fn wants_read(&self) -> bool {
        if self.finished || self.peer_eof {
            return false;
        }
        match &self.mode {
            Mode::Raw => self.read_request.is_some(),
            // In a message: keep parsing. Between messages: keep exactly one read in flight so a
            // peer FIN is noticed (and a pipelined message is captured, not parsed early) — but
            // stop pulling while surplus bytes are already buffered.
            Mode::Http { .. } => {
                !self.http_paused && (!self.http_idle || self.http_surplus.is_empty())
            }
        }
    }

    /// Size the read buffer to the outstanding request, never more than `MAX_CHUNK` (H7).
    ///
    /// Until the socket has delivered `GROW_AFTER_FULL_READS` full buffers it is clamped to
    /// `INITIAL_READ_CHUNK`, because the request says what a *consumer* could take, not what the
    /// peer will send: an HTTP parser asks for 16 KiB and a flowing `net` socket for 64 KiB on
    /// every connection, including the ones that will never send a complete head. The clamp is
    /// one-way: a socket that has proved it delivers keeps the larger buffer for its lifetime.
    fn size_read_buffer(&mut self) {
        let asked = match &self.mode {
            Mode::Raw => self.read_request.unwrap_or(1) as usize,
            Mode::Http { .. } => HTTP_READ_CHUNK,
        };
        let wanted = if self.read_chunks < GROW_AFTER_FULL_READS {
            asked.min(INITIAL_READ_CHUNK)
        } else {
            asked
        }
        .clamp(1, MAX_CHUNK as usize);
        if self.read_buf.len() != wanted {
            self.read_buf.resize(wanted, 0);
        }
    }

    fn on_command(&mut self, command: Command) {
        match command {
            // A handle is one kind. A second `listen`/`connect` for a live id is a JS bug, not a
            // reason to replace a running task; H5's rule (ignore, never panic) applies here too.
            Command::Listen(_) | Command::Connect(_) => {}
            Command::Read { max } => self.on_read_request(max),
            Command::ReadStop => self.on_read_stop(),
            Command::Write { data } => {
                // A write after `end()` is a JS-side protocol error (`write after end`), reported
                // by the JS writable; the task must not panic or resurrect the write side.
                if !self.write_shutdown {
                    self.queue_bytes(data);
                }
            }
            Command::End => self.ending = true,
            Command::Destroy => self.finished = true,
            Command::Reset => {
                // Node's `resetAndDestroy()`: arm `SO_LINGER` with a zero timeout so dropping the
                // socket sends RST (the peer sees ECONNRESET, not a clean EOF), then close now.
                // Queued writes are discarded, as they are in Node's immediate destroy.
                if let Some(writer) = self.writer.as_ref() {
                    if let Err(error) = writer.set_reset_on_close() {
                        self.report(from_io(&error, "setsockopt"));
                    }
                }
                self.write_queue.clear();
                self.write_offset = 0;
                self.finished = true;
            }
            Command::Detach => self.detach(),
            Command::HttpAttach { role, limits } => {
                self.mode = Mode::Http {
                    conn: Box::new(Conn::new(role, limits)),
                    role,
                };
                // A fresh cycle on the same socket (an `Agent` reuse) starts by reading.
                self.http_idle = false;
                self.http_paused = false;
                self.close_after_response = false;
                self.http_awaiting_outbound = false;
            }
            Command::HttpHead { bytes } => self.on_http_head(bytes),
            Command::HttpBody { bytes } => self.on_http_body(bytes),
            Command::HttpEnd { keep_alive } => self.on_http_end(keep_alive),
            Command::HttpContinue => self.write_continue(),
            Command::SetNoDelay(no_delay) => self.set_no_delay(no_delay),
            Command::SetKeepAlive {
                enable,
                initial_delay_ms,
            } => self.set_keep_alive(enable, initial_delay_ms),
            // H3: loop refcounts are the handle table's, owned by `ln-runtime` (WP3). The task has
            // nothing to count, so both commands are accepted and deliberately ignored.
            Command::Ref | Command::Unref => {}
        }
    }

    fn on_read_request(&mut self, max: u32) {
        // In parsed mode `read` resumes a paused body stream; the codec decides the block size
        // (`BODY_BLOCK_BYTES`), so `max` does not apply (m4-plan §2.2).
        if matches!(self.mode, Mode::Http { .. }) {
            if !self.peer_eof {
                self.http_paused = false;
            }
            return;
        }
        if !matches!(self.mode, Mode::Raw) || self.peer_eof {
            return;
        }
        // `read(0)` pulls nothing (Node's `read(0)` returns `null`), and a second `Read` while one
        // is in flight is ignored rather than queued (m4-plan §2.2).
        if max == 0 || self.read_request.is_some() {
            return;
        }
        self.read_request = Some(max.min(MAX_CHUNK));
    }

    /// Stop pulling. In parsed mode this is the body-stream backpressure pause; in raw mode it
    /// clears the outstanding read request.
    fn on_read_stop(&mut self) {
        if matches!(self.mode, Mode::Http { .. }) {
            self.http_paused = true;
            return;
        }
        self.read_request = None;
    }

    /// Interim `100 Continue`: a complete fixed message, so it bypasses the outbound framing.
    fn write_continue(&mut self) {
        let mut out = Vec::new();
        match &mut self.mode {
            Mode::Http { conn, .. } => conn.write_continue(&mut out),
            Mode::Raw => return,
        }
        self.queue_bytes(out);
    }

    async fn on_read(&mut self, count: usize) {
        // A read that filled the buffer is the signal that this peer is consuming, and is what lets
        // the buffer grow past `INITIAL_READ_CHUNK`. It never shrinks again: a partial read is the
        // normal case for a consumer slower than the requested chunk, not evidence of an idle peer,
        // and shrinking would regrow on the next burst.
        if count == self.read_buf.len() {
            self.read_chunks = self.read_chunks.saturating_add(1);
        }
        // The parsed path may have to write a canned status before closing, so this is async.
        if matches!(self.mode, Mode::Http { .. }) {
            if self.http_idle {
                // Between messages: keep the bytes, do not parse them yet (H6). One read is the
                // bound, so this cannot grow without limit (H7).
                if self.http_surplus.is_empty() {
                    self.http_surplus.extend_from_slice(&self.read_buf[..count]);
                }
                return;
            }
            self.on_http_bytes(count).await;
            return;
        }
        self.read_request = None;
        let bytes = self.read_buf[..count].to_vec();
        self.emit(Event::Data { bytes });
    }

    async fn on_eof(&mut self) {
        if self.peer_eof {
            return;
        }
        self.peer_eof = true;
        self.read_request = None;

        // Some kernels report a peer RST as a zero-length read rather than `ECONNRESET`. `SO_ERROR`
        // is the race-free second chance to tell the reset from a clean FIN: a pending socket error
        // wins over EOF, so the peer sees `'error'` + `'close'` like Node instead of `'end'`.
        let pending = self
            .writer
            .as_ref()
            .and_then(|writer| writer.take_error().ok().flatten())
            .filter(|error| error.raw_os_error() != Some(0));
        if let Some(error) = pending {
            self.fail(from_io(&error, "read"));
            return;
        }

        if matches!(self.mode, Mode::Http { .. }) {
            // The codec has to see the end of the byte stream: it flushes an EOF-delimited body
            // (a response with neither `Content-Length` nor chunked framing) and rejects a
            // truncated head/length/chunked message with exactly one `ERR_HTTP_PARSE`.
            let mut failure = None;
            if let Mode::Http { conn, .. } = &mut self.mode {
                if let Err(error) = conn.end_of_stream() {
                    failure = Some(error);
                }
            }
            self.drain_http_events();
            if let Some(error) = failure {
                self.on_protocol_error(error).await;
                return;
            }
            // A peer FIN means the connection cannot be reused. Close now unless JS still owes a
            // response: a client may half-close after sending its request and still read it.
            //
            // Parsed mode reports the read side through the codec (`messageEnd`, or `clientError`
            // for a truncated message) and deliberately does not emit the raw `end` event, so JS
            // sees exactly one end-of-message signal; raw mode emits `end` as usual.
            if !self.finished && !self.http_awaiting_outbound {
                self.finished = true;
            }
            return;
        }

        // Raw mode: `end` is the read side reaching EOF; the write side stays open (half-close).
        self.emit(Event::End);
        if self.write_shutdown {
            // Both directions are done: the handle is closed with no error.
            self.finished = true;
        }
    }

    fn on_written(&mut self, count: usize) {
        self.write_offset += count;
        let complete = self
            .write_queue
            .front()
            .is_some_and(|chunk| self.write_offset >= chunk.len());
        if !complete {
            return;
        }
        self.write_queue.pop_front();
        self.write_offset = 0;
        if self.write_queue.is_empty() && self.drain_pending {
            self.drain_pending = false;
            self.emit(Event::Drain);
        }
    }

    fn on_io_error(&mut self, error: &io::Error, syscall: &'static str) {
        // Interrupted and would-block are not connection failures; tokio retries them itself.
        if error.raw_os_error() == Some(libc::EINTR) || error.kind() == io::ErrorKind::WouldBlock {
            return;
        }
        self.fail(from_io(error, syscall));
    }

    /// Emit `error`, remember it for `closed { hadError: true }`, and stop.
    fn fail(&mut self, error: NodeError) {
        self.emit(Event::Error { error });
        self.had_error = true;
        self.finished = true;
    }

    /// Send FIN once the write queue is empty and `End` (or a close-after-flush) was commanded.
    async fn maybe_shutdown_write(&mut self) {
        if !self.ending || self.write_shutdown || !self.write_queue.is_empty() {
            return;
        }
        self.write_shutdown = true;
        let result = match self.writer.as_mut() {
            Some(writer) => writer.shutdown().await,
            None => Ok(()),
        };
        match result {
            Ok(()) => {
                if self.peer_eof || self.close_when_flushed {
                    self.finished = true;
                }
            }
            Err(error) if error.raw_os_error() == Some(libc::ENOTCONN) => {
                // The peer is already gone; the read direction will report the real end.
                if self.peer_eof || self.close_when_flushed {
                    self.finished = true;
                }
            }
            Err(error) => self.on_io_error(&error, "shutdown"),
        }
    }

    fn set_no_delay(&mut self, no_delay: bool) {
        let result = match self.writer.as_ref() {
            Some(writer) => writer.set_no_delay(no_delay),
            None => Ok(()),
        };
        if let Err(error) = result {
            self.report(from_io(&error, "setsockopt"));
        }
    }

    fn set_keep_alive(&mut self, enable: bool, initial_delay_ms: u32) {
        let result = match self.writer.as_ref() {
            Some(writer) => writer.set_keep_alive(enable, initial_delay_ms),
            None => Ok(()),
        };
        if let Err(error) = result {
            self.report(from_io(&error, "setsockopt"));
        }
    }

    /// A live-option failure is reported but does not close the socket (Node throws at the call
    /// site; a command cannot, so it becomes an `error` event and `hadError`).
    fn report(&mut self, error: NodeError) {
        self.emit(Event::Error { error });
        self.had_error = true;
    }

    // -----------------------------------------------------------------------
    // Parsed mode
    // -----------------------------------------------------------------------

    async fn on_http_bytes(&mut self, count: usize) {
        let mut failure = None;
        let mut events = Vec::new();
        {
            let Mode::Http { conn, .. } = &mut self.mode else {
                return;
            };
            if let Err(error) = conn.feed(&self.read_buf[..count]) {
                failure = Some(error);
            }
            while let Some(event) = conn.next_event() {
                events.push(event);
            }
        }
        self.after_http_events(events, failure).await;
    }

    /// Feed the bytes that were read past the previous message to the codec, once JS has started
    /// the next message. The codec may queue events (a pipelined request) or fail, exactly as if
    /// they had arrived in order.
    async fn feed_http_surplus(&mut self) {
        if self.http_surplus.is_empty()
            || self.http_idle
            || !matches!(self.mode, Mode::Http { .. })
            || self.finished
        {
            return;
        }
        let bytes = std::mem::take(&mut self.http_surplus);
        let mut events = Vec::new();
        let mut failure = None;
        {
            let Mode::Http { conn, .. } = &mut self.mode else {
                return;
            };
            if let Err(error) = conn.feed(&bytes) {
                failure = Some(error);
            }
            while let Some(event) = conn.next_event() {
                events.push(event);
            }
        }
        self.after_http_events(events, failure).await;
    }

    /// Deliver the codec's queued events in wire order, then report a parse failure if there was
    /// one. The queued events go first: a complete request parsed before a bad later byte must
    /// still reach JS (m4-plan §5; Node's `request` then `clientError` order).
    async fn after_http_events(&mut self, events: Vec<HttpEvent>, failure: Option<ProtocolError>) {
        for event in events {
            if self.finished {
                return;
            }
            self.on_http_event(event);
        }
        if let Some(error) = failure {
            self.on_protocol_error(error).await;
        }
    }

    fn drain_http_events(&mut self) {
        loop {
            let event = match &mut self.mode {
                Mode::Http { conn, .. } => conn.next_event(),
                Mode::Raw => None,
            };
            match event {
                Some(event) => self.on_http_event(event),
                None => break,
            }
        }
    }

    fn on_http_event(&mut self, event: HttpEvent) {
        let role = match &self.mode {
            Mode::Http { role, .. } => *role,
            Mode::Raw => return,
        };
        let ends_message = matches!(
            event,
            HttpEvent::MessageEnd { .. } | HttpEvent::Upgrade { .. }
        );
        let message_end = matches!(event, HttpEvent::MessageEnd { .. });
        self.emit(Event::Http(event));
        if !ends_message {
            return;
        }
        // One message at a time (ADR-0007 §2.4): stop pulling until JS drives the next step. A
        // pipelined second request would desynchronize a codec that deliberately does not pipeline.
        self.http_idle = true;
        if message_end && role == Role::Server {
            // The server owes JS a response before the socket may close.
            self.http_awaiting_outbound = true;
        }
        if role == Role::Client && self.close_after_response {
            self.finished = true;
        }
    }

    fn on_http_head(&mut self, bytes: Vec<u8>) {
        let (result, role) = match &mut self.mode {
            Mode::Http { conn, role } => (conn.encode_head(&bytes), *role),
            Mode::Raw => return,
        };
        match result {
            Ok(()) => {
                // The head is JS-authored and goes out untouched (ADR-0007 §2.5).
                self.queue_bytes(bytes);
                if role == Role::Client {
                    self.http_idle = false;
                }
            }
            Err(error) => self.fail(NodeError::from(error)),
        }
    }

    fn on_http_body(&mut self, bytes: Vec<u8>) {
        let mut framed = Vec::new();
        match &mut self.mode {
            Mode::Http { conn, .. } => conn.encode_body(&bytes, &mut framed),
            Mode::Raw => return,
        }
        self.queue_bytes(framed);
    }

    fn on_http_end(&mut self, keep_alive: bool) {
        let role = match &self.mode {
            Mode::Http { role, .. } => *role,
            Mode::Raw => return,
        };
        let mut framed = Vec::new();
        if let Mode::Http { conn, .. } = &mut self.mode {
            conn.finish(&mut framed);
        }
        self.queue_bytes(framed);

        match role {
            // The codec never closes by itself; the flag on `httpEnd` is JS's decision.
            Role::Server => {
                self.http_awaiting_outbound = false;
                if keep_alive && !self.peer_eof {
                    self.http_idle = false;
                } else {
                    // `Connection: close`, or the peer already half-closed: flush, FIN, close.
                    self.ending = true;
                    self.close_when_flushed = true;
                }
            }
            // On the client the request ending does not end the connection: the response still has
            // to arrive. A non-keep-alive request closes once that response completes.
            Role::Client => {
                if !keep_alive {
                    self.close_after_response = true;
                    if self.http_idle {
                        self.finished = true;
                    }
                }
            }
        }
    }

    /// A malformed message: answer with the canned status while the socket still accepts writes,
    /// close, then report `clientError` and `closed { hadError: true }` (m4-plan §5, divergence
    /// D42 — JS must not write a response here, the task already did).
    async fn on_protocol_error(&mut self, error: ProtocolError) {
        if let Some(writer) = self.writer.as_mut() {
            let response = canned_response(error.status);
            // Best effort: if the peer is already gone there is nobody to answer.
            let _ = writer.write_all(&response).await;
            let _ = writer.shutdown().await;
            self.write_shutdown = true;
        }
        // Report first, then drain: `clientError` is delivered when the response has been written,
        // and the drain below is about the socket, not the event (a 50 ms delay here would put the
        // event after a client that has already read its response — `test/js/lib/http.test.js`
        // depends on the order).
        self.emit(Event::ClientError {
            error: NodeError::from(error),
        });
        self.had_error = true;
        // Drain before dropping the socket: closing it with unread bytes makes the kernel send RST,
        // and the peer would lose the status we just wrote. Reachable as soon as the read buffer is
        // smaller than the offending message, which is the normal case since the per-connection
        // buffer starts at 1 KiB (m7-plan §6.1); the bound keeps a peer that keeps writing from
        // holding the task.
        self.drain_before_close(Duration::from_millis(50)).await;
        self.finished = true;
    }

    /// Read and discard what the peer already sent, for a short bounded window. See the call site
    /// for why: an unread receive buffer turns a clean FIN into an RST.
    async fn drain_before_close(&mut self, budget: Duration) {
        let deadline = tokio::time::sleep(budget);
        tokio::pin!(deadline);
        let mut buf = [0u8; 4096];
        while let Some(reader) = self.reader.as_mut() {
            tokio::select! {
                _ = &mut deadline => break,
                read = reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                },
            }
        }
    }

    fn detach(&mut self) {
        let remainder = match &mut self.mode {
            Mode::Http { conn, .. } => conn.take_remainder(),
            Mode::Raw => return,
        };
        // Bytes the transport read past the last completed message are either in the codec's own
        // buffers (`remainder`, e.g. a frame sent in the same segment as an upgrade request) or in
        // `http_surplus` (read between messages before JS started the next one). Both belong to
        // the upgraded protocol once parsed mode ends, so they are handed to JS as `data`.
        self.mode = Mode::Raw;
        self.http_idle = false;
        self.http_paused = false;
        self.http_awaiting_outbound = false;
        self.read_request = None;
        // H6: a manual detach hands over the wire-order tail, codec first and transport surplus
        // second. (An upgrade already carried it on `Event::Upgrade` when the codec completed the
        // handover itself, in which case both buffers are empty.)
        let surplus = std::mem::take(&mut self.http_surplus);
        if !remainder.is_empty() {
            self.emit(Event::Data { bytes: remainder });
        }
        if !surplus.is_empty() {
            self.emit(Event::Data { bytes: surplus });
        }
    }
}

/// Emit `error` then `closed` for a handle that never became visible to JS. Only the TLS accept
/// path can hand a registered id to something that never became a socket.
#[cfg(feature = "tls")]
fn fail_before_connected(shared: &Shared, id: HandleId, error: NodeError) {
    shared.emit(id, Event::Error { error });
    shared.emit(id, Event::Closed { had_error: true });
    shared.unregister(id);
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/// One finished connection: the transport plus what `connected` reports about it.
struct Established {
    transport: Transport,
    local: Addr,
    remote: Addr,
    alpn: Option<String>,
    protocol: Option<String>,
}

/// Resolve, connect and, when the options ask for it, hand the TCP socket to rustls.
async fn establish(target: &ConnectTarget) -> Result<Established, NodeError> {
    match target {
        ConnectTarget::Tcp {
            host,
            port,
            options,
        } => {
            let (stream, local, remote) = connect_tcp(host, *port, options).await?;
            // Without the `tls` feature `ConnectOptions` has no `tls` field, and JS cannot ask
            // for TLS without `node:tls`, so every connect is plaintext.
            #[cfg(feature = "tls")]
            if let Some(tls_options) = &options.tls {
                let accepted = tls::connect(stream, tls_options, host).await?;
                return Ok(Established {
                    transport: accepted.transport,
                    local,
                    remote,
                    alpn: accepted.alpn,
                    protocol: accepted.protocol,
                });
            }
            Ok(Established {
                transport: Transport::Tcp(stream),
                local,
                remote,
                alpn: None,
                protocol: None,
            })
        }
        ConnectTarget::Unix { path, options } => {
            #[cfg(feature = "tls")]
            if options.tls.is_some() {
                // TLS over a Unix socket needs a rustls stream generic over the IO type; the
                // transport halves are TCP-shaped, so M4 refuses rather than silently connecting
                // in plaintext (the same rule the pre-WP6 bridge enforced). D41 records it.
                return Err(NodeError::new(
                    "ERR_TLS_UNSUPPORTED_TRANSPORT",
                    "TLS over a Unix socket is not supported",
                ));
            }
            let (stream, local, remote) = connect_unix(path, options).await?;
            Ok(Established {
                transport: Transport::Unix(stream),
                local,
                remote,
                alpn: None,
                protocol: None,
            })
        }
    }
}

async fn connect_tcp(
    host: &str,
    port: u16,
    options: &ConnectOptions,
) -> Result<(TcpStream, Addr, Addr), NodeError> {
    let addresses = resolve_connect(host, port, options.family).await?;
    let mut last_error = None;
    for address in addresses {
        match connect_one(address, options).await {
            Ok(stream) => {
                let local = stream
                    .local_addr()
                    .map_or_else(|_| Addr::Ip(SocketAddr::from(([0, 0, 0, 0], 0))), Addr::Ip);
                let remote = stream.peer_addr().map_or(Addr::Ip(address), Addr::Ip);
                return Ok((stream, local, remote));
            }
            // Node tries each resolved address in turn and reports the last failure.
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| not_found(host)))
}

async fn resolve_connect(
    host: &str,
    port: u16,
    family: IpFamily,
) -> Result<Vec<SocketAddr>, NodeError> {
    // A literal address never touches the resolver, which keeps `connect("127.0.0.1")` off the
    // blocking pool entirely.
    if let Ok(address) = host.parse::<IpAddr>() {
        if !family_matches(address, family) {
            return Err(not_found(host));
        }
        return Ok(vec![SocketAddr::new(address, port)]);
    }
    let resolved = lookup_host((host, port))
        .await
        .map_err(|error| resolve_error(host, &error))?;
    let addresses: Vec<SocketAddr> = resolved
        .filter(|address| family_matches(address.ip(), family))
        .collect();
    if addresses.is_empty() {
        Err(not_found(host))
    } else {
        Ok(addresses)
    }
}

async fn connect_one(
    address: SocketAddr,
    options: &ConnectOptions,
) -> Result<TcpStream, NodeError> {
    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()
    } else {
        TcpSocket::new_v6()
    }
    .map_err(|error| from_io(&error, "socket"))?;

    if options.local_port.is_some() {
        // A requested local port often sits in TIME_WAIT from the previous attempt.
        let _ = socket.set_reuseaddr(true);
    }
    if options.local_address.is_some() || options.local_port.is_some() {
        let local = local_endpoint(&address, options).await?;
        socket
            .bind(local)
            .map_err(|error| from_io_detail(&error, "bind", &local.to_string()))?;
    }

    let stream = socket
        .connect(address)
        .await
        .map_err(|error| from_io_detail(&error, "connect", &address.to_string()))?;

    // Applied before the `connected` event so the first write already has the requested options.
    if options.no_delay {
        stream
            .set_nodelay(true)
            .map_err(|error| from_io(&error, "setsockopt"))?;
    }
    if let Some(delay_ms) = options.keep_alive_ms {
        set_tcp_keep_alive(&stream, true, delay_ms)
            .map_err(|error| from_io(&error, "setsockopt"))?;
    }
    Ok(stream)
}

async fn local_endpoint(
    remote: &SocketAddr,
    options: &ConnectOptions,
) -> Result<SocketAddr, NodeError> {
    let port = options.local_port.unwrap_or(0);
    let Some(text) = options.local_address.as_deref() else {
        // No local address: bind the unspecified address of the remote's family.
        let ip = if remote.is_ipv4() {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V6(Ipv6Addr::UNSPECIFIED)
        };
        return Ok(SocketAddr::new(ip, port));
    };
    if let Ok(address) = text.parse::<IpAddr>() {
        return Ok(SocketAddr::new(address, port));
    }
    let resolved = lookup_host((text, port))
        .await
        .map_err(|error| resolve_error(text, &error))?;
    let addresses: Vec<SocketAddr> = resolved.collect();
    let chosen = addresses
        .iter()
        .find(|candidate| candidate.is_ipv4() == remote.is_ipv4())
        .or_else(|| addresses.first());
    chosen.copied().ok_or_else(|| not_found(text))
}

async fn connect_unix(
    path: &Path,
    options: &ConnectOptions,
) -> Result<(UnixStream, Addr, Addr), NodeError> {
    // TCP socket options do not exist on a Unix socket; Node's `setNoDelay`/`setKeepAlive` are
    // no-ops there as well.
    let _ = options;
    let stream = UnixStream::connect(path)
        .await
        .map_err(|error| from_io_at(&error, "connect", path))?;
    let address = Addr::Unix(path.to_path_buf());
    // A connected Unix socket has no useful `peer_addr()`: Node reports the bound path on both
    // sides, and so does `Addr::Unix`.
    Ok((stream, address.clone(), address))
}

// ---------------------------------------------------------------------------
// Canned responses
// ---------------------------------------------------------------------------

/// The response the task itself writes when the peer's bytes are not a legal HTTP message
/// (m4-plan §5). It is deliberately minimal: the connection is closing anyway.
fn canned_response(status: u16) -> Vec<u8> {
    let reason = match status {
        400 => "Bad Request",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        505 => "HTTP Version Not Supported",
        _ => "Bad Request",
    };
    format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canned_responses_use_the_protocol_status() {
        let bad_request = String::from_utf8(canned_response(400)).expect("utf-8");
        assert!(bad_request.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(bad_request.ends_with("\r\n\r\n"));
        assert!(bad_request.contains("Connection: close\r\n"));

        let too_large = String::from_utf8(canned_response(431)).expect("utf-8");
        assert!(too_large.starts_with("HTTP/1.1 431 Request Header Fields Too Large\r\n"));

        // An unknown-but-valid status still produces a legal response line.
        assert!(String::from_utf8(canned_response(499))
            .expect("utf-8")
            .starts_with("HTTP/1.1 499 "));
    }

    #[test]
    fn family_filtering_matches_node() {
        let v4: IpAddr = "127.0.0.1".parse().expect("v4");
        let v6: IpAddr = "::1".parse().expect("v6");
        assert!(family_matches(v4, IpFamily::Either));
        assert!(family_matches(v4, IpFamily::V4));
        assert!(!family_matches(v4, IpFamily::V6));
        assert!(family_matches(v6, IpFamily::Either));
        assert!(family_matches(v6, IpFamily::V6));
        assert!(!family_matches(v6, IpFamily::V4));
    }
}
