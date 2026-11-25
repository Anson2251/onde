//! The op bridge: request ids, the completion table and the JS-side result conversion.
//!
//! The isolate thread is the only place a [`js::Value`] may exist. An async op therefore travels
//! as plain Rust data in both directions:
//!
//! 1. `host.fsAsync` parses the JS argument array into an [`ln_io::Op`] and submits it to the
//!    lazily created [`ln_io::Pool`] (see [`OpBridge::submit`]).
//! 2. The pool parks the finished [`ln_io::OpDone`] in [`OpBridge`]'s shared table and wakes the
//!    loop through the existing completion channel (`ln_sched::CompletionSender`).
//! 3. [`crate::Isolate`] takes the slot in the completion phase, converts it to a JS value on the
//!    isolate thread and calls `__ln_op_done`; the scheduler checkpoint follows as usual.
//!
//! Two invariants from ADR-0005 live here:
//!
//! * **O3** — a submitted op holds exactly one external loop ref until its slot is taken, so the
//!   loop cannot exit while I/O is in flight.
//! * **O6** — the sync forms never touch the pool or the loop; they call [`ln_io::execute`]
//!   directly on the isolate thread.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ln_engine::js;
use ln_error::NodeError;
use ln_io::{DirEntry, FileKind, Op, OpDone, OpValue, Pool, RequestId, Sink, Stat, StatFs};
use ln_sched::{Completion, CompletionSender, Driver};

/// The single [`RequestId`] sequence of one isolate (ADR-0006 §2.1).
///
/// It backs **both** op ids and handle ids: JavaScript asks for ids through
/// `host.nextRequestId()`, and a pool task that mints a handle itself (an accepted connection)
/// calls the [`ln_io::net::HandleIdSource`] closure built from the same allocator. There is
/// therefore exactly one sequence per isolate and an id in a `Completion` is never ambiguous.
///
/// It is `Arc`-shared and atomic because the pool threads allocate ids for accepted connections
/// while the isolate thread allocates op ids. `AtomicU64::fetch_add` makes the unique, gap-free
/// property hold across threads; ids start at 1 so `0` can mean "no id".
#[derive(Debug)]
pub struct RequestIdAllocator {
    next: AtomicU64,
}

impl Default for RequestIdAllocator {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestIdAllocator {
    pub fn new() -> Self {
        RequestIdAllocator {
            next: AtomicU64::new(1),
        }
    }

    /// The next unused id.
    pub fn allocate(&self) -> RequestId {
        self.next.fetch_add(1, Ordering::SeqCst)
    }

