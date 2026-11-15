//! Child-process syscalls: spawn, pipes, signals, reaping, and `fork` IPC framing.
//!
//! This is the M5 WP3 half of the host boundary described in
//! [ADR-0008 §2.6](../../docs/adr/0008-processes-and-threads.md) and `docs/m5-plan.md`
//! §3.2/§3.5. One child is one [`ChildId`] and one task. Its three pipes are *not* separate
//! handles: every event carries a [`Stream`], which keeps one loop ref per child (as in Node) and
//! makes the `exit`/`close` ordering a property of one task.
//!
//! The invariants this module maintains:
//!
//! - **One task owns one child.** The task owns the `tokio::process::Child`, its three pipes and
//!   the command receiver, and waits on all of them with a single `tokio::select!`.
//! - **Reads are pull-based.** A pipe is only read after a [`Command::Read`] for that stream,
//!   and at most one read is outstanding per stream. One [`Event::Data`] carries at most
//!   [`MAX_CHUNK`] bytes. Writes to stdin are queued in order and reported with [`Event::Drain`]
//!   when the queue empties.
//! - **`exit` then `close`.** [`Event::Exit`] is emitted when `Child::wait` returns;
//!   [`Event::Close`] only after every piped output stream reached EOF, `exit` was emitted, and
//!   (when present) the IPC channel disconnected. A stream the caller never resumes therefore
//!   keeps `close` pending, exactly like a paused stdio stream in Node.
//! - **A child is always reaped.** The task drives `wait` to completion even after
//!   [`ChildService::shutdown`]; shutdown only gates event delivery (H4). Once the command channel
//!   closes, the task also drains the output pipes so a chatty child cannot deadlock on a full pipe
//!   while it is being reaped.
//! - **H5.** A command addressed to a finished child, or a write after `stdin.end()`, is ignored,
//!   never a panic. A missing program is an asynchronous [`Event::Error`] (Node semantics), not a
//!   synchronous error; invalid arguments may be synchronous [`NodeError`]s.
//! - **H1.** No JS value crosses this boundary: [`Command`] and [`Event`] are plain Rust data,
//!   and both are `Send`.
//!
//! IPC is a length-prefixed frame codec ([`FrameDecoder`] / [`encode_frame`]): a `u32`
//! little-endian length followed by that many opaque payload bytes, with a [`MAX_FRAME_SIZE`]
//! cap. `fork` attaches the *parent* end with [`ChildService::spawn`]'s `ipc` argument; the child
//! end is passed to the child by WP4 as fd 3 (`IPC_FD`), which is why it is handed back as an
//! [`IpcChannel`] the runtime can turn into a descriptor. The framing is onde-only, not Node's
//! wire format (D50).
//!
//! `ln-io` is Unix-only (see `lib.rs`), so the IPC transport is a `UnixStream` pair. `spawn` takes
//! it as an `Option`, so a build without IPC simply cannot request it.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use ln_error::NodeError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command as TokioCommand};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

use crate::Pool;

/// Identifies one live child for its lifetime. Same id space as [`crate::net::HandleId`]: the
/// runtime mints it and one allocator backs every family (`docs/m5-plan.md` §3).
pub type ChildId = u64;

/// Mints child-family ids for handles the service creates itself (WP4's attached IPC capability).
/// `ln-runtime` supplies the same closure it gives the op and net tables.
pub type ChildIdSource = Arc<dyn Fn() -> ChildId + Send + Sync>;

/// Where the child's task delivers events. `ln-runtime`'s sink parks them per child and wakes the
/// loop; `ln-io` never touches the scheduler (ADR-0006 §2.3).
pub type EventSink = Arc<dyn Fn(ChildId, Event) + Send + Sync>;

/// The largest chunk one [`Event::Data`] may carry, and the cap on a single [`Command::Read`].
pub const MAX_CHUNK: u32 = 64 * 1024;

/// The largest legal IPC frame payload (64 MiB). A length prefix above this is a protocol error.
pub const MAX_FRAME_SIZE: u32 = 64 * 1024 * 1024;

/// The descriptor `fork` passes the child end of the IPC pair on (`docs/m5-plan.md` §3.5).
pub const IPC_FD: i32 = 3;

/// The environment variable that tells a forked child which descriptor carries the IPC channel.
pub const IPC_ENV: &str = "ONDE_IPC_FD";

/// Which of a child's three byte streams an event or command refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdin,
    Stdout,
    Stderr,
}

impl Stream {
    /// Node's stream name, as the JS layer spells it in event payloads.
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Stdin => "stdin",
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

/// What to do with one of the child's stdio slots (`SpawnOptions::stdio`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioMode {
    /// Give the child a fresh pipe; the parent end becomes the matching stream.
    Pipe,
    /// `/dev/null`.
    Ignore,
    /// Share the parent's descriptor (the isolate's own stdin/stdout/stderr).
    Inherit,
    /// Give the child a duplicate of this descriptor (Node's `stdio: fd`); the caller keeps its
    /// own.
    Fd(i32),
}

/// Everything `spawn` needs. Plain Rust only (H1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnOptions {
    /// The executable to run. Resolution follows the OS (`PATH` when the path has no separator).
    pub program: PathBuf,
    /// Arguments after `argv[0]`.
    pub args: Vec<String>,
    /// Working directory; `None` inherits the isolate's.
    pub cwd: Option<PathBuf>,
    /// `None` inherits the isolate's environment. `Some` clears it and applies the list in order:
    /// `Some(value)` sets, `None` deletes (a no-op after the clear, kept for Node's shape).
    pub env: Option<Vec<(String, Option<String>)>>,
    /// stdin, stdout, stderr in that order.
    pub stdio: [StdioMode; 3],
    /// Put the child in a process group of its own (`process_group(0)`; Node also calls `setsid`).
    pub detached: bool,
    /// Override `argv[0]` on Unix.
    pub argv0: Option<String>,
}

