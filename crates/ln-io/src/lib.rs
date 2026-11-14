//! Blocking filesystem ops and the tokio offload pool.
//!
//! `ln-io` is the only crate that knows about threads. It never sees a JS value: an [`Op`] is
//! plain Rust, [`OpValue`] is plain Rust, and [`OpDone`] is what travels back to the isolate
//! thread. The isolate thread calls [`execute`] for the `fs` sync forms and [`Pool::submit`] for
//! everything else; the pool parks the result via the sink, which wakes the loop.
//!
//! The public types in this file are the M3 contract shared with `ln-runtime` and with the plan
//! in `docs/m3-plan.md`. Extend them, do not rename them.

use std::ffi::CString;
use std::fs;
use std::io;
use std::mem::ManuallyDrop;
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ln_error::{errno_code, errno_message, NodeError};

/// Identifies one async op for its lifetime. Allocated by `ln-runtime`.
pub type RequestId = u64;

/// The `kind` of a directory entry, mirroring `DirEntry`'s type bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Unknown,
    File,
    Dir,
    Symlink,
    Fifo,
    Socket,
    CharDevice,
    BlockDevice,
}

/// `fs.Stats` fields, already in JS-friendly units (unix epoch milliseconds for times).
#[derive(Debug, Clone, PartialEq)]
pub struct Stat {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub nlink: u64,
    pub uid: u32,
    pub gid: u32,
    pub rdev: u64,
    pub size: u64,
    pub blksize: u64,
    pub blocks: u64,
    pub atime_ms: f64,
    pub mtime_ms: f64,
    pub ctime_ms: f64,
    /// Linux has no birth time in `std`; report `ctime` there, as Node does.
    pub birthtime_ms: f64,
}

/// `fs.statfs` fields. Node's object calls the first one `type`; Rust cannot, so it is `kind`
/// here and renamed by `ln-runtime` at the JS boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatFs {
    pub kind: u64,
    pub bsize: u64,
    pub frsize: u64,
    pub blocks: u64,
    pub bfree: u64,
    pub bavail: u64,
    pub files: u64,
    pub ffree: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: FileKind,
}

/// The result of one op. Never contains a JS value.
#[derive(Debug, Clone, PartialEq)]
pub enum OpValue {
    Unit,
    /// An OS file descriptor (`open`, `dup`). Node exposes these numbers directly.
    Fd(i32),
    /// A byte count (`write`, `read` length).
    Count(u64),
    /// Raw bytes (`readFile`, `readlink`, `read`).
    Bytes(Vec<u8>),
    /// A path string (`mkdtemp`, `realpath`, `mkdir --recursive`'s first created path).
    Text(String),
    Stat(Stat),
    StatFs(StatFs),
    Dir(Vec<DirEntry>),
}

/// One filesystem capability. Paths are UTF-8 strings by the time they reach this layer: the JS
/// surface normalizes `URL` and `Buffer` arguments before calling the host.
#[derive(Debug)]
pub enum Op {
    ReadFile {
        path: PathBuf,
    },
    WriteFile {
        path: PathBuf,
        data: Vec<u8>,
        mode: u32,
        /// Numeric `O_*` flags (already normalized from Node's string flags by the JS layer).
        flags: i32,
    },
    AppendFile {
        path: PathBuf,
        data: Vec<u8>,
        mode: u32,
        flags: i32,
    },
    CopyFile {
        src: PathBuf,
        dst: PathBuf,
        flags: u32,
    },
    Mkdir {
        path: PathBuf,
        mode: u32,
        recursive: bool,
    },
    Mkdtemp {
        prefix: PathBuf,
    },
    Readdir {
        path: PathBuf,
        with_types: bool,
    },
    Rm {
        path: PathBuf,
        recursive: bool,
        force: bool,
        max_retries: u32,
        retry_delay_ms: u64,
    },
    Rmdir {
        path: PathBuf,
    },
    Unlink {
        path: PathBuf,
    },
    Rename {
        from: PathBuf,
        to: PathBuf,
    },
    Stat {
        path: PathBuf,
        follow: bool,
    },
    Statfs {
        path: PathBuf,
    },
    Fstat {
        fd: i32,
    },
    Access {
        path: PathBuf,
        mode: i32,
    },
    Chmod {
        path: PathBuf,
        mode: u32,
        follow: bool,
    },
    Chown {
        path: PathBuf,
        uid: u32,
        gid: u32,
        follow: bool,
    },
    Truncate {
        path: PathBuf,
        len: u64,
    },
    Ftruncate {
        fd: i32,
        len: u64,
    },
    Readlink {
        path: PathBuf,
    },
    Symlink {
        target: PathBuf,
        path: PathBuf,
    },
    Link {
        existing: PathBuf,
        new_path: PathBuf,
    },
    Realpath {
        path: PathBuf,
    },
    Utimes {
        path: PathBuf,
        atime_ms: f64,
        mtime_ms: f64,
        follow: bool,
    },
    Open {
        path: PathBuf,
        flags: i32,
        mode: u32,
    },
    Close {
        fd: i32,
    },
    Read {
        fd: i32,
        length: u32,
        /// `-1` reads at the current offset (Node's `position: null`).
        position: i64,
    },
    Write {
        fd: i32,
        data: Vec<u8>,
        /// `-1` writes at the current offset.
        position: i64,
    },
    Fsync {
        fd: i32,
    },
    Fdatasync {
        fd: i32,
    },
    Fchmod {
        fd: i32,
        mode: u32,
    },
    Fchown {
        fd: i32,
        uid: u32,
        gid: u32,
    },
    Futimes {
        fd: i32,
        atime_ms: f64,
        mtime_ms: f64,
    },
}