    /// Keep the sequence ahead of an id minted outside this allocator.
    ///
    /// Everything allocates through this type now, so this is only needed for ids that entered
    /// the runtime from elsewhere (tests, a replayed completion). It is atomic and never moves
    /// the sequence backwards.
    pub fn observe(&self, id: RequestId) {
        self.next.fetch_max(id.saturating_add(1), Ordering::SeqCst);
    }
}

/// The id carried by an [`OpDone`], which is also the key of its slot.
pub(crate) fn done_id(done: &OpDone) -> RequestId {
    match done {
        OpDone::Ok { id, .. } | OpDone::Err { id, .. } | OpDone::Aborted { id } => *id,
    }
}

fn pool_error(error: &io::Error) -> NodeError {
    // An onde-specific code: the pool is a runtime resource, not a Node API. It is delivered like
    // any other async failure so a callback gets it instead of a synchronous throw.
    NodeError::new(
        "ERR_IO_POOL",
        format!("Failed to create the I/O thread pool: {error}"),
    )
}

/// The shared op state: the pool, the result slots and the abort flags.
///
/// Lives on the isolate thread. The pool threads only see the [`Sink`], which owns an `Arc` of
/// the slot table and a `Mutex`ed [`CompletionSender`] (`CompletionSender` is not `Sync`, and the
/// sink must be).
pub(crate) struct OpBridge {
    /// The isolate's single id sequence, shared with the handle table.
    ids: Arc<RequestIdAllocator>,
    /// Filled by a pool thread, drained by the isolate thread.
    results: Arc<Mutex<HashMap<RequestId, OpDone>>>,
    /// Cooperative cancellation flags, keyed by request id.
    aborts: RefCell<HashMap<RequestId, Arc<AtomicBool>>>,
    /// When each in-flight op was submitted, with its name, for `--trace-events`/`--timing`.
    /// One small entry per op in flight, removed when the slot is taken, so it cannot outlive the
    /// op; the turn loop never touches it, which is what keeps diagnostics free when they are off.
    starts: RefCell<HashMap<RequestId, (&'static str, std::time::Instant)>>,
    driver: std::rc::Rc<RefCell<Driver>>,
    /// Wakes the loop after a result is parked. Also used by the immediate rejection path.
    sender: Mutex<CompletionSender>,
    /// Created on the first async op or network handle, never at boot (ADR-0005 §9). `Arc`
    /// because `NetService` (M4) shares the one runtime with the ops (ADR-0006 §5).
    pool: OnceLock<Result<Arc<Pool>, io::Error>>,
    io_threads: usize,
    /// Submitted-but-not-yet-dispatched ops. Kept for diagnostics/tests.
    pending: Cell<usize>,
    /// The closure the pool calls. Built here because it must capture the table and the sender.
    sink: Sink,
}

impl OpBridge {
    pub(crate) fn new(
        driver: std::rc::Rc<RefCell<Driver>>,
        sender: CompletionSender,
        io_threads: usize,
        ids: Arc<RequestIdAllocator>,
    ) -> Self {
        let results: Arc<Mutex<HashMap<RequestId, OpDone>>> = Arc::new(Mutex::new(HashMap::new()));
        let sink_results = results.clone();
        let sink_sender = Mutex::new(sender.clone());
        let sink: Sink = Arc::new(move |done: OpDone| {
            let id = done_id(&done);
            sink_results
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(id, done);
            // The receiver may be gone if the isolate was dropped; nothing to wake then.
            let _ = sink_sender
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .send(Completion(id));
        });

        OpBridge {
            ids,
            results,
            aborts: RefCell::new(HashMap::new()),
            starts: RefCell::new(HashMap::new()),
            driver,
            sender: Mutex::new(sender),
            pool: OnceLock::new(),
            io_threads,
            pending: Cell::new(0),
            sink,
        }
    }

    /// Submit `op` under the JavaScript-allocated `id`.
    ///
    /// Takes one external loop ref. If the pool cannot be created the op is rejected through the
    /// normal completion path and the ref is released immediately: no pool thread will ever run,
    /// so nothing else can release it.
    /// The isolate's id sequence, for the handle table's `HandleIdSource`.
    pub(crate) fn ids(&self) -> &Arc<RequestIdAllocator> {
        &self.ids
    }

    /// The process-wide pool, created on first use and never at boot.
    ///
    /// `NetService` is built on top of it so ops and handles share one tokio runtime
    /// (ADR-0006 §5); the failure shape is the same `ERR_IO_POOL` the op path reports.
    pub(crate) fn pool(&self) -> Result<Arc<Pool>, NodeError> {
        match self
            .pool
            .get_or_init(|| Pool::new(self.io_threads).map(Arc::new))
        {
            Ok(pool) => Ok(pool.clone()),
            Err(error) => Err(pool_error(error)),
        }
    }

    pub(crate) fn submit(&self, id: RequestId, op: Op) {
        self.starts
            .borrow_mut()
            .insert(id, (op.name(), std::time::Instant::now()));
        self.ids.observe(id);
        let abort = Arc::new(AtomicBool::new(false));
        self.aborts.borrow_mut().insert(id, abort.clone());
        self.driver.borrow_mut().ref_external();
        self.pending.set(self.pending.get() + 1);

        let pool = match self.pool() {
            Ok(pool) => pool,
            Err(error) => {
                // No pool thread will ever run, so park the failure directly. The slot still owns
                // the external ref taken above: the completion phase takes the slot and releases
                // it exactly once (O3). Releasing it here as well would unref a different live
                // handle and could let the loop exit with another op in flight.
                self.park(OpDone::Err { id, error });
                return;
            }
        };
        pool.submit(id, op, abort, self.sink.clone());
    }