/// One event from a child's task to the isolate thread. Emitted through [`EventSink`] and
/// converted to `__ln_proc_event(id, name, payload)` by `ln-runtime`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The process exists. A missing program never produces this (see [`Event::Error`]).
    Spawned { pid: u32 },
    /// One chunk for a piped output stream, at most [`MAX_CHUNK`] bytes.
    Data { stream: Stream, bytes: Vec<u8> },
    /// A piped output stream reached EOF. Emitted at most once per stream.
    End { stream: Stream },
    /// The stdin write queue emptied (`'drain'` on the JS writable).
    Drain { stream: Stream },
    /// `Child::wait` returned. Always before [`Event::Close`].
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// The child exited and every piped stream reached EOF. Always last for the id.
    Close {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// An asynchronous failure: a missing program (`ENOENT`), a broken pipe, a wait error, an IPC
    /// framing error. Synchronous argument errors are returned from [`ChildService::spawn`].
    Error { error: NodeError },
    /// One complete IPC frame (length-prefixed opaque payload; the JS layer parses the JSON).
    Message { bytes: Vec<u8> },
    /// The IPC channel closed, was disconnected, or carried a malformed frame.
    Disconnect,
}

/// One command from the isolate thread to a child's task. Ordered per child; a command for an id
/// that has no task is ignored (H5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Spawn a child for this id. [`ChildService::spawn`] is the primary entry point; this variant
    /// exists so the host boundary has one uniform command shape. It cannot return an error, so
    /// argument errors become [`Event::Error`].
    Spawn(SpawnOptions),
    /// Queue bytes for stdin. Other streams are not writable.
    Write { stream: Stream, data: Vec<u8> },
    /// Flush stdin's queue, then close it so the child sees EOF.
    End { stream: Stream },
    /// Pull one chunk, at most `max` bytes (clamped to `1..=MAX_CHUNK`). Ignored while a read for
    /// that stream is already outstanding.
    Read { stream: Stream, max: u32 },
    /// Stop pulling one stream; the other keeps flowing.
    ReadStop { stream: Stream },
    /// Send a signal. Unix: `libc::kill`; elsewhere: best effort, `SIGKILL`/`SIGTERM` only.
    Kill { signal: i32 },
    /// One IPC frame (framed by the service). Ignored with an error if no IPC channel is attached.
    Send { bytes: Vec<u8> },
    /// Close the IPC channel.
    Disconnect,
    /// Loop refcounts belong to the runtime's handle table (H3); accepted and ignored.
    Ref,
    /// Loop refcounts belong to the runtime's handle table (H3); accepted and ignored.
    Unref,
}

/// The isolate thread's only handle on the child-process tasks: one instance per isolate.
///
/// It is `Send + Sync` and cheap to call (a command is one channel send). The tasks never hold the
/// [`Pool`] itself, only its [`Handle`], so the runtime is dropped on the isolate thread.
pub struct ChildService {
    shared: Arc<Shared>,
    _pool: Arc<Pool>,
}

impl ChildService {
    /// `pool` must be the process-wide pool (ADR-0003: one tokio runtime for ops and handles).
    pub fn new(pool: Arc<Pool>, sink: EventSink, ids: ChildIdSource) -> Self {
        ChildService {
            shared: Arc::new(Shared::new(pool.handle(), sink, ids)),
            _pool: pool,
        }
    }

    /// Mint a proc-family handle id from the allocator the runtime supplied. WP4's attached IPC
    /// capability is a proc-family handle (m5-plan §3.5) and uses this for its id.
    pub fn mint(&self) -> ChildId {
        self.shared.mint()
    }

    /// Start the task for `id`, which spawns the process.
    ///
    /// Returns immediately: a missing program, an unreadable descriptor or a failed `fork` is an
    /// asynchronous [`Event::Error`], as in Node. Synchronous errors are invalid arguments only
    /// (a zero id, an empty program, a negative stdio fd). When the service is shut down or `id`
    /// is already live, nothing is started and the call returns `Ok(())` (H4/H5).
    ///
    /// `ipc` is the parent end of an [`ipc_pair`]. When present the task frames
    /// [`Command::Send`] and emits one [`Event::Message`] per received frame.
    pub fn spawn(
        &self,
        id: ChildId,
        options: SpawnOptions,
        ipc: Option<IpcChannel>,
    ) -> Result<(), NodeError> {
        self.spawn_with_ipc_child(id, options, ipc, None)
    }