impl Op {
    /// The `syscall` property Node puts on the error (`open`, `read`, `stat`, ...).
    pub fn syscall(&self) -> &'static str {
        match self {
            Op::ReadFile { .. }
            | Op::WriteFile { .. }
            | Op::AppendFile { .. }
            | Op::Open { .. } => "open",
            Op::CopyFile { .. } => "copyfile",
            Op::Mkdir { .. } => "mkdir",
            Op::Mkdtemp { .. } => "mkdtemp",
            Op::Readdir { .. } => "readdir",
            Op::Rm { .. } => "rm",
            Op::Rmdir { .. } => "rmdir",
            Op::Unlink { .. } => "unlink",
            Op::Rename { .. } => "rename",
            Op::Stat { follow, .. } => {
                if *follow {
                    "stat"
                } else {
                    "lstat"
                }
            }
            Op::Fstat { .. } => "fstat",
            Op::Access { .. } => "access",
            Op::Chmod { follow, .. } => {
                if *follow {
                    "chmod"
                } else {
                    "lchmod"
                }
            }
            Op::Chown { follow, .. } => {
                if *follow {
                    "chown"
                } else {
                    "lchown"
                }
            }
            Op::Truncate { .. } => "truncate",
            Op::Ftruncate { .. } => "ftruncate",
            Op::Readlink { .. } => "readlink",
            Op::Symlink { .. } => "symlink",
            Op::Link { .. } => "link",
            Op::Realpath { .. } => "realpath",
            Op::Utimes { follow, .. } => {
                if *follow {
                    "utimes"
                } else {
                    "lutimes"
                }
            }
            Op::Statfs { .. } => "statfs",
            Op::Close { .. } => "close",
            Op::Read { .. } => "read",
            Op::Write { .. } => "write",
            Op::Fsync { .. } => "fsync",
            Op::Fdatasync { .. } => "fdatasync",
            Op::Fchmod { .. } => "fchmod",
            Op::Fchown { .. } => "fchown",
            Op::Futimes { .. } => "futimes",
        }
    }

    /// Execute on the current thread. This is the sync `fs` path and the body of the pool work.
    ///
    /// Implementations must re-check `abort` before and after the syscall when they can leave a
    /// resource behind (an fd): aborting an `open` closes the fd before returning `Aborted`.
    pub fn execute(self, abort: &AtomicBool) -> Result<OpValue, NodeError> {
        check_abort(abort)?;
        match self {
            Op::ReadFile { path } => read_file(&path, abort),
            Op::WriteFile {
                path,
                data,
                mode,
                flags,
            } => write_file(&path, &data, mode, flags, abort),
            Op::AppendFile {
                path,
                data,
                mode,
                flags,
            } => write_file(&path, &data, mode, flags, abort),
            Op::CopyFile { src, dst, flags } => copy_file(&src, &dst, flags),
            Op::Mkdir {
                path,
                mode,
                recursive,
            } => mkdir(&path, mode, recursive, abort),
            Op::Mkdtemp { prefix } => mkdtemp(&prefix, abort),
            Op::Readdir {
                path,
                with_types: _,
            } => readdir(&path),
            Op::Rm {
                path,
                recursive,
                force,
                max_retries,
                retry_delay_ms,
            } => rm(&path, recursive, force, max_retries, retry_delay_ms, abort),
            Op::Rmdir { path } => rmdir(&path),
            Op::Unlink { path } => unlink(&path),
            Op::Rename { from, to } => rename(&from, &to),
            Op::Stat { path, follow } => stat(&path, follow),
            Op::Fstat { fd } => fstat(fd),
            Op::Access { path, mode } => access(&path, mode),
            Op::Chmod { path, mode, follow } => chmod(&path, mode, follow),
            Op::Chown {
                path,
                uid,
                gid,
                follow,
            } => chown(&path, uid, gid, follow),
            Op::Truncate { path, len } => truncate(&path, len),
            Op::Ftruncate { fd, len } => ftruncate(fd, len),
            Op::Readlink { path } => readlink(&path),
            Op::Symlink { target, path } => symlink(&target, &path),
            Op::Link { existing, new_path } => link(&existing, &new_path),
            Op::Realpath { path } => realpath(&path),
            Op::Utimes {
                path,
                atime_ms,
                mtime_ms,
                follow,
            } => utimes(&path, atime_ms, mtime_ms, follow),
            Op::Open { path, flags, mode } => open(&path, flags, mode, abort),
            Op::Close { fd } => close(fd),
            Op::Read {
                fd,
                length,
                position,
            } => read(fd, length, position),
            Op::Write { fd, data, position } => write(fd, &data, position),
            Op::Fsync { fd } => fsync(fd),
            Op::Fdatasync { fd } => fdatasync(fd),
            Op::Fchmod { fd, mode } => fchmod(fd, mode),
            Op::Fchown { fd, uid, gid } => fchown(fd, uid, gid),
            Op::Futimes {
                fd,
                atime_ms,
                mtime_ms,
            } => futimes(fd, atime_ms, mtime_ms),
            Op::Statfs { path } => statfs(&path),
        }
    }
}

/// One finished async op, delivered to the isolate thread.
#[derive(Debug)]
pub enum OpDone {
    Ok { id: RequestId, value: OpValue },
    Err { id: RequestId, error: NodeError },
    Aborted { id: RequestId },
}

/// Where the pool delivers results. `ln-runtime`'s sink parks the payload and wakes the loop.
pub type Sink = Arc<dyn Fn(OpDone) + Send + Sync>;

/// The lazily created, process-wide offload pool. `io_threads` is tokio's
/// `max_blocking_threads` (`--io-threads`).
pub struct Pool {
    _runtime: tokio::runtime::Runtime,
}

impl Pool {
    pub fn new(io_threads: usize) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(io_threads.max(1))
            .enable_time()
            .build()?;
        Ok(Self { _runtime: runtime })
    }

    /// Run `op` on the blocking pool. The sink is called exactly once, on a pool thread.
    pub fn submit(&self, id: RequestId, op: Op, abort: Arc<AtomicBool>, sink: Sink) {
        let syscall = op.syscall();
        self._runtime.spawn_blocking(move || {
            // A panic anywhere in the op body (including a bug in `std`/`libc` glue) must still
            // settle the request exactly once; Node surfaces such failures as EIO.
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op.execute(&abort)));
            let done = match outcome {
                _ if abort.load(Ordering::SeqCst) => OpDone::Aborted { id },
                Ok(Ok(value)) => OpDone::Ok { id, value },
                Ok(Err(error)) if error.is_aborted() => OpDone::Aborted { id },
                Ok(Err(error)) => OpDone::Err { id, error },
                Err(_) => OpDone::Err {
                    id,
                    error: NodeError::from_errno(libc::EIO, syscall, None),
                },
            };
            sink(done);
        });
    }
}