    /// Set the abort flag for `id`. Unknown ids are ignored (the op already settled).
    pub(crate) fn cancel(&self, id: RequestId) {
        if let Some(flag) = self.aborts.borrow_mut().remove(&id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// Take the parked result for `id`, if the completion has arrived.
    ///
    /// The caller releases the external ref after a successful take; a missing slot means the
    /// completion was already dispatched (or never existed), so it must not release another ref.
    /// When `id` was submitted, if diagnostics were on for it. Consumed by the completion path.
    pub(crate) fn take_start(&self, id: RequestId) -> Option<(&'static str, std::time::Instant)> {
        self.starts.borrow_mut().remove(&id)
    }

    pub(crate) fn take(&self, id: RequestId) -> Option<OpDone> {
        let done = self
            .results
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&id);
        if done.is_some() {
            self.drop_slot(id);
        }
        done
    }

    /// Drop every parked result at shutdown. Returns how many refs the caller must release.
    pub(crate) fn discard_pending(&self) -> usize {
        let count = {
            let mut results = self
                .results
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let count = results.len();
            results.clear();
            count
        };
        self.aborts.borrow_mut().clear();
        self.pending.set(self.pending.get().saturating_sub(count));
        count
    }

    /// Number of submitted ops whose slot has not been taken yet.
    pub(crate) fn pending(&self) -> usize {
        self.pending.get()
    }

    /// Forget the abort flag and count for a slot that will never be dispatched again. The loop
    /// ref is released by the caller because only it knows whether the ref is still held.
    fn drop_slot(&self, id: RequestId) {
        self.aborts.borrow_mut().remove(&id);
        self.pending.set(self.pending.get().saturating_sub(1));
    }

    fn park(&self, done: OpDone) {
        let id = done_id(&done);
        self.results
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(id, done);
        let _ = self
            .sender
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .send(Completion(id));
    }
}

// --- result conversion (isolate thread only) -------------------------------------------------

/// Convert an [`OpValue`] into the JS value the surface expects.
pub(crate) fn op_value_to_js<'js>(
    ctx: &js::Ctx<'js>,
    value: &OpValue,
) -> js::Result<js::Value<'js>> {
    match value {
        OpValue::Unit => Ok(js::Value::new_undefined(ctx.clone())),
        OpValue::Fd(fd) => Ok(js::Value::new_int(ctx.clone(), *fd)),
        OpValue::Count(count) => Ok(js::Value::new_number(ctx.clone(), *count as f64)),
        OpValue::Bytes(bytes) => {
            // `as_slice`, not `clone()`: the engine copies into its own ArrayBuffer either way, and
            // cloning the Vec first copied the payload twice. On a 10 MB read that second copy was
            // measurable against Node (m7-plan §4.7, D36).
            Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes.as_slice())?.into_value())
        }
        OpValue::Text(text) => Ok(js::String::from_str(ctx.clone(), text)?.into_value()),
        OpValue::Stat(stat) => stat_to_js(ctx, stat),
        OpValue::StatFs(fs) => statfs_to_js(ctx, fs),
        OpValue::Dir(entries) => dir_to_js(ctx, entries),
        OpValue::Addrs(addrs) => addrs_to_js(ctx, addrs),
    }
}

/// `dns.lookup`'s result shape: an array of `{ address, family }` with the family as Node's
/// numeric `4`/`6` (unlike `socket.address()`, which uses `"IPv4"`). The JS layer picks the first
/// entry for the non-`all` callback form.
///
/// `ln_io::Addr` rather than `ln_io::net::Addr`: the `dns` module lives behind `node-net`, but the
/// op-value shape is part of the always-compiled op protocol, so the address type moved to the
/// crate root.
fn addrs_to_js<'js>(ctx: &js::Ctx<'js>, addrs: &[ln_io::Addr]) -> js::Result<js::Value<'js>> {
    let array = js::Array::new(ctx.clone())?;
    for (index, addr) in addrs.iter().enumerate() {
        let object = js::Object::new(ctx.clone())?;
        match addr {
            ln_io::Addr::Ip(address) => {
                object.set("address", address.ip().to_string())?;
                object.set("family", if address.is_ipv4() { 4 } else { 6 })?;
            }
            ln_io::Addr::Unix(path) => {
                object.set("address", path.to_string_lossy().into_owned())?;
                object.set("family", "unix")?;
            }
        }
        array.set(index, object)?;
    }
    Ok(array.into_value())
}

fn stat_to_js<'js>(ctx: &js::Ctx<'js>, stat: &Stat) -> js::Result<js::Value<'js>> {
    let object = js::Object::new(ctx.clone())?;
    // The JS `Stats` class adds the `Date` getters; the host reports epoch milliseconds.
    object.set("dev", stat.dev)?;
    object.set("ino", stat.ino)?;
    object.set("mode", stat.mode)?;
    object.set("nlink", stat.nlink)?;
    object.set("uid", stat.uid)?;
    object.set("gid", stat.gid)?;
    object.set("rdev", stat.rdev)?;
    object.set("size", stat.size)?;
    object.set("blksize", stat.blksize)?;
    object.set("blocks", stat.blocks)?;
    object.set("atimeMs", stat.atime_ms)?;
    object.set("mtimeMs", stat.mtime_ms)?;
    object.set("ctimeMs", stat.ctime_ms)?;
    object.set("birthtimeMs", stat.birthtime_ms)?;
    Ok(object.into_value())
}