    /// [`spawn`](Self::spawn) with the child end of the IPC pair.
    ///
    /// WP4's `fork` creates one [`ipc_pair`], keeps the parent end for the task and passes the
    /// child end here; the spawn task duplicates it onto [`IPC_FD`] in the forked child and exports
    /// [`IPC_ENV`]. The descriptor is owned by the task until `spawn` returns.
    pub fn spawn_with_ipc_child(
        &self,
        id: ChildId,
        options: SpawnOptions,
        ipc: Option<IpcChannel>,
        ipc_child: Option<OwnedFd>,
    ) -> Result<(), NodeError> {
        if id == 0 {
            return Err(NodeError::invalid_arg_value("id", "0", "is invalid"));
        }
        if options.program.as_os_str().is_empty() {
            return Err(NodeError::invalid_arg_value(
                "file",
                "''",
                "cannot be empty",
            ));
        }
        for mode in options.stdio {
            if let StdioMode::Fd(fd) = mode {
                if fd < 0 {
                    return Err(NodeError::invalid_arg_value(
                        "stdio",
                        &fd.to_string(),
                        "is invalid",
                    ));
                }
            }
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        if !self.shared.register(id, sender) {
            // Closed service or a duplicate id: the runtime's allocator makes the latter a bug,
            // but neither case may panic or deliver an event (H4/H5).
            return Ok(());
        }
        self.shared.spawn_task(run(
            self.shared.clone(),
            id,
            options,
            ipc,
            ipc_child,
            receiver,
        ));
        Ok(())
    }

    /// Submit one command for a child.
    ///
    /// `0` means "no handle" and is always ignored. A command for an id whose task has finished is
    /// dropped, never an error (H5).
    pub fn command(&self, id: ChildId, command: Command) {
        if id == 0 {
            return;
        }
        match command {
            // A command has no return value, so an argument error becomes an async `error` event.
            Command::Spawn(options) => {
                if let Err(error) = self.spawn(id, options, None) {
                    self.shared.emit(id, Event::Error { error });
                }
            }
            command => {
                if let Some(sender) = self.shared.sender(id) {
                    // The task may have finished between the lookup and the send; that is the
                    // same "unknown id" case, not an error.
                    let _ = sender.send(command);
                }
            }
        }
    }

    /// Stop delivering events. Once this returns, no further event reaches the sink (H4).
    ///
    /// Idempotent and non-blocking. Children are **not** killed: their tasks keep running, drain
    /// their pipes and reap them, but every `emit` is dropped. Closing the command channels makes
    /// the tasks switch to draining mode, so a chatty child cannot stall forever on a full pipe.
    pub fn shutdown(&self) {
        self.shared.shutdown();
    }
}

impl Drop for ChildService {
    fn drop(&mut self) {
        // A dropped service must not keep delivering into a sink whose isolate is gone.
        self.shared.shutdown();
    }
}

// ---------------------------------------------------------------------------
// IPC framing
// ---------------------------------------------------------------------------

/// Encode one frame: `u32` little-endian length + payload.
///
/// Fails with `ERR_IPC_FRAME_TOO_LARGE` when the payload exceeds [`MAX_FRAME_SIZE`].
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, NodeError> {
    let Ok(length) = u32::try_from(payload.len()) else {
        return Err(frame_too_large(u32::MAX));
    };
    if length > MAX_FRAME_SIZE {
        return Err(frame_too_large(length));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Incremental frame decoder: push transport bytes, then pull the complete frames they contain.
///
/// The buffer never holds more than one legal frame ([`MAX_FRAME_SIZE`] + 4 bytes) plus one read
/// chunk, because a length prefix above the cap is rejected as soon as it is parsed.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        FrameDecoder::default()
    }

    /// Append bytes read from the transport.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// Pop the next complete frame, `None` when more bytes are needed, or an error when the peer
    /// announced a frame larger than [`MAX_FRAME_SIZE`] (the caller must disconnect).
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, NodeError> {
        if self.buffer.len() < 4 {
            return Ok(None);
        }
        let header = [
            self.buffer[0],
            self.buffer[1],
            self.buffer[2],
            self.buffer[3],
        ];
        let length = u32::from_le_bytes(header);
        if length > MAX_FRAME_SIZE {
            return Err(frame_too_large(length));
        }
        let total = 4 + length as usize;
        if self.buffer.len() < total {
            return Ok(None);
        }
        let payload = self.buffer[4..total].to_vec();
        self.buffer.drain(..total);
        Ok(Some(payload))
    }
}

/// One end of the `fork` IPC transport (on Unix, a `UnixStream`).
///
/// [`ipc_pair`] creates the two ends; the parent keeps one and [`ChildService::spawn`] attaches it,
/// while the runtime passes the other to the child as fd [`IPC_FD`]. The blocking
/// [`read_frame`](IpcChannel::read_frame)/[`write_frame`](IpcChannel::write_frame) helpers are the
/// codec's synchronous face (tests and the child-side attach path); the service converts its end to
/// a `tokio::net::UnixStream` and never blocks a pool thread.
#[derive(Debug)]
pub struct IpcChannel {
    stream: std::os::unix::net::UnixStream,
}

impl IpcChannel {
    pub fn from_std(stream: std::os::unix::net::UnixStream) -> Self {
        IpcChannel { stream }
    }

    pub fn into_std(self) -> std::os::unix::net::UnixStream {
        self.stream
    }

    /// Toggle non-blocking mode. The async side needs it; the runtime's child end does not.
    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        self.stream.set_nonblocking(nonblocking)
    }

    /// Write one frame. Blocking; `&self` is enough because `&UnixStream` is `Write`.
    pub fn write_frame(&self, payload: &[u8]) -> Result<(), NodeError> {
        let frame = encode_frame(payload)?;
        let mut stream = &self.stream;
        stream
            .write_all(&frame)
            .map_err(|error| io_error(&error, "write"))
    }

    /// Read one frame. `None` is a clean EOF; a truncated frame is an error.
    pub fn read_frame(&self) -> Result<Option<Vec<u8>>, NodeError> {
        let mut header = [0u8; 4];
        if !read_exact_or_eof(&self.stream, &mut header)? {
            return Ok(None);
        }
        let length = u32::from_le_bytes(header);
        if length > MAX_FRAME_SIZE {
            return Err(frame_too_large(length));
        }
        let mut payload = vec![0u8; length as usize];
        let mut stream = &self.stream;
        stream
            .read_exact(&mut payload)
            .map_err(|error| io_error(&error, "read"))?;
        Ok(Some(payload))
    }

    /// Convert the parent end into the async transport. Must run inside the pool (it registers
    /// with the reactor), which is why the task does it rather than [`ChildService::spawn`].
    fn into_tokio(self) -> Result<tokio::net::UnixStream, NodeError> {
        self.stream
            .set_nonblocking(true)
            .map_err(|error| io_error(&error, "fcntl"))?;
        tokio::net::UnixStream::from_std(self.stream).map_err(|error| io_error(&error, "socket"))
    }
}

impl AsRawFd for IpcChannel {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.stream.as_raw_fd()
    }
}

/// Create the two ends of a `fork` IPC channel: `(parent, child)`.
///
/// The parent end is given to [`ChildService::spawn`]; the child end is passed to the child as fd
/// [`IPC_FD`] (and `ONDE_IPC_FD=3` set in its environment) by WP4.
pub fn ipc_pair() -> io::Result<(IpcChannel, IpcChannel)> {
    let (parent, child) = std::os::unix::net::UnixStream::pair()?;
    Ok((IpcChannel::from_std(parent), IpcChannel::from_std(child)))
}

fn frame_too_large(length: u32) -> NodeError {
    NodeError::new(
        "ERR_IPC_FRAME_TOO_LARGE",
        format!("IPC frame of {length} bytes exceeds the {MAX_FRAME_SIZE}-byte limit"),
    )
}