/// The sync entry point, used by the `fs` sync forms on the isolate thread.
pub fn execute(op: Op, abort: &AtomicBool) -> Result<OpValue, NodeError> {
    op.execute(abort)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn check_abort(abort: &AtomicBool) -> Result<(), NodeError> {
    if abort.load(Ordering::SeqCst) {
        Err(NodeError::aborted())
    } else {
        Ok(())
    }
}

fn cpath(path: &Path, syscall: &'static str) -> Result<CString, NodeError> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| NodeError::from_errno(libc::EINVAL, syscall, Some(path)))
}

fn last_errno() -> i32 {
    io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

fn errno_error(syscall: &'static str, path: Option<&Path>) -> NodeError {
    NodeError::from_errno(last_errno(), syscall, path)
}

/// Node's message for a two-path syscall (`rename`, `copyfile`, `symlink`, `link`) names both
/// sides: `ENOENT: no such file or directory, rename '/a' -> '/b'`. The locked `NodeError` has
/// one `path` field, so it carries the first operand (as Node's `path` does) and the message
/// keeps the arrow form.
fn two_path_error(
    error: &io::Error,
    syscall: &'static str,
    first: &Path,
    second: &Path,
) -> NodeError {
    let (code, description) = match error.raw_os_error() {
        Some(errno) => (errno_code(errno), errno_message(errno)),
        None => ("UNKNOWN", "unknown error"),
    };
    let mut node_error = NodeError::system(error, syscall, first);
    node_error.message = format!(
        "{code}: {description}, {syscall} '{}' -> '{}'",
        first.display(),
        second.display()
    );
    node_error
}

fn close_fd(fd: i32) {
    // The return value is deliberately ignored: closing is best effort on error paths.
    unsafe {
        libc::close(fd);
    }
}

#[allow(clippy::unnecessary_cast)]
fn as_mode_t(mode: u32) -> libc::mode_t {
    mode as libc::mode_t
}

#[allow(clippy::unnecessary_cast)]
fn as_off_t(value: i64) -> libc::off_t {
    value as libc::off_t
}

#[allow(clippy::unnecessary_cast)]
fn as_uid(uid: u32) -> libc::uid_t {
    uid as libc::uid_t
}

#[allow(clippy::unnecessary_cast)]
fn as_gid(gid: u32) -> libc::gid_t {
    gid as libc::gid_t
}

/// Convert unix-epoch milliseconds to a `timespec`. `UTIME_NOW`/`UTIME_OMIT` are never used: the
/// JS layer resolves `Date`/number arguments to explicit times.
#[allow(clippy::unnecessary_cast)]
fn ms_to_timespec(ms: f64) -> libc::timespec {
    let ms = if ms.is_finite() { ms } else { 0.0 };
    let mut seconds = (ms / 1000.0).floor();
    let mut nanos = ((ms - seconds * 1000.0) * 1_000_000.0).round();
    if nanos >= 1_000_000_000.0 {
        seconds += 1.0;
        nanos -= 1_000_000_000.0;
    }
    let mut sec = seconds as i64;
    let mut nsec = nanos as i64;
    if nsec < 0 {
        nsec += 1_000_000_000;
        sec -= 1;
    }
    libc::timespec {
        tv_sec: sec as libc::time_t,
        tv_nsec: nsec as libc::c_long,
    }
}

fn file_kind(file_type: &fs::FileType) -> FileKind {
    if file_type.is_symlink() {
        FileKind::Symlink
    } else if file_type.is_file() {
        FileKind::File
    } else if file_type.is_dir() {
        FileKind::Dir
    } else if file_type.is_fifo() {
        FileKind::Fifo
    } else if file_type.is_socket() {
        FileKind::Socket
    } else if file_type.is_char_device() {
        FileKind::CharDevice
    } else if file_type.is_block_device() {
        FileKind::BlockDevice
    } else {
        FileKind::Unknown
    }
}

fn time_ms(seconds: i64, nanos: i64) -> f64 {
    seconds as f64 * 1000.0 + nanos as f64 / 1_000_000.0
}

fn stat_from_metadata(metadata: &fs::Metadata) -> Stat {
    let ctime_ms = time_ms(metadata.ctime(), metadata.ctime_nsec());
    #[cfg(target_os = "macos")]
    let birthtime_ms = {
        use std::os::macos::fs::MetadataExt as _;
        time_ms(metadata.st_birthtime(), metadata.st_birthtime_nsec())
    };
    #[cfg(not(target_os = "macos"))]
    let birthtime_ms = ctime_ms;
    Stat {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mode: metadata.mode(),
        nlink: metadata.nlink(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        rdev: metadata.rdev(),
        size: metadata.size(),
        blksize: metadata.blksize(),
        blocks: metadata.blocks(),
        atime_ms: time_ms(metadata.atime(), metadata.atime_nsec()),
        mtime_ms: time_ms(metadata.mtime(), metadata.mtime_nsec()),
        ctime_ms,
        birthtime_ms,
    }
}

fn open_path(path: &Path, flags: i32, mode: u32, syscall: &'static str) -> Result<i32, NodeError> {
    let c_path = cpath(path, syscall)?;
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            flags | libc::O_CLOEXEC,
            as_mode_t(mode) as libc::c_uint,
        )
    };
    if fd < 0 {
        Err(errno_error(syscall, Some(path)))
    } else {
        Ok(fd)
    }
}

fn read_file(path: &Path, abort: &AtomicBool) -> Result<OpValue, NodeError> {
    let fd = open_path(path, libc::O_RDONLY, 0, "open")?;
    let result = (|| {
        let mut out = Vec::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check_abort(abort)?;
            let read =
                unsafe { libc::read(fd, buffer.as_mut_ptr().cast::<libc::c_void>(), buffer.len()) };
            if read < 0 {
                if last_errno() == libc::EINTR {
                    continue;
                }
                return Err(errno_error("read", Some(path)));
            }
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buffer[..read as usize]);
        }
        Ok(OpValue::Bytes(out))
    })();
    close_fd(fd);
    result
}

fn write_file(
    path: &Path,
    data: &[u8],
    mode: u32,
    flags: i32,
    abort: &AtomicBool,
) -> Result<OpValue, NodeError> {
    let fd = open_path(path, flags, mode, "open")?;
    let result = (|| {
        let mut written = 0usize;
        while written < data.len() {
            check_abort(abort)?;
            let count = unsafe {
                libc::write(
                    fd,
                    data[written..].as_ptr().cast::<libc::c_void>(),
                    data.len() - written,
                )
            };
            if count < 0 {
                if last_errno() == libc::EINTR {
                    continue;
                }
                return Err(errno_error("write", Some(path)));
            }
            if count == 0 {
                return Err(NodeError::from_errno(libc::EIO, "write", Some(path)));
            }
            written += count as usize;
        }
        Ok(OpValue::Unit)
    })();
    close_fd(fd);
    result
}

fn copy_file(src: &Path, dst: &Path, flags: u32) -> Result<OpValue, NodeError> {
    // `COPYFILE_EXCL` is 1; the clone flags are ignored (std::fs::copy is a byte copy).
    if flags & 1 != 0 && fs::symlink_metadata(dst).is_ok() {
        return Err(two_path_error(
            &io::Error::from_raw_os_error(libc::EEXIST),
            "copyfile",
            src,
            dst,
        ));
    }
    fs::copy(src, dst)
        .map(|_| OpValue::Unit)
        .map_err(|error| two_path_error(&error, "copyfile", src, dst))
}

fn mkdir(
    path: &Path,
    mode: u32,
    recursive: bool,
    abort: &AtomicBool,
) -> Result<OpValue, NodeError> {
    if recursive {
        return mkdir_recursive(path, mode, abort);
    }
    fs::DirBuilder::new()
        .mode(mode)
        .create(path)
        .map(|()| OpValue::Unit)
        .map_err(|error| NodeError::system(&error, "mkdir", path))
}

fn mkdir_recursive(path: &Path, mode: u32, abort: &AtomicBool) -> Result<OpValue, NodeError> {
    if path.as_os_str().is_empty() {
        return Err(NodeError::from_errno(libc::ENOENT, "mkdir", Some(path)));
    }

    // Walk up collecting the missing suffix (`missing` is bottom-up), stopping at the first
    // ancestor that exists (or at the filesystem root / first relative component).
    let mut missing: Vec<&Path> = Vec::new();
    let mut current = path;
    loop {
        match fs::symlink_metadata(current) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(current);
            }
            Err(error) => return Err(NodeError::system(&error, "mkdir", current)),
        }
        match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() && parent != current => {
                current = parent;
            }
            _ => break,
        }
    }

    // Create top-down. The first successful `create` is Node's `mkdir({recursive})` return
    // value; when nothing was created the result is `Text("")`, which the JS layer maps to
    // `undefined` (the contract's `string | null` for "everything already existed").
    let mut first_created: Option<&Path> = None;
    for dir in missing.iter().rev() {
        check_abort(abort)?;
        match fs::DirBuilder::new().mode(mode).create(dir) {
            Ok(()) => {
                if first_created.is_none() {
                    first_created = Some(dir);
                }
            }
            // A concurrent creator won the race: recursive mkdir tolerates an existing dir.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => {}
            Err(error) => return Err(NodeError::system(&error, "mkdir", dir)),
        }
    }
    Ok(OpValue::Text(
        first_created
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ))
}

fn mkdtemp(prefix: &Path, abort: &AtomicBool) -> Result<OpValue, NodeError> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for _ in 0..1024 {
        check_abort(abort)?;
        let mut entropy = [0u8; 6];
        getrandom::getrandom(&mut entropy)
            .map_err(|_| NodeError::from_errno(libc::EIO, "mkdtemp", Some(prefix)))?;
        let mut name = prefix.as_os_str().to_os_string();
        for byte in entropy {
            name.push(String::from(
                ALPHABET[byte as usize % ALPHABET.len()] as char,
            ));
        }
        let candidate = PathBuf::from(name);
        match fs::DirBuilder::new().mode(0o700).create(&candidate) {
            Ok(()) => return Ok(OpValue::Text(candidate.to_string_lossy().into_owned())),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(NodeError::system(&error, "mkdtemp", &candidate)),
        }
    }
    Err(NodeError::from_errno(libc::EEXIST, "mkdtemp", Some(prefix)))
}