fn statfs_to_js<'js>(ctx: &js::Ctx<'js>, fs: &StatFs) -> js::Result<js::Value<'js>> {
    let object = js::Object::new(ctx.clone())?;
    // Node's key is `type`; `kind` is the Rust-side name (see `ln_io::StatFs`).
    object.set("type", fs.kind)?;
    object.set("bsize", fs.bsize)?;
    object.set("frsize", fs.frsize)?;
    object.set("blocks", fs.blocks)?;
    object.set("bfree", fs.bfree)?;
    object.set("bavail", fs.bavail)?;
    object.set("files", fs.files)?;
    object.set("ffree", fs.ffree)?;
    Ok(object.into_value())
}

fn dir_to_js<'js>(ctx: &js::Ctx<'js>, entries: &[DirEntry]) -> js::Result<js::Value<'js>> {
    let array = js::Array::new(ctx.clone())?;
    for (index, entry) in entries.iter().enumerate() {
        let object = js::Object::new(ctx.clone())?;
        object.set("name", entry.name.as_str())?;
        object.set("kind", file_kind_code(entry.kind))?;
        array.set(index, object)?;
    }
    Ok(array.into_value())
}

/// The numeric `kind` from `docs/m3-plan.md` §2.2.
fn file_kind_code(kind: FileKind) -> u8 {
    match kind {
        FileKind::Unknown => 0,
        FileKind::File => 1,
        FileKind::Dir => 2,
        FileKind::Symlink => 3,
        FileKind::Fifo => 4,
        FileKind::Socket => 5,
        FileKind::CharDevice => 6,
        FileKind::BlockDevice => 7,
    }
}

// --- JS argument parsing ----------------------------------------------------------------------