fn read_exact_or_eof(
    stream: &std::os::unix::net::UnixStream,
    buffer: &mut [u8],
) -> Result<bool, NodeError> {
    let mut filled = 0;
    while filled < buffer.len() {
        let mut stream = stream;
        match stream.read(&mut buffer[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(NodeError::from_errno(libc::EIO, "read", None)),
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(&error, "read")),
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// Service internals
// ---------------------------------------------------------------------------

/// The state every child task of one service shares: the runtime, the sink, the id allocator, the
/// live-child table and the shutdown gate. Same shape as `net::registry::Shared`, for the same
/// reasons: H4 needs a barrier between `emit` and `shutdown`, and H5 needs a missing id to be a
/// `None`, not a panic.
struct Shared {
    /// The runtime to spawn tasks on. A `Handle` rather than the `Pool`: see `Pool::handle`.
    runtime: Handle,
    sink: EventSink,
    ids: ChildIdSource,
    tasks: Mutex<HashMap<ChildId, mpsc::UnboundedSender<Command>>>,
    /// Serializes `emit` against `shutdown`.
    barrier: Mutex<()>,
    open: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Poisoning only means another task panicked mid-update; every mutation point leaves the maps
    // consistent, so recover instead of panicking a second time (H5).
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    fn new(runtime: Handle, sink: EventSink, ids: ChildIdSource) -> Self {
        Shared {
            runtime,
            sink,
            ids,
            tasks: Mutex::new(HashMap::new()),
            barrier: Mutex::new(()),
            open: AtomicBool::new(true),
        }
    }

    fn spawn_task<F>(&self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.runtime.spawn(task);
    }

    fn mint(&self) -> ChildId {
        (self.ids)()
    }

    fn sender(&self, id: ChildId) -> Option<mpsc::UnboundedSender<Command>> {
        lock(&self.tasks).get(&id).cloned()
    }

    /// Add a child to the table. `false` means the id is already live or the service is shutting
    /// down; the caller must not spawn a task in that case.
    fn register(&self, id: ChildId, sender: mpsc::UnboundedSender<Command>) -> bool {
        let mut tasks = lock(&self.tasks);
        // Checked under the table lock so `shutdown` cannot drain between check and insert.
        if !self.open.load(Ordering::SeqCst) {
            return false;
        }
        tasks.insert(id, sender).is_none()
    }

    fn unregister(&self, id: ChildId) {
        lock(&self.tasks).remove(&id);
    }

    /// Deliver one event, unless the service has been shut down (H4).
    fn emit(&self, id: ChildId, event: Event) {
        let _barrier = lock(&self.barrier);
        if !self.open.load(Ordering::SeqCst) {
            return;
        }
        (self.sink)(id, event);
    }

    /// Close the event gate and drop every command channel (H4).
    ///
    /// The tasks are not told to stop: closing the channel makes `recv` return `None`, which puts
    /// them in draining mode. They keep owning their children and always reap them.
    fn shutdown(&self) {
        let _barrier = lock(&self.barrier);
        if !self.open.swap(false, Ordering::SeqCst) {
            return;
        }
        // Dropping the senders wakes every idle task; their emits are gated by the barrier above.
        lock(&self.tasks).clear();
    }
}

/// Remove the id from the table when the task ends, on every exit path.
struct Registration {
    shared: Arc<Shared>,
    id: ChildId,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.shared.unregister(self.id);
    }
}

/// One IPC write/disconnect instruction from the child task to the IPC reader task.
enum IpcCommand {
    Send(Vec<u8>),
    Disconnect,
}

// ---------------------------------------------------------------------------
// The child task
// ---------------------------------------------------------------------------

/// The one-shot `select!` result. Keeping its payloads disjoint is what makes "one read in flight
/// per stream" structural: there is one read future per stream, created only while that stream has
/// an outstanding [`Command::Read`].
enum Step {
    Command(Option<Command>),
    Stdout(io::Result<usize>),
    Stderr(io::Result<usize>),
    Stdin(io::Result<usize>),
    Exit(io::Result<ExitStatus>),
    IpcDone,
}

async fn run(
    shared: Arc<Shared>,
    id: ChildId,
    options: SpawnOptions,
    ipc: Option<IpcChannel>,
    ipc_child: Option<OwnedFd>,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let _registration = Registration {
        shared: shared.clone(),
        id,
    };

    let mut command = TokioCommand::new(&options.program);
    command.args(&options.args);
    if let Some(cwd) = options.cwd.as_deref() {
        command.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        command.env_clear();
        for (key, value) in env {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
    }

    // `Fd` is duplicated so the child's descriptor and the caller's are independent, as in Node.
    let mut stdio = [Stdio::null(), Stdio::null(), Stdio::null()];
    for (slot, mode) in stdio.iter_mut().zip(options.stdio) {
        match make_stdio(mode) {
            Ok(value) => *slot = value,
            Err(error) => {
                shared.emit(id, Event::Error { error });
                return;
            }
        }
    }
    let [stdin_stdio, stdout_stdio, stderr_stdio] = stdio;
    command
        .stdin(stdin_stdio)
        .stdout(stdout_stdio)
        .stderr(stderr_stdio);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        if options.detached {
            command.as_std_mut().process_group(0);
        }
        if let Some(argv0) = &options.argv0 {
            command.as_std_mut().arg0(argv0);
        }
        if let Some(fd) = ipc_child.as_ref() {
            // `pre_exec` runs in the forked child before `exec`. `dup2` onto a fixed descriptor is
            // async-signal-safe, and the raw fd stays valid because `ipc_child` is alive until
            // `command.spawn()` returns below.
            let raw = fd.as_raw_fd();
            // SAFETY: the closure calls only `dup2` and reads a descriptor the parent owns; no
            // allocation, no Rust code that may panic, and no access to memory shared with the
            // parent after fork. The error path uses `io::Error::last_os_error`, which is
            // async-signal-safe.
            unsafe {
                command.as_std_mut().pre_exec(move || {
                    if libc::dup2(raw, IPC_FD) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            command.env(IPC_ENV, IPC_FD.to_string());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = options.detached;
        let _ = &options.argv0;
        let _ = &ipc_child;
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            shared.emit(
                id,
                Event::Error {
                    error: spawn_error(&error, &options.program),
                },
            );
            return;
        }
    };
    let pid = child.id();

    // Take every pipe before the loop: `Child::wait` drops `child.stdin`, and these handles are
    // the task's to close on its own schedule.
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    if let Some(pid) = pid {
        shared.emit(id, Event::Spawned { pid });
    }

    // IPC: the reader task owns the socket and emits one message per frame. The oneshot tells this
    // task when that channel is done, so `close` can wait for it without a second shared flag.
    let mut ipc_sender: Option<mpsc::UnboundedSender<IpcCommand>> = None;
    let mut ipc_done: Option<oneshot::Receiver<()>> = None;
    let mut ipc_open = false;
    if let Some(channel) = ipc {
        match channel.into_tokio() {
            Ok(stream) => {
                let (sender, receiver) = mpsc::unbounded_channel();
                let (done_sender, done_receiver) = oneshot::channel();
                shared.spawn_task(ipc_task(shared.clone(), id, stream, receiver, done_sender));
                ipc_sender = Some(sender);
                ipc_done = Some(done_receiver);
                ipc_open = true;
            }
            Err(error) => {
                shared.emit(id, Event::Error { error });
                shared.emit(id, Event::Disconnect);
            }
        }
    }

    let mut stdin_queue: VecDeque<Vec<u8>> = VecDeque::new();
    let mut stdin_offset = 0usize;
    let mut stdin_end = false;
    let mut stdin_drain_pending = false;

    let mut stdout_buf = vec![0u8; MAX_CHUNK as usize];
    let mut stderr_buf = vec![0u8; MAX_CHUNK as usize];
    let mut stdout_want: Option<usize> = None;
    let mut stderr_want: Option<usize> = None;
    let mut stdout_eof = stdout.is_none();
    let mut stderr_eof = stderr.is_none();

    let mut exit: Option<(Option<i32>, Option<i32>)> = None;
    let mut commands_closed = false;

    loop {
        // A pending `End` flushes stdin's queue, then closes the pipe so the child sees EOF.
        if stdin_end && stdin_queue.is_empty() {
            stdin = None;
        }
        // After shutdown nobody can observe a drain or a queued write; dropping both is what lets
        // a task that is only waiting to reap finish promptly.
        if commands_closed {
            stdin_queue.clear();
            stdin_offset = 0;
            if ipc_open {
                // Drop the sender and stop waiting for the channel: no event can be delivered.
                ipc_sender = None;
                ipc_done = None;
                ipc_open = false;
            }
        }

        // Shutdown drains the pipes: the isolate is gone, so no data can be delivered, but the
        // child must not block on a full pipe before it exits (W3: always reap).
        if commands_closed {
            if stdout.is_some() && !stdout_eof && stdout_want.is_none() {
                stdout_want = Some(MAX_CHUNK as usize);
            }
            if stderr.is_some() && !stderr_eof && stderr_want.is_none() {
                stderr_want = Some(MAX_CHUNK as usize);
            }
        }

        if let Some((code, signal)) = exit {
            // Node emits `close` after `exit` even when the caller never consumed an output
            // stream. The child is gone, so what remains is bounded by the OS pipe buffer: drain
            // it (delivering the bytes, which a paused Readable will buffer) so EOF and `close`
            // can happen. Without this, `spawn("echo")` without a stderr listener never closes.
            if !stdout_eof && stdout_want.is_none() {
                stdout_want = Some(MAX_CHUNK as usize);
            }
            if !stderr_eof && stderr_want.is_none() {
                stderr_want = Some(MAX_CHUNK as usize);
            }
            if stdout_eof && stderr_eof && !ipc_open {
                shared.emit(id, Event::Close { code, signal });
                break;
            }
        }

        let want_stdout = stdout.is_some() && !stdout_eof && stdout_want.is_some();
        let want_stderr = stderr.is_some() && !stderr_eof && stderr_want.is_some();
        let want_stdin = stdin.is_some() && !stdin_queue.is_empty();
        let want_wait = exit.is_none();
        let want_ipc = ipc_open && ipc_done.is_some();

        if !want_stdout && !want_stderr && !want_stdin && !want_wait && !want_ipc && commands_closed
        {
            // Defensive: the `close` check above already covers this state.
            break;
        }

        let stdout_max = stdout_want.unwrap_or(0);
        let stderr_max = stderr_want.unwrap_or(0);

        let step = tokio::select! {
            command = commands.recv(), if !commands_closed => Step::Command(command),
            read = async {
                match stdout.as_mut() {
                    Some(reader) => reader.read(&mut stdout_buf[..stdout_max]).await,
                    None => std::future::pending::<io::Result<usize>>().await,
                }
            }, if want_stdout => Step::Stdout(read),
            read = async {
                match stderr.as_mut() {
                    Some(reader) => reader.read(&mut stderr_buf[..stderr_max]).await,
                    None => std::future::pending::<io::Result<usize>>().await,
                }
            }, if want_stderr => Step::Stderr(read),
            written = async {
                let queued = match stdin_queue.front() {
                    Some(bytes) => bytes,
                    None => std::future::pending::<&Vec<u8>>().await,
                };
                let pending = &queued[stdin_offset..];
                match stdin.as_mut() {
                    Some(writer) => writer.write(pending).await,
                    None => std::future::pending::<io::Result<usize>>().await,
                }
            }, if want_stdin => Step::Stdin(written),
            _done = async {
                match ipc_done.as_mut() {
                    Some(receiver) => receiver.await,
                    None => std::future::pending::<Result<(), oneshot::error::RecvError>>().await,
                }
            }, if want_ipc => Step::IpcDone,
            status = child.wait(), if want_wait => Step::Exit(status),
            else => break,
        };

        match step {
            Step::Command(Some(command)) => match command {
                Command::Write { stream, data } => {
                    if stream == Stream::Stdin && stdin.is_some() && !stdin_end {
                        // `stdin_offset` belongs to the buffer at the front and is zero whenever
                        // the queue is empty; resetting it here would resend a partially
                        // written buffer when another `Write` arrives mid-write.
                        stdin_queue.push_back(data);
                        stdin_drain_pending = true;
                    }
                }
                Command::End { stream } => {
                    if stream == Stream::Stdin {
                        stdin_end = true;
                    }
                }
                Command::Read { stream, max } => {
                    // Never a zero-length read: it would look like EOF.
                    let max = max.clamp(1, MAX_CHUNK) as usize;
                    match stream {
                        Stream::Stdout if !stdout_eof => stdout_want = Some(max),
                        Stream::Stderr if !stderr_eof => stderr_want = Some(max),
                        _ => {}
                    }
                }
                Command::ReadStop { stream } => match stream {
                    Stream::Stdout => stdout_want = None,
                    Stream::Stderr => stderr_want = None,
                    Stream::Stdin => {}
                },
                Command::Kill { signal } => {
                    // A queued kill handled after the child was reaped must not signal a recycled
                    // pid; `pid` is the child's until `wait` returns.
                    if exit.is_none() {
                        send_signal(&mut child, pid, signal);
                    }
                }
                Command::Send { bytes } => match &ipc_sender {
                    Some(sender) => {
                        let _ = sender.send(IpcCommand::Send(bytes));
                    }
                    None => shared.emit(
                        id,
                        Event::Error {
                            error: NodeError::new(
                                "ERR_CHILD_PROCESS_IPC_REQUIRED",
                                "Cannot send a message: this child has no IPC channel",
                            ),
                        },
                    ),
                },
                Command::Disconnect => {
                    if let Some(sender) = &ipc_sender {
                        let _ = sender.send(IpcCommand::Disconnect);
                    }
                }
                // Loop refcounts are the runtime's handle table's (H3); `Spawn` is not forwarded.
                Command::Ref | Command::Unref | Command::Spawn(_) => {}
            },
            Step::Command(None) => commands_closed = true,
            Step::Stdout(Ok(0)) => {
                stdout_eof = true;
                stdout = None;
                stdout_want = None;
                shared.emit(
                    id,
                    Event::End {
                        stream: Stream::Stdout,
                    },
                );
            }
            Step::Stdout(Ok(count)) => {
                stdout_want = None;
                shared.emit(
                    id,
                    Event::Data {
                        stream: Stream::Stdout,
                        bytes: stdout_buf[..count].to_vec(),
                    },
                );
            }
            Step::Stdout(Err(error)) => {
                stdout_eof = true;
                stdout = None;
                stdout_want = None;
                shared.emit(
                    id,
                    Event::Error {
                        error: io_error(&error, "read"),
                    },
                );
                shared.emit(
                    id,
                    Event::End {
                        stream: Stream::Stdout,
                    },
                );
            }
            Step::Stderr(Ok(0)) => {
                stderr_eof = true;
                stderr = None;
                stderr_want = None;
                shared.emit(
                    id,
                    Event::End {
                        stream: Stream::Stderr,
                    },
                );
            }
            Step::Stderr(Ok(count)) => {
                stderr_want = None;
                shared.emit(
                    id,
                    Event::Data {
                        stream: Stream::Stderr,
                        bytes: stderr_buf[..count].to_vec(),
                    },
                );
            }
            Step::Stderr(Err(error)) => {
                stderr_eof = true;
                stderr = None;
                stderr_want = None;
                shared.emit(
                    id,
                    Event::Error {
                        error: io_error(&error, "read"),
                    },
                );
                shared.emit(
                    id,
                    Event::End {
                        stream: Stream::Stderr,
                    },
                );
            }
            Step::Stdin(Ok(0)) => {
                // A zero-byte write to a pipe means the child closed its end.
                stdin = None;
                stdin_queue.clear();
                stdin_offset = 0;
                shared.emit(
                    id,
                    Event::Error {
                        error: NodeError::from_errno(libc::EPIPE, "write", None),
                    },
                );
            }
            Step::Stdin(Ok(count)) => {
                stdin_offset += count;
                let front_len = stdin_queue.front().map_or(0, Vec::len);
                if stdin_offset >= front_len {
                    stdin_queue.pop_front();
                    stdin_offset = 0;
                }
                if stdin_queue.is_empty() && stdin_drain_pending {
                    stdin_drain_pending = false;
                    shared.emit(
                        id,
                        Event::Drain {
                            stream: Stream::Stdin,
                        },
                    );
                }
            }
            Step::Stdin(Err(error)) => {
                stdin = None;
                stdin_queue.clear();
                stdin_offset = 0;
                shared.emit(
                    id,
                    Event::Error {
                        error: io_error(&error, "write"),
                    },
                );
            }
            Step::Exit(Ok(status)) => {
                let (code, signal) = exit_parts(&status);
                exit = Some((code, signal));
                // The child is gone; stdin can never be written again.
                stdin = None;
                stdin_queue.clear();
                stdin_offset = 0;
                shared.emit(id, Event::Exit { code, signal });
            }
            Step::Exit(Err(error)) => {
                exit = Some((None, None));
                shared.emit(
                    id,
                    Event::Error {
                        error: io_error(&error, "waitpid"),
                    },
                );
                shared.emit(
                    id,
                    Event::Exit {
                        code: None,
                        signal: None,
                    },
                );
            }
            Step::IpcDone => {
                ipc_open = false;
                ipc_done = None;
            }
        }
    }

    // Defensive: every loop exit above happens after `wait` completed, so this is normally a
    // no-op. It is the W3 guarantee: a child is reaped even if a future refactor breaks that.
    if exit.is_none() {
        let _ = child.wait().await;
    }
}

async fn ipc_task(
    shared: Arc<Shared>,
    id: ChildId,
    stream: tokio::net::UnixStream,
    mut commands: mpsc::UnboundedReceiver<IpcCommand>,
    done: oneshot::Sender<()>,
) {
    // Dropped on every return path, which is what wakes the child task's `close` check.
    let _done = done;
    let (mut reader, mut writer) = stream.into_split();
    let mut decoder = FrameDecoder::new();
    let mut buffer = vec![0u8; MAX_CHUNK as usize];
    loop {
        tokio::select! {
            read = reader.read(&mut buffer) => match read {
                Ok(0) => {
                    shared.emit(id, Event::Disconnect);
                    return;
                }
                Ok(count) => {
                    decoder.push(&buffer[..count]);
                    loop {
                        match decoder.next_frame() {
                            Ok(Some(bytes)) => shared.emit(id, Event::Message { bytes }),
                            Ok(None) => break,
                            Err(error) => {
                                // A malformed frame poisons the stream: report it and disconnect.
                                shared.emit(id, Event::Error { error });
                                shared.emit(id, Event::Disconnect);
                                return;
                            }
                        }
                    }
                }
                Err(error) => {
                    shared.emit(id, Event::Error { error: io_error(&error, "read") });
                    shared.emit(id, Event::Disconnect);
                    return;
                }
            },
            command = commands.recv() => match command {
                Some(IpcCommand::Send(bytes)) => match encode_frame(&bytes) {
                    Ok(frame) => {
                        if let Err(error) = writer.write_all(&frame).await {
                            shared.emit(id, Event::Error { error: io_error(&error, "write") });
                            shared.emit(id, Event::Disconnect);
                            return;
                        }
                    }
                    // A locally oversized message is reported but does not kill the channel;
                    // nothing was written to it.
                    Err(error) => shared.emit(id, Event::Error { error }),
                },
                Some(IpcCommand::Disconnect) => {
                    shared.emit(id, Event::Disconnect);
                    return;
                }
                // The child task finished; no one is left to deliver to.
                None => return,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// One `Stdio` from a mode. `Fd` is duplicated (`dup`) so the caller's descriptor stays open.
fn make_stdio(mode: StdioMode) -> Result<Stdio, NodeError> {
    Ok(match mode {
        StdioMode::Pipe => Stdio::piped(),
        StdioMode::Ignore => Stdio::null(),
        StdioMode::Inherit => Stdio::inherit(),
        StdioMode::Fd(fd) => duplicate_fd(fd)?,
    })
}

fn duplicate_fd(fd: i32) -> Result<Stdio, NodeError> {
    // SAFETY: `dup(2)` only reads an integer descriptor and returns a new one; it shares no memory
    // with the caller and cannot unwind.
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return Err(NodeError::from_errno(last_errno(), "dup", None));
    }
    // SAFETY: `duplicate` is a freshly created descriptor, owned by this function alone, and the
    // `OwnedFd` takes exactly that ownership (it closes the descriptor on drop).
    let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(duplicate) };
    Ok(Stdio::from(owned))
}

/// Node's error for a failed `Command::spawn`. `ENOENT` reaches here for a missing program; that is
/// emitted asynchronously, never returned from [`ChildService::spawn`].
fn spawn_error(error: &io::Error, program: &Path) -> NodeError {
    match error.raw_os_error() {
        Some(_) => NodeError::system(error, "spawn", program),
        None => {
            let errno = match error.kind() {
                io::ErrorKind::NotFound => libc::ENOENT,
                io::ErrorKind::PermissionDenied => libc::EACCES,
                io::ErrorKind::InvalidInput => libc::EINVAL,
                _ => libc::EIO,
            };
            NodeError::from_errno(errno, "spawn", Some(program))
        }
    }
}

fn io_error(error: &io::Error, syscall: &'static str) -> NodeError {
    match error.raw_os_error() {
        Some(errno) => NodeError::from_errno(errno, syscall, None),
        None => NodeError::from_errno(libc::EIO, syscall, None),
    }
}

fn last_errno() -> i32 {
    io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

fn exit_parts(status: &ExitStatus) -> (Option<i32>, Option<i32>) {
    let code = status.code();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt as _;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal = None;
    (code, signal)
}

/// `Kill { signal }`: `libc::kill` on Unix. `Child::start_kill` is only SIGKILL, so it is used on
/// platforms without `kill(2)` and only for the two signals those platforms implement.
fn send_signal(child: &mut Child, pid: Option<u32>, signal: i32) {
    #[cfg(unix)]
    {
        let _ = child;
        if let Some(pid) = pid {
            // SAFETY: `kill(2)` takes two integers and shares no memory with the caller. The pid
            // belongs to a child this task has not reaped yet, so it cannot have been recycled.
            unsafe {
                libc::kill(pid as libc::pid_t, signal);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        // The non-Unix signal set is only SIGKILL and SIGTERM (m5-plan D51).
        if signal == 9 || signal == 15 {
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_split_across_pushes() {
        let frame = encode_frame(b"hello").expect("encode");
        assert_eq!(&frame[..4], &5u32.to_le_bytes());
        assert_eq!(&frame[4..], b"hello");

        let mut decoder = FrameDecoder::new();
        decoder.push(&frame[..2]);
        assert_eq!(decoder.next_frame().expect("partial"), None);
        decoder.push(&frame[2..]);
        assert_eq!(
            decoder.next_frame().expect("frame"),
            Some(b"hello".to_vec())
        );
        assert_eq!(decoder.next_frame().expect("drained"), None);
    }

    #[test]
    fn several_frames_in_one_push_are_delivered_in_order() {
        let mut bytes = encode_frame(b"one").expect("encode");
        bytes.extend_from_slice(&encode_frame(b"two").expect("encode"));
        let mut decoder = FrameDecoder::new();
        decoder.push(&bytes);
        assert_eq!(decoder.next_frame().expect("one"), Some(b"one".to_vec()));
        assert_eq!(decoder.next_frame().expect("two"), Some(b"two".to_vec()));
        assert_eq!(decoder.next_frame().expect("empty"), None);
    }

    #[test]
    fn an_oversized_length_prefix_is_rejected_before_buffering_the_frame() {
        let mut decoder = FrameDecoder::new();
        decoder.push(&(MAX_FRAME_SIZE + 1).to_le_bytes());
        let error = decoder.next_frame().expect_err("oversized frame");
        assert_eq!(error.code, "ERR_IPC_FRAME_TOO_LARGE");
    }

    #[test]
    fn an_oversized_payload_is_rejected_on_encode() {
        let payload = vec![0u8; MAX_FRAME_SIZE as usize + 1];
        let error = encode_frame(&payload).expect_err("oversized payload");
        assert_eq!(error.code, "ERR_IPC_FRAME_TOO_LARGE");
    }

    #[test]
    fn streams_report_node_names() {
        assert_eq!(Stream::Stdin.as_str(), "stdin");
        assert_eq!(Stream::Stdout.as_str(), "stdout");
        assert_eq!(Stream::Stderr.as_str(), "stderr");
    }

    #[test]
    fn the_read_cap_is_sixty_four_kilobytes() {
        assert_eq!(MAX_CHUNK, 65536);
    }

    /// H1/thread-safety: the service crosses the isolate/worker boundary and the protocol values
    /// cross threads, so they must be `Send + Sync` by construction.
    #[test]
    fn the_service_and_the_protocol_values_are_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ChildService>();
        assert_send_sync::<EventSink>();
        assert_send_sync::<ChildIdSource>();
        assert_send_sync::<Command>();
        assert_send_sync::<Event>();
        assert_send_sync::<SpawnOptions>();
        assert_send_sync::<IpcChannel>();
    }
}

// --- attached IPC (the forked child's side) ---------------------------------------------------

/// One event from an attached IPC channel.
#[derive(Debug)]
pub enum IpcEvent {
    /// One complete frame payload (the runtime parses it as JSON).
    Message(Vec<u8>),
    /// The peer closed the channel, or `disconnect()` closed it locally.
    Disconnect,
    /// A framing or I/O failure; the channel is closed afterwards.
    Error(NodeError),
}

/// Where an attached channel delivers events.
pub type IpcSink = Arc<dyn Fn(IpcEvent) + Send + Sync>;

/// The child end of a `fork` IPC pair, turned into a pair of tokio tasks.
///
/// `fork` gives the child one inherited descriptor ([`IPC_FD`]); this wraps it, frames outbound
/// payloads and emits one [`IpcEvent::Message`] per inbound frame. The session holds no JS state
/// and calls its sink from pool threads only (H1).
pub struct IpcSession {
    sender: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    stop: Arc<tokio::sync::Notify>,
    disconnected: Arc<AtomicBool>,
    _pool: Arc<Pool>,
}

impl IpcSession {
    /// Wrap `channel` and start the reader/writer tasks.
    pub fn attach(pool: Arc<Pool>, channel: IpcChannel, sink: IpcSink) -> Result<Self, NodeError> {
        channel
            .set_nonblocking(true)
            .map_err(|error| NodeError::system(&error, "fcntl", std::path::Path::new("")))?;
        let _guard = pool.handle().enter();
        let std_stream = channel.into_std();
        let stream = tokio::net::UnixStream::from_std(std_stream)
            .map_err(|error| NodeError::system(&error, "ipc", std::path::Path::new("")))?;
        let (mut reader, mut writer) = stream.into_split();
        let (send_tx, mut send_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let stop = Arc::new(tokio::sync::Notify::new());
        let disconnected = Arc::new(AtomicBool::new(false));

        {
            let sink = sink.clone();
            let stop = stop.clone();
            let disconnected = disconnected.clone();
            pool.handle().spawn(async move {
                let mut decoder = FrameDecoder::new();
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    tokio::select! {
                        _ = stop.notified() => break,
                        read = reader.read(&mut buffer) => {
                            match read {
                                Ok(0) => break,
                                Ok(count) => {
                                    decoder.push(&buffer[..count]);
                                    let mut failed = false;
                                    loop {
                                        match decoder.next_frame() {
                                            Ok(Some(payload)) => sink(IpcEvent::Message(payload)),
                                            Ok(None) => break,
                                            Err(error) => {
                                                sink(IpcEvent::Error(error));
                                                failed = true;
                                                break;
                                            }
                                        }
                                    }
                                    if failed {
                                        break;
                                    }
                                }
                                Err(error) => {
                                    sink(IpcEvent::Error(NodeError::system(
                                        &error,
                                        "ipc",
                                        std::path::Path::new(""),
                                    )));
                                    break;
                                }
                            }
                        }
                    }
                }
                if !disconnected.swap(true, Ordering::SeqCst) {
                    sink(IpcEvent::Disconnect);
                }
            });
        }

        {
            // The writer has no stop signal: `disconnect` drops the sender, and the writer drains
            // what is already queued before closing the socket. Stopping it first would drop the
            // last message, which is exactly what `process.send(...); process.disconnect()` does.
            let sink = sink.clone();
            pool.handle().spawn(async move {
                loop {
                    let payload = match send_rx.recv().await {
                        Some(payload) => payload,
                        None => break,
                    };
                    let frame = match encode_frame(&payload) {
                        Ok(frame) => frame,
                        Err(error) => {
                            sink(IpcEvent::Error(error));
                            break;
                        }
                    };
                    if let Err(error) = writer.write_all(&frame).await {
                        sink(IpcEvent::Error(NodeError::system(
                            &error,
                            "write",
                            std::path::Path::new(""),
                        )));
                        break;
                    }
                }
                let _ = writer.shutdown().await;
            });
        }

        Ok(IpcSession {
            sender: Mutex::new(Some(send_tx)),
            stop,
            disconnected,
            _pool: pool,
        })
    }

    /// Queue one payload frame. Errors when the channel has been disconnected.
    pub fn send(&self, payload: Vec<u8>) -> Result<(), NodeError> {
        let sender = lock(&self.sender);
        match sender.as_ref() {
            Some(sender) if !self.disconnected.load(Ordering::SeqCst) => sender
                .send(payload)
                .map_err(|_| NodeError::new("ERR_IPC_CHANNEL_CLOSED", "Channel closed")),
            _ => Err(NodeError::new("ERR_IPC_CHANNEL_CLOSED", "Channel closed")),
        }
    }

    /// Close the channel: queued frames flush, then the reader stops and emits one `Disconnect`.
    pub fn disconnect(&self) {
        let mut sender = lock(&self.sender);
        *sender = None;
        // Only the reader is stopped here; the writer notices the closed sender after draining.
        self.stop.notify_waiters();
    }
}

impl Drop for IpcSession {
    fn drop(&mut self) {
        self.disconnect();
    }
}

/// Turn the inherited descriptor into a [`tokio::net::UnixStream`] for [`IpcSession::attach`].
pub fn channel_from_raw_fd(fd: i32) -> Result<IpcChannel, NodeError> {
    if fd < 0 {
        return Err(NodeError::invalid_arg_value(
            "fd",
            &fd.to_string(),
            "is invalid",
        ));
    }
    // SAFETY: the caller promises this descriptor is the inherited IPC socket, still open and
    // owned by this process (verified by the `ONDE_IPC_FD` protocol). `from_raw_fd` takes
    // ownership, so the channel closes it when dropped.
    let stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
    Ok(IpcChannel::from_std(stream))
}