fn readdir(path: &Path) -> Result<OpValue, NodeError> {
    let entries = fs::read_dir(path).map_err(|error| NodeError::system(&error, "readdir", path))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| NodeError::system(&error, "readdir", path))?;
        // `file_type` does not follow symlinks; if the type cannot be read (the entry vanished)
        // report `Unknown` instead of failing the whole readdir, like libuv.
        let kind = entry
            .file_type()
            .map_or(FileKind::Unknown, |kind| file_kind(&kind));
        result.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
        });
    }
    Ok(OpValue::Dir(result))
}

fn is_retryable(error: &NodeError) -> bool {
    matches!(error.code, "ENOTEMPTY" | "EBUSY" | "EPERM" | "EMFILE")
}

fn rm(
    path: &Path,
    recursive: bool,
    force: bool,
    max_retries: u32,
    retry_delay_ms: u64,
    abort: &AtomicBool,
) -> Result<OpValue, NodeError> {
    refuse_self_reference(path, "rm")?;

    let mut attempt = 0u32;
    loop {
        check_abort(abort)?;
        match remove_path(path, recursive, force, abort) {
            Ok(()) => return Ok(OpValue::Unit),
            Err(error) if force && error.code == "ENOENT" => return Ok(OpValue::Unit),
            Err(error) if is_retryable(&error) && attempt < max_retries => {
                attempt += 1;
                if retry_delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(retry_delay_ms));
                }
            }
            Err(error) => return Err(error),
        }
    }
}

/// Refuse to remove the process's own working directory.
///
/// Node rejects the literal `.` and `./` but will happily remove an absolute path that *is* the
/// cwd (`fs.rmSync(process.cwd())` deletes the project). Onde rejects both: `rm -r .` walking the
/// runtime's own tree is not a failure mode worth preserving, and a path resolved by the JS layer
/// must not slip past the check. The comparison is lexical, so `.`, `./`, `a/..` and an absolute
/// path equal to the cwd all reach the same decision. See compat D39.
fn refuse_self_reference(path: &Path, syscall: &'static str) -> Result<(), NodeError> {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && path.is_absolute() {
                    return Ok(());
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir => normalized.push("/"),
            Component::Prefix(_) => {}
        }
    }

    let is_dot = normalized.as_os_str().is_empty();
    let is_cwd = path.is_absolute()
        && std::env::current_dir()
            .map(|cwd| normalized == cwd)
            .unwrap_or(false);

    if is_dot || is_cwd {
        return Err(NodeError::new(
            "ERR_FS_EISDIR",
            format!(
                "Path is a directory: {syscall} returned EISDIR (is a directory) {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn remove_path(
    path: &Path,
    recursive: bool,
    force: bool,
    abort: &AtomicBool,
) -> Result<(), NodeError> {
    check_abort(abort)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(NodeError::system(&error, "lstat", path)),
    };

    // Symlinks are removed, never followed; `-r` must not descend into their target.
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if force && error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(NodeError::system(&error, "unlink", path)),
        };
    }

    if !recursive {
        return Err(NodeError::new(
            "ERR_FS_EISDIR",
            format!(
                "Path is a directory: rm returned EISDIR (is a directory) {}",
                path.display()
            ),
        ));
    }

    let entries = fs::read_dir(path).map_err(|error| NodeError::system(&error, "readdir", path))?;
    for entry in entries {
        let entry = entry.map_err(|error| NodeError::system(&error, "readdir", path))?;
        remove_path(&entry.path(), true, force, abort)?;
    }
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(NodeError::system(&error, "rmdir", path)),
    }
}

fn rmdir(path: &Path) -> Result<OpValue, NodeError> {
    // `Op::Rmdir` has no recursive flag: the bridge maps `rmdir(path, {recursive: true})` onto
    // `Op::Rm { recursive: true, .. }`. This is the plain `remove_dir` form.
    refuse_self_reference(path, "rmdir")?;
    fs::remove_dir(path)
        .map(|()| OpValue::Unit)
        .map_err(|error| NodeError::system(&error, "rmdir", path))
}

fn unlink(path: &Path) -> Result<OpValue, NodeError> {
    fs::remove_file(path)
        .map(|()| OpValue::Unit)
        .map_err(|error| NodeError::system(&error, "unlink", path))
}

fn rename(from: &Path, to: &Path) -> Result<OpValue, NodeError> {
    fs::rename(from, to)
        .map(|()| OpValue::Unit)
        .map_err(|error| two_path_error(&error, "rename", from, to))
}

fn statfs(path: &Path) -> Result<OpValue, NodeError> {
    let c_path = cpath(path, "statfs")?;

    #[cfg(target_os = "macos")]
    {
        let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
        let result = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
        if result != 0 {
            return Err(NodeError::from_errno(last_errno(), "statfs", Some(path)));
        }
        Ok(OpValue::StatFs(StatFs {
            kind: buf.f_type as u64,
            bsize: buf.f_bsize as u64,
            frsize: buf.f_iosize as u64,
            blocks: buf.f_blocks,
            bfree: buf.f_bfree,
            bavail: buf.f_bavail,
            files: buf.f_files,
            ffree: buf.f_ffree,
        }))
    }

    #[cfg(target_os = "linux")]
    {
        let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
        let result = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
        if result != 0 {
            return Err(NodeError::from_errno(last_errno(), "statfs", Some(path)));
        }
        Ok(OpValue::StatFs(StatFs {
            kind: buf.f_type as u64,
            bsize: buf.f_bsize as u64,
            frsize: buf.f_bsize as u64,
            blocks: buf.f_blocks,
            bfree: buf.f_bfree,
            bavail: buf.f_bavail,
            files: buf.f_files,
            ffree: buf.f_ffree,
        }))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = c_path;
        Err(NodeError::from_errno(libc::ENOSYS, "statfs", Some(path)))
    }
}

fn stat(path: &Path, follow: bool) -> Result<OpValue, NodeError> {
    let metadata = if follow {
        fs::metadata(path).map_err(|error| NodeError::system(&error, "stat", path))?
    } else {
        fs::symlink_metadata(path).map_err(|error| NodeError::system(&error, "lstat", path))?
    };
    Ok(OpValue::Stat(stat_from_metadata(&metadata)))
}

fn fstat(fd: i32) -> Result<OpValue, NodeError> {
    // Take ownership only long enough to read metadata, then forget the `File` so the caller's
    // descriptor stays open (Node exposes real fds).
    let file = ManuallyDrop::new(unsafe { fs::File::from_raw_fd(fd) });
    match file.metadata() {
        Ok(metadata) => Ok(OpValue::Stat(stat_from_metadata(&metadata))),
        Err(error) => Err(NodeError::from_errno(
            error.raw_os_error().unwrap_or(libc::EIO),
            "fstat",
            None,
        )),
    }
}

fn access(path: &Path, mode: i32) -> Result<OpValue, NodeError> {
    let c_path = cpath(path, "access")?;
    let result = unsafe { libc::access(c_path.as_ptr(), mode) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("access", Some(path)))
    }
}