/// Build an [`Op`] from the `(name, args)` pair `host.fsSync`/`host.fsAsync` received.
///
/// `null` and `undefined` mean "argument omitted" for optional positions; every required
/// argument produces a Node-shaped `ERR_INVALID_ARG_TYPE` when it is missing or has the wrong
/// type. Defaults mirror the ones Node applies in `js/lib/internal/fs.js`, so a direct
/// `__ln_host.fsSync` call behaves like the public surface.
pub(crate) fn build_op<'js>(name: &str, args: &[js::Value<'js>]) -> Result<Op, NodeError> {
    match name {
        "readFile" => Ok(Op::ReadFile {
            path: path_arg(args, 0, "path")?,
        }),
        "writeFile" | "appendFile" => {
            let path = path_arg(args, 0, "path")?;
            let data = crate::args::bytes(optional(args, 1), "data")?;
            let mode = optional_u32(args, 2, "mode", 0o666)?;
            let default_flags = default_write_flags(name == "appendFile");
            let flags = optional_i32(args, 3, "flags", default_flags)?;
            Ok(if name == "appendFile" {
                Op::AppendFile {
                    path,
                    data,
                    mode,
                    flags,
                }
            } else {
                Op::WriteFile {
                    path,
                    data,
                    mode,
                    flags,
                }
            })
        }
        "copyFile" => Ok(Op::CopyFile {
            src: path_arg(args, 0, "src")?,
            dst: path_arg(args, 1, "dest")?,
            flags: optional_u32(args, 2, "mode", 0)?,
        }),
        "mkdir" => Ok(Op::Mkdir {
            path: path_arg(args, 0, "path")?,
            mode: optional_u32(args, 1, "mode", 0o777)?,
            recursive: optional_bool(args, 2, "recursive", false)?,
        }),
        "mkdtemp" => Ok(Op::Mkdtemp {
            prefix: path_arg(args, 0, "prefix")?,
        }),
        "readdir" => Ok(Op::Readdir {
            path: path_arg(args, 0, "path")?,
            with_types: optional_bool(args, 1, "withFileTypes", false)?,
        }),
        "rm" => Ok(Op::Rm {
            path: path_arg(args, 0, "path")?,
            recursive: optional_bool(args, 1, "recursive", false)?,
            force: optional_bool(args, 2, "force", false)?,
            max_retries: optional_u32(args, 3, "maxRetries", 0)?,
            retry_delay_ms: optional_u64(args, 4, "retryDelay", 0)?,
        }),
        "rmdir" => {
            let path = path_arg(args, 0, "path")?;
            if optional_bool(args, 1, "recursive", false)? {
                // The single-directory syscall cannot express `{ recursive: true }`; the
                // recursive form is the `rm` op with `rm -r` semantics.
                Ok(Op::Rm {
                    path,
                    recursive: true,
                    force: false,
                    max_retries: 0,
                    retry_delay_ms: 0,
                })
            } else {
                Ok(Op::Rmdir { path })
            }
        }
        "unlink" => Ok(Op::Unlink {
            path: path_arg(args, 0, "path")?,
        }),
        "readlink" => Ok(Op::Readlink {
            path: path_arg(args, 0, "path")?,
        }),
        "rename" => Ok(Op::Rename {
            from: path_arg(args, 0, "oldPath")?,
            to: path_arg(args, 1, "newPath")?,
        }),
        "stat" | "lstat" => Ok(Op::Stat {
            path: path_arg(args, 0, "path")?,
            follow: name == "stat",
        }),
        "fstat" => Ok(Op::Fstat {
            fd: fd_arg(args, 0)?,
        }),
        "statfs" => Ok(Op::Statfs {
            path: path_arg(args, 0, "path")?,
        }),
        "access" => Ok(Op::Access {
            path: path_arg(args, 0, "path")?,
            mode: optional_i32(args, 1, "mode", 0)?,
        }),
        "chmod" => Ok(Op::Chmod {
            path: path_arg(args, 0, "path")?,
            mode: crate::args::u32_value(optional(args, 1), "mode")?,
            follow: optional_bool(args, 2, "follow", true)?,
        }),
        "chown" => Ok(Op::Chown {
            path: path_arg(args, 0, "path")?,
            uid: crate::args::u32_value(optional(args, 1), "uid")?,
            gid: crate::args::u32_value(optional(args, 2), "gid")?,
            follow: optional_bool(args, 3, "follow", true)?,
        }),
        "truncate" => Ok(Op::Truncate {
            path: path_arg(args, 0, "path")?,
            len: crate::args::u64_value(optional(args, 1), "len")?,
        }),
        "ftruncate" => Ok(Op::Ftruncate {
            fd: fd_arg(args, 0)?,
            len: crate::args::u64_value(optional(args, 1), "len")?,
        }),
        "symlink" => Ok(Op::Symlink {
            target: path_arg(args, 0, "target")?,
            path: path_arg(args, 1, "path")?,
        }),
        "link" => Ok(Op::Link {
            existing: path_arg(args, 0, "existingPath")?,
            new_path: path_arg(args, 1, "newPath")?,
        }),
        "realpath" => Ok(Op::Realpath {
            path: path_arg(args, 0, "path")?,
        }),
        "utimes" => Ok(Op::Utimes {
            path: path_arg(args, 0, "path")?,
            atime_ms: crate::args::number(optional(args, 1), "atime")?,
            mtime_ms: crate::args::number(optional(args, 2), "mtime")?,
            follow: optional_bool(args, 3, "follow", true)?,
        }),
        "open" => Ok(Op::Open {
            path: path_arg(args, 0, "path")?,
            flags: optional_i32(args, 1, "flags", default_open_flags())?,
            mode: optional_u32(args, 2, "mode", 0o666)?,
        }),
        "close" => Ok(Op::Close {
            fd: fd_arg(args, 0)?,
        }),
        "read" => Ok(Op::Read {
            fd: fd_arg(args, 0)?,
            length: crate::args::u32_value(optional(args, 1), "length")?,
            position: optional_i64(args, 2, "position", -1)?,
        }),
        "write" => Ok(Op::Write {
            fd: fd_arg(args, 0)?,
            data: crate::args::bytes(optional(args, 1), "buffer")?,
            position: optional_i64(args, 2, "position", -1)?,
        }),
        "fsync" => Ok(Op::Fsync {
            fd: fd_arg(args, 0)?,
        }),
        "fdatasync" => Ok(Op::Fdatasync {
            fd: fd_arg(args, 0)?,
        }),
        "fchmod" => Ok(Op::Fchmod {
            fd: fd_arg(args, 0)?,
            mode: crate::args::u32_value(optional(args, 1), "mode")?,
        }),
        "fchown" => Ok(Op::Fchown {
            fd: fd_arg(args, 0)?,
            uid: crate::args::u32_value(optional(args, 1), "uid")?,
            gid: crate::args::u32_value(optional(args, 2), "gid")?,
        }),
        "futimes" => Ok(Op::Futimes {
            fd: fd_arg(args, 0)?,
            atime_ms: crate::args::number(optional(args, 1), "atime")?,
            mtime_ms: crate::args::number(optional(args, 2), "mtime")?,
        }),
        other => Err(NodeError::invalid_arg_value(
            "name",
            other,
            "is not a filesystem operation",
        )),
    }
}

fn optional<'a, 'js>(args: &'a [js::Value<'js>], index: usize) -> Option<&'a js::Value<'js>> {
    args.get(index)
        .filter(|value| !value.is_undefined() && !value.is_null())
}

fn path_arg<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
) -> Result<PathBuf, NodeError> {
    Ok(PathBuf::from(crate::args::string(
        optional(args, index),
        argument,
    )?))
}

fn fd_arg<'js>(args: &[js::Value<'js>], index: usize) -> Result<i32, NodeError> {
    crate::args::i32_value(optional(args, index), "fd")
}

fn optional_bool<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: bool,
) -> Result<bool, NodeError> {
    match optional(args, index) {
        Some(_) => crate::args::bool_value(optional(args, index), argument),
        None => Ok(default),
    }
}

fn optional_u32<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: u32,
) -> Result<u32, NodeError> {
    match optional(args, index) {
        Some(_) => crate::args::u32_value(optional(args, index), argument),
        None => Ok(default),
    }
}

fn optional_u64<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: u64,
) -> Result<u64, NodeError> {
    match optional(args, index) {
        Some(_) => crate::args::u64_value(optional(args, index), argument),
        None => Ok(default),
    }
}

fn optional_i32<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: i32,
) -> Result<i32, NodeError> {
    match optional(args, index) {
        Some(_) => crate::args::i32_value(optional(args, index), argument),
        None => Ok(default),
    }
}

fn optional_i64<'js>(
    args: &[js::Value<'js>],
    index: usize,
    argument: &str,
    default: i64,
) -> Result<i64, NodeError> {
    match optional(args, index) {
        Some(_) => crate::args::i64_value(optional(args, index), argument),
        None => Ok(default),
    }
}

/// `O_WRONLY | O_CREAT | O_TRUNC`, or `+ O_APPEND` for `appendFile`.
#[cfg(unix)]
fn default_write_flags(append: bool) -> i32 {
    let flags = libc::O_WRONLY | libc::O_CREAT;
    if append {
        flags | libc::O_APPEND
    } else {
        flags | libc::O_TRUNC
    }
}

#[cfg(not(unix))]
fn default_write_flags(append: bool) -> i32 {
    let _ = append;
    0
}

/// `O_RDONLY`; callers that open for writing pass numeric flags explicitly.
#[cfg(unix)]
fn default_open_flags() -> i32 {
    libc::O_RDONLY
}