fn chmod(path: &Path, mode: u32, follow: bool) -> Result<OpValue, NodeError> {
    let syscall = if follow { "chmod" } else { "lchmod" };
    let c_path = cpath(path, syscall)?;
    #[cfg(target_os = "macos")]
    {
        let result = unsafe {
            if follow {
                libc::chmod(c_path.as_ptr(), as_mode_t(mode))
            } else {
                libc::lchmod(c_path.as_ptr(), as_mode_t(mode))
            }
        };
        if result == 0 {
            Ok(OpValue::Unit)
        } else {
            Err(errno_error(syscall, Some(path)))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux has no lchmod; libuv/Node report ENOSYS for fs.lchmod.
        if !follow {
            return Err(NodeError::from_errno(libc::ENOSYS, "lchmod", Some(path)));
        }
        let result = unsafe { libc::chmod(c_path.as_ptr(), as_mode_t(mode)) };
        if result == 0 {
            Ok(OpValue::Unit)
        } else {
            Err(errno_error(syscall, Some(path)))
        }
    }
}

fn chown(path: &Path, uid: u32, gid: u32, follow: bool) -> Result<OpValue, NodeError> {
    let syscall = if follow { "chown" } else { "lchown" };
    let c_path = cpath(path, syscall)?;
    let result = unsafe {
        if follow {
            libc::chown(c_path.as_ptr(), as_uid(uid), as_gid(gid))
        } else {
            libc::lchown(c_path.as_ptr(), as_uid(uid), as_gid(gid))
        }
    };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error(syscall, Some(path)))
    }
}

fn truncate(path: &Path, len: u64) -> Result<OpValue, NodeError> {
    let c_path = cpath(path, "truncate")?;
    let result = unsafe { libc::truncate(c_path.as_ptr(), len as libc::off_t) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("truncate", Some(path)))
    }
}

fn ftruncate(fd: i32, len: u64) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::ftruncate(fd, len as libc::off_t) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("ftruncate", None))
    }
}

fn readlink(path: &Path) -> Result<OpValue, NodeError> {
    match fs::read_link(path) {
        Ok(target) => Ok(OpValue::Bytes(target.as_os_str().as_bytes().to_vec())),
        Err(error) => Err(NodeError::system(&error, "readlink", path)),
    }
}

fn symlink(target: &Path, path: &Path) -> Result<OpValue, NodeError> {
    std::os::unix::fs::symlink(target, path)
        .map(|()| OpValue::Unit)
        .map_err(|error| two_path_error(&error, "symlink", target, path))
}

fn link(existing: &Path, new_path: &Path) -> Result<OpValue, NodeError> {
    fs::hard_link(existing, new_path)
        .map(|()| OpValue::Unit)
        .map_err(|error| two_path_error(&error, "link", existing, new_path))
}

fn realpath(path: &Path) -> Result<OpValue, NodeError> {
    fs::canonicalize(path)
        .map(|path| OpValue::Text(path.to_string_lossy().into_owned()))
        .map_err(|error| NodeError::system(&error, "realpath", path))
}

fn utimes(path: &Path, atime_ms: f64, mtime_ms: f64, follow: bool) -> Result<OpValue, NodeError> {
    let syscall = if follow { "utimes" } else { "lutimes" };
    let c_path = cpath(path, syscall)?;
    let times = [ms_to_timespec(atime_ms), ms_to_timespec(mtime_ms)];
    let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), flags) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error(syscall, Some(path)))
    }
}

fn open(path: &Path, flags: i32, mode: u32, abort: &AtomicBool) -> Result<OpValue, NodeError> {
    let fd = open_path(path, flags, mode, "open")?;
    // Post-syscall abort: the fd is the only resource this op can leave behind, and ADR-0005
    // requires it to be closed before reporting the op as aborted.
    if abort.load(Ordering::SeqCst) {
        close_fd(fd);
        return Err(NodeError::aborted());
    }
    Ok(OpValue::Fd(fd))
}

fn close(fd: i32) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::close(fd) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        // A double close surfaces the OS's EBADF, exactly as Node does.
        Err(errno_error("close", None))
    }
}

fn read(fd: i32, length: u32, position: i64) -> Result<OpValue, NodeError> {
    if length == 0 {
        return Ok(OpValue::Bytes(Vec::new()));
    }
    let mut buffer = vec![0u8; length as usize];
    let count = loop {
        let result = unsafe {
            if position < 0 {
                libc::read(fd, buffer.as_mut_ptr().cast::<libc::c_void>(), buffer.len())
            } else {
                libc::pread(
                    fd,
                    buffer.as_mut_ptr().cast::<libc::c_void>(),
                    buffer.len(),
                    as_off_t(position),
                )
            }
        };
        if result < 0 {
            if last_errno() == libc::EINTR {
                continue;
            }
            return Err(errno_error("read", None));
        }
        break result;
    };
    buffer.truncate(count as usize);
    Ok(OpValue::Bytes(buffer))
}

fn write(fd: i32, data: &[u8], position: i64) -> Result<OpValue, NodeError> {
    let mut written = 0usize;
    while written < data.len() {
        let remaining = &data[written..];
        let count = unsafe {
            if position < 0 {
                libc::write(
                    fd,
                    remaining.as_ptr().cast::<libc::c_void>(),
                    remaining.len(),
                )
            } else {
                libc::pwrite(
                    fd,
                    remaining.as_ptr().cast::<libc::c_void>(),
                    remaining.len(),
                    as_off_t(position + written as i64),
                )
            }
        };
        if count < 0 {
            if last_errno() == libc::EINTR {
                continue;
            }
            return Err(errno_error("write", None));
        }
        if count == 0 {
            return Err(NodeError::from_errno(libc::EIO, "write", None));
        }
        written += count as usize;
    }
    Ok(OpValue::Count(written as u64))
}

fn fsync(fd: i32) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::fsync(fd) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("fsync", None))
    }
}

#[cfg(not(target_os = "macos"))]
fn fdatasync(fd: i32) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::fdatasync(fd) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("fdatasync", None))
    }
}

/// Darwin has no `fdatasync(2)` binding in `libc`; libuv falls back to `fsync(2)` there too.
#[cfg(target_os = "macos")]
fn fdatasync(fd: i32) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::fsync(fd) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("fdatasync", None))
    }
}

fn fchmod(fd: i32, mode: u32) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::fchmod(fd, as_mode_t(mode)) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("fchmod", None))
    }
}

fn fchown(fd: i32, uid: u32, gid: u32) -> Result<OpValue, NodeError> {
    let result = unsafe { libc::fchown(fd, as_uid(uid), as_gid(gid)) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("fchown", None))
    }
}

fn futimes(fd: i32, atime_ms: f64, mtime_ms: f64) -> Result<OpValue, NodeError> {
    let times = [ms_to_timespec(atime_ms), ms_to_timespec(mtime_ms)];
    let result = unsafe { libc::futimens(fd, times.as_ptr()) };
    if result == 0 {
        Ok(OpValue::Unit)
    } else {
        Err(errno_error("futimes", None))
    }
}

/// A fresh abort flag, for the sync forms (which have no cancellation).
#[cfg(test)]
fn no_abort() -> AtomicBool {
    AtomicBool::new(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tempfile::tempdir;

    fn run(op: Op) -> Result<OpValue, NodeError> {
        execute(op, &no_abort())
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn statfs_reports_a_usable_filesystem() {
        let dir = tempfile::tempdir().expect("tempdir");
        let abort = AtomicBool::new(false);
        match execute(
            Op::Statfs {
                path: dir.path().to_path_buf(),
            },
            &abort,
        )
        .expect("statfs")
        {
            OpValue::StatFs(fs) => {
                assert!(fs.bsize > 0, "bsize");
                assert!(fs.frsize > 0, "frsize");
                assert!(fs.blocks > 0, "blocks");
                assert!(fs.bfree <= fs.blocks, "bfree <= blocks");
                assert!(fs.bavail <= fs.bfree, "bavail <= bfree");
                assert!(fs.files > 0, "files");
            }
            other => panic!("unexpected value: {other:?}"),
        }
    }

    #[test]
    fn follow_false_ops_report_the_l_syscall_word() {
        assert_eq!(
            Op::Chmod {
                path: "x".into(),
                mode: 0o644,
                follow: false
            }
            .syscall(),
            "lchmod"
        );
        assert_eq!(
            Op::Chown {
                path: "x".into(),
                uid: 0,
                gid: 0,
                follow: false
            }
            .syscall(),
            "lchown"
        );
        assert_eq!(
            Op::Utimes {
                path: "x".into(),
                atime_ms: 0.0,
                mtime_ms: 0.0,
                follow: false
            }
            .syscall(),
            "lutimes"
        );
        assert_eq!(
            Op::Chmod {
                path: "x".into(),
                mode: 0o644,
                follow: true
            }
            .syscall(),
            "chmod"
        );
    }

    #[test]
    fn self_references_are_refused_without_touching_the_filesystem() {
        for raw in [".", "./", ".//", "..", "../", "a/..", "./a/.."] {
            let error = refuse_self_reference(Path::new(raw), "rm")
                .expect_err(&format!("{raw} must be refused"));
            assert_eq!(error.code, "ERR_FS_EISDIR", "raw={raw}");
        }
        assert!(refuse_self_reference(Path::new("sub/file.txt"), "rm").is_ok());
        assert!(refuse_self_reference(Path::new("../sibling/file.txt"), "rm").is_ok());
    }

    #[test]
    fn the_process_cwd_is_refused_as_an_absolute_target() {
        let cwd = std::env::current_dir().expect("cwd");
        for target in [cwd.clone(), cwd.join("."), cwd.join("sub").join("..")] {
            let error =
                refuse_self_reference(&target, "rm").expect_err("the cwd must never be removed");
            assert_eq!(error.code, "ERR_FS_EISDIR");
        }
    }

    #[test]
    fn syscall_words_match_node() {
        let ops = vec![
            (Op::ReadFile { path: "/x".into() }, "open"),
            (
                Op::WriteFile {
                    path: "/x".into(),
                    data: Vec::new(),
                    mode: 0o644,
                    flags: 0,
                },
                "open",
            ),
            (
                Op::AppendFile {
                    path: "/x".into(),
                    data: Vec::new(),
                    mode: 0o644,
                    flags: 0,
                },
                "open",
            ),
            (
                Op::CopyFile {
                    src: "/a".into(),
                    dst: "/b".into(),
                    flags: 0,
                },
                "copyfile",
            ),
            (
                Op::Mkdir {
                    path: "/x".into(),
                    mode: 0o777,
                    recursive: false,
                },
                "mkdir",
            ),
            (
                Op::Mkdtemp {
                    prefix: "/x".into(),
                },
                "mkdtemp",
            ),
            (
                Op::Readdir {
                    path: "/x".into(),
                    with_types: false,
                },
                "readdir",
            ),
            (
                Op::Rm {
                    path: "/x".into(),
                    recursive: true,
                    force: false,
                    max_retries: 0,
                    retry_delay_ms: 0,
                },
                "rm",
            ),
            (Op::Rmdir { path: "/x".into() }, "rmdir"),
            (Op::Unlink { path: "/x".into() }, "unlink"),
            (
                Op::Rename {
                    from: "/a".into(),
                    to: "/b".into(),
                },
                "rename",
            ),
            (
                Op::Stat {
                    path: "/x".into(),
                    follow: true,
                },
                "stat",
            ),
            (
                Op::Stat {
                    path: "/x".into(),
                    follow: false,
                },
                "lstat",
            ),
            (Op::Fstat { fd: 0 }, "fstat"),
            (
                Op::Access {
                    path: "/x".into(),
                    mode: 0,
                },
                "access",
            ),
            (
                Op::Chmod {
                    path: "/x".into(),
                    mode: 0o644,
                    follow: true,
                },
                "chmod",
            ),
            (
                Op::Chown {
                    path: "/x".into(),
                    uid: 0,
                    gid: 0,
                    follow: false,
                },
                "lchown",
            ),
            (
                Op::Truncate {
                    path: "/x".into(),
                    len: 0,
                },
                "truncate",
            ),
            (Op::Ftruncate { fd: 0, len: 0 }, "ftruncate"),
            (Op::Readlink { path: "/x".into() }, "readlink"),
            (
                Op::Symlink {
                    target: "/a".into(),
                    path: "/b".into(),
                },
                "symlink",
            ),
            (
                Op::Link {
                    existing: "/a".into(),
                    new_path: "/b".into(),
                },
                "link",
            ),
            (Op::Realpath { path: "/x".into() }, "realpath"),
            (
                Op::Utimes {
                    path: "/x".into(),
                    atime_ms: 0.0,
                    mtime_ms: 0.0,
                    follow: true,
                },
                "utimes",
            ),
            (
                Op::Open {
                    path: "/x".into(),
                    flags: 0,
                    mode: 0o644,
                },
                "open",
            ),
            (Op::Close { fd: 0 }, "close"),
            (
                Op::Read {
                    fd: 0,
                    length: 1,
                    position: -1,
                },
                "read",
            ),
            (
                Op::Write {
                    fd: 0,
                    data: Vec::new(),
                    position: -1,
                },
                "write",
            ),
            (Op::Fsync { fd: 0 }, "fsync"),
            (Op::Fdatasync { fd: 0 }, "fdatasync"),
            (Op::Fchmod { fd: 0, mode: 0o644 }, "fchmod"),
            (
                Op::Fchown {
                    fd: 0,
                    uid: 0,
                    gid: 0,
                },
                "fchown",
            ),
            (
                Op::Futimes {
                    fd: 0,
                    atime_ms: 0.0,
                    mtime_ms: 0.0,
                },
                "futimes",
            ),
        ];
        for (op, expected) in ops {
            assert_eq!(op.syscall(), expected);
        }
    }

    #[test]
    fn read_write_roundtrip_with_positions_and_eof() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file");
        run(Op::WriteFile {
            path: path.clone(),
            data: b"hello world".to_vec(),
            mode: 0o644,
            flags: libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
        })
        .unwrap();

        let fd = match run(Op::Open {
            path: path.clone(),
            flags: libc::O_RDONLY,
            mode: 0,
        })
        .unwrap()
        {
            OpValue::Fd(fd) => fd,
            other => panic!("unexpected open result: {other:?}"),
        };

        let read = |position: i64, length: u32| match run(Op::Read {
            fd,
            length,
            position,
        })
        .unwrap()
        {
            OpValue::Bytes(bytes) => bytes,
            other => panic!("unexpected read result: {other:?}"),
        };

        assert_eq!(read(6, 5), b"world");
        assert_eq!(read(0, 100), b"hello world");
        assert_eq!(read(11, 5), Vec::<u8>::new());
        // `pread` does not advance the shared offset, so the current-offset read starts at 0.
        assert_eq!(read(-1, 4), b"hell");
        assert_eq!(read(-1, 100), b"o world");
        run(Op::Close { fd }).unwrap();
    }

    #[test]
    fn write_with_explicit_position_and_count() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file");
        write(&path, b"0123456789");
        let fd = match run(Op::Open {
            path: path.clone(),
            flags: libc::O_WRONLY,
            mode: 0,
        })
        .unwrap()
        {
            OpValue::Fd(fd) => fd,
            other => panic!("unexpected open result: {other:?}"),
        };
        let count = match run(Op::Write {
            fd,
            data: b"abc".to_vec(),
            position: 2,
        })
        .unwrap()
        {
            OpValue::Count(count) => count,
            other => panic!("unexpected write result: {other:?}"),
        };
        assert_eq!(count, 3);
        run(Op::Close { fd }).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"01abc56789");
    }

    #[test]
    fn append_file_appends() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file");
        run(Op::WriteFile {
            path: path.clone(),
            data: b"a".to_vec(),
            mode: 0o644,
            flags: libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
        })
        .unwrap();
        run(Op::AppendFile {
            path: path.clone(),
            data: b"b".to_vec(),
            mode: 0o644,
            flags: libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"ab");
    }

    #[test]
    fn copy_file_excl_refuses_existing_destination() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        write(&src, b"new");
        write(&dst, b"old");

        let error = run(Op::CopyFile {
            src: src.clone(),
            dst: dst.clone(),
            flags: 1,
        })
        .unwrap_err();
        assert_eq!(error.code, "EEXIST");
        assert_eq!(error.errno, Some(libc::EEXIST));
        assert_eq!(error.path.as_deref(), Some(src.as_path()));
        assert_eq!(
            error.message,
            format!(
                "EEXIST: file already exists, copyfile '{}' -> '{}'",
                src.display(),
                dst.display()
            )
        );
        assert_eq!(fs::read(&dst).unwrap(), b"old");

        run(Op::CopyFile {
            src,
            dst: dst.clone(),
            flags: 0,
        })
        .unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"new");
    }

    #[test]
    fn mkdir_recursive_returns_first_created_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a/b/c");
        let first = match run(Op::Mkdir {
            path: path.clone(),
            mode: 0o755,
            recursive: true,
        })
        .unwrap()
        {
            OpValue::Text(text) => text,
            other => panic!("unexpected mkdir result: {other:?}"),
        };
        assert_eq!(first, dir.path().join("a").to_string_lossy());
        assert!(path.is_dir());

        let again = run(Op::Mkdir {
            path: path.clone(),
            mode: 0o755,
            recursive: true,
        })
        .unwrap();
        assert_eq!(again, OpValue::Text(String::new()));
    }

    #[test]
    fn mkdtemp_creates_a_unique_directory_and_retries() {
        let dir = tempdir().unwrap();
        let prefix = dir.path().join("tmp-");
        let first = match run(Op::Mkdtemp {
            prefix: prefix.clone(),
        })
        .unwrap()
        {
            OpValue::Text(text) => text,
            other => panic!("unexpected mkdtemp result: {other:?}"),
        };
        assert!(Path::new(&first).is_dir());
        let suffix = Path::new(&first)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(suffix.starts_with("tmp-"));
        assert_eq!(suffix.len(), "tmp-".len() + 6);
    }

    #[test]
    fn readdir_reports_kinds_without_following_symlinks() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("file");
        let sub = dir.path().join("sub");
        let link = dir.path().join("link");
        write(&file, b"x");
        fs::create_dir(&sub).unwrap();
        std::os::unix::fs::symlink(&file, &link).unwrap();

        let entries = match run(Op::Readdir {
            path: dir.path().to_path_buf(),
            with_types: true,
        })
        .unwrap()
        {
            OpValue::Dir(entries) => entries,
            other => panic!("unexpected readdir result: {other:?}"),
        };
        let kind = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap()
                .kind
        };
        assert_eq!(kind("file"), FileKind::File);
        assert_eq!(kind("sub"), FileKind::Dir);
        assert_eq!(kind("link"), FileKind::Symlink);
    }

    #[test]
    #[allow(clippy::unnecessary_cast)]
    fn stat_follows_symlinks_and_lstat_does_not() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("file");
        let link = dir.path().join("link");
        write(&file, b"x");
        std::os::unix::fs::symlink(&file, &link).unwrap();

        let type_mask = libc::S_IFMT as u32;
        let stat = match run(Op::Stat {
            path: link.clone(),
            follow: true,
        })
        .unwrap()
        {
            OpValue::Stat(stat) => stat,
            other => panic!("unexpected stat result: {other:?}"),
        };
        assert_eq!(stat.mode & type_mask, libc::S_IFREG as u32);
        assert_eq!(stat.size, 1);

        let lstat = match run(Op::Stat {
            path: link.clone(),
            follow: false,
        })
        .unwrap()
        {
            OpValue::Stat(stat) => stat,
            other => panic!("unexpected lstat result: {other:?}"),
        };
        assert_eq!(lstat.mode & type_mask, libc::S_IFLNK as u32);
    }

    #[test]
    fn realpath_resolves_symlinks_to_an_absolute_path() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("file");
        let link = dir.path().join("link");
        write(&file, b"x");
        std::os::unix::fs::symlink(&file, &link).unwrap();

        let resolved = match run(Op::Realpath { path: link.clone() }).unwrap() {
            OpValue::Text(text) => text,
            other => panic!("unexpected realpath result: {other:?}"),
        };
        assert_eq!(resolved, fs::canonicalize(&file).unwrap().to_string_lossy());
        assert!(Path::new(&resolved).is_absolute());
    }

    #[test]
    fn rm_recursive_and_force() {
        let dir = tempdir().unwrap();
        let tree = dir.path().join("tree");
        fs::create_dir_all(tree.join("nested")).unwrap();
        write(&tree.join("nested/file"), b"x");

        run(Op::Rm {
            path: tree.clone(),
            recursive: true,
            force: false,
            max_retries: 0,
            retry_delay_ms: 0,
        })
        .unwrap();
        assert!(!tree.exists());

        // A symlink is removed, never followed.
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        write(&target, b"keep");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        run(Op::Rm {
            path: link.clone(),
            recursive: true,
            force: false,
            max_retries: 0,
            retry_delay_ms: 0,
        })
        .unwrap();
        assert!(!link.exists());
        assert_eq!(fs::read(&target).unwrap(), b"keep");

        // `force` ignores ENOENT; without it the error carries Node's shape.
        run(Op::Rm {
            path: dir.path().join("missing"),
            recursive: false,
            force: true,
            max_retries: 0,
            retry_delay_ms: 0,
        })
        .unwrap();
        let error = run(Op::Rm {
            path: dir.path().join("missing"),
            recursive: false,
            force: false,
            max_retries: 0,
            retry_delay_ms: 0,
        })
        .unwrap_err();
        assert_eq!(error.code, "ENOENT");
    }

    #[test]
    fn unlink_and_rename() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        write(&old, b"x");

        run(Op::Rename {
            from: old.clone(),
            to: new.clone(),
        })
        .unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read(&new).unwrap(), b"x");

        run(Op::Unlink { path: new.clone() }).unwrap();
        assert!(!new.exists());

        let missing = dir.path().join("missing");
        let target = dir.path().join("target");
        let error = run(Op::Rename {
            from: missing.clone(),
            to: target.clone(),
        })
        .unwrap_err();
        assert_eq!(error.syscall, Some("rename"));
        assert_eq!(error.path.as_deref(), Some(missing.as_path()));
        assert_eq!(
            error.message,
            format!(
                "ENOENT: no such file or directory, rename '{}' -> '{}'",
                missing.display(),
                target.display()
            )
        );
    }

    #[test]
    fn double_close_is_ebadf() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file");
        write(&path, b"x");
        let fd = match run(Op::Open {
            path,
            flags: libc::O_RDONLY,
            mode: 0,
        })
        .unwrap()
        {
            OpValue::Fd(fd) => fd,
            other => panic!("unexpected open result: {other:?}"),
        };
        run(Op::Close { fd }).unwrap();
        let error = run(Op::Close { fd }).unwrap_err();
        assert_eq!(error.code, "EBADF");
        assert_eq!(error.errno, Some(libc::EBADF));
        assert_eq!(error.syscall, Some("close"));
        assert_eq!(error.path, None);
        assert_eq!(error.message, "EBADF: bad file descriptor, close");
    }

    #[test]
    fn reading_a_directory_is_eisdir() {
        let dir = tempdir().unwrap();
        let fd = match run(Op::Open {
            path: dir.path().to_path_buf(),
            flags: libc::O_RDONLY,
            mode: 0,
        })
        .unwrap()
        {
            OpValue::Fd(fd) => fd,
            other => panic!("unexpected open result: {other:?}"),
        };
        let error = run(Op::Read {
            fd,
            length: 1,
            position: -1,
        })
        .unwrap_err();
        assert_eq!(error.code, "EISDIR");
        assert_eq!(error.errno, Some(libc::EISDIR));
        assert_eq!(error.syscall, Some("read"));
        run(Op::Close { fd }).unwrap();
    }

    #[test]
    fn missing_file_error_has_the_node_shape() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing");
        let error = run(Op::ReadFile { path: path.clone() }).unwrap_err();
        assert_eq!(error.name, "Error");
        assert_eq!(error.code, "ENOENT");
        assert_eq!(error.errno, Some(libc::ENOENT));
        assert_eq!(error.syscall, Some("open"));
        assert_eq!(error.path.as_deref(), Some(path.as_path()));
        assert_eq!(
            error.message,
            format!(
                "ENOENT: no such file or directory, open '{}'",
                path.display()
            )
        );
    }

    #[test]
    fn pre_set_abort_is_aborted_before_executing() {
        let abort = AtomicBool::new(true);
        let error = execute(
            Op::Unlink {
                path: "/definitely/not/removed".into(),
            },
            &abort,
        )
        .unwrap_err();
        assert!(error.is_aborted());
        assert_eq!(error.code, "ABORT_ERR");
        assert_eq!(error.name, "AbortError");
    }

    #[test]
    fn pool_delivers_exactly_one_done_per_submit() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        write(&first, b"one");
        write(&second, b"two");

        let pool = Pool::new(2).unwrap();
        let (sender, receiver) = mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let sink: Sink = Arc::new(move |done| {
            sender.lock().unwrap().send(done).unwrap();
        });

        pool.submit(
            1,
            Op::ReadFile { path: first },
            Arc::new(AtomicBool::new(false)),
            Arc::clone(&sink),
        );
        match receiver.recv_timeout(Duration::from_secs(10)).unwrap() {
            OpDone::Ok { id, value } => {
                assert_eq!(id, 1);
                assert_eq!(value, OpValue::Bytes(b"one".to_vec()));
            }
            other => panic!("unexpected completion: {other:?}"),
        }
        // The sink must not fire twice for one submit.
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));

        // A second submit is independent (fresh id, fresh value, exactly one completion).
        pool.submit(
            2,
            Op::ReadFile { path: second },
            Arc::new(AtomicBool::new(false)),
            Arc::clone(&sink),
        );
        match receiver.recv_timeout(Duration::from_secs(10)).unwrap() {
            OpDone::Ok { id, value } => {
                assert_eq!(id, 2);
                assert_eq!(value, OpValue::Bytes(b"two".to_vec()));
            }
            other => panic!("unexpected completion: {other:?}"),
        }
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn pool_reports_aborted_for_a_pre_set_flag() {
        let pool = Pool::new(1).unwrap();
        let (sender, receiver) = mpsc::channel();
        let sink: Sink = Arc::new(move |done| {
            sender.send(done).unwrap();
        });
        pool.submit(
            9,
            Op::ReadFile {
                path: "/does/not/exist".into(),
            },
            Arc::new(AtomicBool::new(true)),
            Arc::clone(&sink),
        );
        match receiver.recv_timeout(Duration::from_secs(10)).unwrap() {
            OpDone::Aborted { id } => assert_eq!(id, 9),
            other => panic!("unexpected completion: {other:?}"),
        }
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn pool_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Pool>();
    }

    #[test]
    fn fd_and_path_metadata_ops() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file");
        write(&path, b"abcdef");

        run(Op::Truncate {
            path: path.clone(),
            len: 3,
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"abc");

        run(Op::Chmod {
            path: path.clone(),
            mode: 0o600,
            follow: true,
        })
        .unwrap();
        let mode = match run(Op::Stat {
            path: path.clone(),
            follow: true,
        })
        .unwrap()
        {
            OpValue::Stat(stat) => stat.mode,
            other => panic!("unexpected stat result: {other:?}"),
        };
        assert_eq!(mode & 0o777, 0o600);

        let fd = match run(Op::Open {
            path: path.clone(),
            flags: libc::O_RDWR,
            mode: 0,
        })
        .unwrap()
        {
            OpValue::Fd(fd) => fd,
            other => panic!("unexpected open result: {other:?}"),
        };
        run(Op::Write {
            fd,
            data: b"Z".to_vec(),
            position: 1,
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"aZc");

        match run(Op::Fstat { fd }).unwrap() {
            OpValue::Stat(stat) => assert_eq!(stat.size, 3),
            other => panic!("unexpected fstat result: {other:?}"),
        }
        run(Op::Fchmod { fd, mode: 0o640 }).unwrap();
        run(Op::Ftruncate { fd, len: 2 }).unwrap();
        run(Op::Futimes {
            fd,
            atime_ms: 1_600_000_000_000.0,
            mtime_ms: 1_600_000_000_000.0,
        })
        .unwrap();
        run(Op::Fsync { fd }).unwrap();
        run(Op::Fdatasync { fd }).unwrap();
        run(Op::Close { fd }).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"aZ");

        // `utimes` must set explicit times without UTIME_NOW/UTIME_OMIT.
        run(Op::Utimes {
            path: path.clone(),
            atime_ms: 1_700_000_000_123.0,
            mtime_ms: 1_700_000_000_123.0,
            follow: true,
        })
        .unwrap();
        let stat = match run(Op::Stat {
            path: path.clone(),
            follow: true,
        })
        .unwrap()
        {
            OpValue::Stat(stat) => stat,
            other => panic!("unexpected stat result: {other:?}"),
        };
        assert!((stat.mtime_ms - 1_700_000_000_123.0).abs() < 5.0);
        assert!((stat.atime_ms - 1_700_000_000_123.0).abs() < 5.0);

        // readlink/symlink/link.
        let symlink_path = dir.path().join("symlink");
        run(Op::Symlink {
            target: path.clone(),
            path: symlink_path.clone(),
        })
        .unwrap();
        match run(Op::Readlink {
            path: symlink_path.clone(),
        })
        .unwrap()
        {
            OpValue::Bytes(bytes) => assert_eq!(bytes, path.as_os_str().as_bytes()),
            other => panic!("unexpected readlink result: {other:?}"),
        }
        let hard_link = dir.path().join("hard-link");
        run(Op::Link {
            existing: path.clone(),
            new_path: hard_link.clone(),
        })
        .unwrap();
        assert_eq!(fs::read(&hard_link).unwrap(), b"aZ");
    }
}