#[cfg(not(unix))]
fn default_open_flags() -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use ln_engine::Engine;
    use std::path::Path;

    fn with_ctx<R>(f: impl FnOnce(js::Ctx<'_>) -> R) -> R {
        let engine = Engine::new().expect("engine");
        engine.with_ctx(f)
    }

    #[test]
    fn request_ids_start_at_one_and_never_repeat() {
        let ids = RequestIdAllocator::new();
        assert_eq!(ids.allocate(), 1);
        assert_eq!(ids.allocate(), 2);
        ids.observe(10);
        assert_eq!(ids.allocate(), 11);
        ids.observe(2);
        assert_eq!(ids.allocate(), 12);
    }

    /// ADR-0006 §2.1: one atomic sequence backs op ids (isolate thread) and handle ids (pool
    /// threads). Eight threads minting 10k ids each must produce 80k unique, non-zero ids; a
    /// `Cell`-era allocator fails this by construction.
    #[test]
    fn the_id_sequence_is_atomic_across_threads() {
        let ids = Arc::new(RequestIdAllocator::new());
        let mut threads = Vec::new();
        for _ in 0..8 {
            let ids = ids.clone();
            threads.push(std::thread::spawn(move || {
                let mut minted = Vec::with_capacity(10_000);
                for _ in 0..10_000 {
                    minted.push(ids.allocate());
                }
                minted
            }));
        }
        let mut all = Vec::with_capacity(80_000);
        for thread in threads {
            all.extend(thread.join().expect("id thread"));
        }
        assert!(all.iter().all(|id| *id != 0), "0 means \"no id\"");
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 80_000, "an id was handed out twice");
    }

    #[test]
    fn the_allocator_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<RequestIdAllocator>();
    }

    #[test]
    fn parses_read_file() {
        with_ctx(|ctx| {
            let path = js::String::from_str(ctx.clone(), "Cargo.toml")
                .expect("string")
                .into_value();
            let op = build_op("readFile", &[path]).expect("op");
            assert!(matches!(op, Op::ReadFile { path } if path == Path::new("Cargo.toml")));
        });
    }

    #[test]
    fn parses_write_file_bytes_and_defaults() {
        with_ctx(|ctx| {
            let path = js::String::from_str(ctx.clone(), "out.txt")
                .expect("string")
                .into_value();
            let data = js::TypedArray::<u8>::new(ctx.clone(), vec![7_u8, 8, 9])
                .expect("typed array")
                .into_value();
            let op = build_op("writeFile", &[path, data]).expect("op");
            match op {
                Op::WriteFile {
                    data, mode, flags, ..
                } => {
                    assert_eq!(data, vec![7, 8, 9]);
                    assert_eq!(mode, 0o666);
                    assert_ne!(flags, 0);
                }
                other => panic!("unexpected op: {other:?}"),
            }
        });
    }

    #[test]
    fn null_optional_arguments_use_defaults() {
        with_ctx(|ctx| {
            let path = js::String::from_str(ctx.clone(), "x")
                .expect("string")
                .into_value();
            let null = js::Value::new_null(ctx.clone());
            let op = build_op("mkdir", &[path, null.clone(), null]).expect("op");
            assert!(matches!(
                op,
                Op::Mkdir {
                    recursive: false,
                    mode: 0o777,
                    ..
                }
            ));
        });
    }

    #[test]
    fn uint8_arrays_are_accepted_from_a_buffer_like_view() {
        with_ctx(|ctx| {
            let array =
                js::TypedArray::<u8>::new(ctx.clone(), vec![1_u8, 2, 3]).expect("typed array");
            let value = array.into_value();
            assert_eq!(
                crate::args::bytes(Some(&value), "data").expect("bytes"),
                vec![1, 2, 3]
            );
        });
    }

    /// O1 is enforced by the types at the sink: only payloads that are `Send` can cross the
    /// thread boundary, so a `JSValue` (which is not `Send`) can never be part of an op or a
    /// completion. This is the positive half of that assertion; the negative half is a compile
    /// error rather than a runtime test.
    #[test]
    fn op_payloads_are_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Op>();
        assert_send::<OpValue>();
        assert_send::<OpDone>();
        assert_send::<ln_io::Stat>();
        assert_send::<ln_io::DirEntry>();
    }

    /// O3: one external loop ref is taken at submit and released only when the completion slot
    /// is taken. The bridge is exercised against the real pool here (rather than a fake) because
    /// that is the thread boundary the invariant is about.
    #[test]
    fn submit_holds_one_external_ref_until_the_slot_is_taken() {
        use ln_sched::{ChannelReactor, Reactor};
        use std::rc::Rc;
        use std::time::Duration;

        let driver = Rc::new(RefCell::new(Driver::new()));
        let (mut reactor, sender) = ChannelReactor::new();
        let ids = Arc::new(RequestIdAllocator::new());
        let bridge = OpBridge::new(driver.clone(), sender, 2, ids);
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");

        bridge.submit(7, Op::ReadFile { path });
        assert_eq!(bridge.pending(), 1);
        assert_eq!(driver.borrow().refs(), 1);

        let completions = reactor.wait(Some(Duration::from_secs(10)));
        assert_eq!(completions, vec![Completion(7)]);

        let done = bridge.take(7).expect("completion parked");
        driver.borrow_mut().unref_external();
        assert_eq!(bridge.pending(), 0);
        assert_eq!(driver.borrow().refs(), 0);

        match done {
            OpDone::Ok {
                value: OpValue::Bytes(bytes),
                ..
            } => assert!(!bytes.is_empty()),
            other => panic!("unexpected completion: {other:?}"),
        }
    }
}
