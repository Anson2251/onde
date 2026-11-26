//! The enforcement handle: a policy plus the flag that turns it on.
//!
//! `Permit` is cloned into the offload pool, the network tasks and the host state, so every site
//! that makes a syscall asks the same value. `unconfined()` is the one branch that keeps default
//! runs at the pre-permission cost: every check returns before touching the policy. The policy
//! itself lives in `ln-perm`; this type only adds the runtime's error shape.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ln_error::NodeError;
use ln_perm::{Capability, Policy, Request};

use crate::Op;

/// A policy (or the absence of one) attached to one isolate.
#[derive(Clone)]
pub struct Permit(Arc<PermitInner>);

struct PermitInner {
    policy: Policy,
    enforced: bool,
    /// The descriptors the isolate may act on by number (ADR-0011 §5.6). Empty while unenforced.
    fds: Mutex<FdTable>,
}

/// What an open descriptor may be used for. `Read` and `Write` are independent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FdMode {
    pub read: bool,
    pub write: bool,
}

impl FdMode {
    pub const READ: FdMode = FdMode {
        read: true,
        write: false,
    };
    pub const WRITE: FdMode = FdMode {
        read: false,
        write: true,
    };
    pub const READ_WRITE: FdMode = FdMode {
        read: true,
        write: true,
    };

    /// The mode of a descriptor returned by `open`. The write bits are a mask, not `O_ACCMODE`:
    /// `O_RDONLY | O_CREAT` creates a file, so it needs write authority (ADR-0011 §5.5).
    pub fn from_open_flags(flags: i32) -> Self {
        #[cfg(unix)]
        {
            let write = flags
                & (libc::O_WRONLY | libc::O_RDWR | libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND)
                != 0;
            let read = flags & libc::O_ACCMODE != libc::O_WRONLY;
            FdMode { read, write }
        }
        #[cfg(not(unix))]
        {
            // Windows is best-effort (R8): a nonzero access mode means read-write.
            FdMode {
                read: true,
                write: flags != 0,
            }
        }
    }

    fn allows(self, need: FdNeed) -> bool {
        match need {
            FdNeed::Any => true,
            FdNeed::Read => self.read,
            FdNeed::Write => self.write,
        }
    }
}

/// What a bare-fd op needs from the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FdNeed {
    /// Membership only: `Fstat`, `Fsync`, `Fdatasync`, `Close`, `StdioMode::Fd`.
    Any,
    Read,
    Write,
}

#[derive(Default)]
struct FdTable {
    entries: HashMap<i32, FdMode>,
}

impl Permit {
    /// No policy: checks are skipped. This is what `Config::permissions == None` installs.
    pub fn unconfined() -> Self {
        Permit(Arc::new(PermitInner {
            policy: Policy::deny_all(),
            enforced: false,
            fds: Mutex::new(FdTable::default()),
        }))
    }

    /// Enforce `policy`. Passing a deny-all policy is how `--permission` with no grants starts.
    pub fn new(policy: Policy) -> Self {
        Permit(Arc::new(PermitInner {
            policy,
            enforced: true,
            fds: Mutex::new(FdTable::default()),
        }))
    }

    pub fn enforced(&self) -> bool {
        self.0.enforced
    }

    pub fn policy(&self) -> &Policy {
        &self.0.policy
    }

    /// Record a descriptor the isolate owns before any script runs: 0/1/2 and the fork IPC fd.
    pub fn seed_fd(&self, fd: i32, mode: FdMode) {
        if !self.0.enforced {
            return;
        }
        lock(&self.0.fds).entries.insert(fd, mode);
    }

    /// Record a descriptor returned by a granted `open`.
    pub fn note_open(&self, fd: i32, flags: i32) {
        if !self.0.enforced {
            return;
        }
        lock(&self.0.fds)
            .entries
            .insert(fd, FdMode::from_open_flags(flags));
    }

    /// Forget a descriptor after a successful `close`.
    pub fn note_close(&self, fd: i32) {
        if !self.0.enforced {
            return;
        }
        lock(&self.0.fds).entries.remove(&fd);
    }

    /// Whether a bare-fd op may use `fd` this way. An unknown descriptor is denied: a number that
    /// did not come from a granted `open` is not authority the policy handed out.
    pub fn check_fd(&self, fd: i32, need: FdNeed) -> Result<(), NodeError> {
        if !self.0.enforced {
            return Ok(());
        }
        let table = lock(&self.0.fds);
        let capability = match need {
            FdNeed::Write => "fs.write",
            FdNeed::Read | FdNeed::Any => "fs.read",
        };
        match table.entries.get(&fd) {
            Some(mode) if mode.allows(need) => Ok(()),
            Some(_) => Err(NodeError::access_denied(
                capability,
                format!("fd {fd}"),
                "the descriptor table does not permit that operation",
            )),
            None => Err(NodeError::access_denied(
                capability,
                format!("fd {fd}"),
                "the descriptor table has no such descriptor",
            )),
        }
    }

    /// Membership only, for `StdioMode::Fd` and anything that hands a descriptor onward.
    pub fn knows_fd(&self, fd: i32) -> bool {
        !self.0.enforced || lock(&self.0.fds).entries.contains_key(&fd)
    }

    /// Resolve an existing path the way a gate does (canonicalise; with `follow: false`, resolve
    /// the parent and keep the final component). Exposed for host gates outside `ln-io` (sqlite).
    pub fn resolve_read(&self, path: &Path, syscall: &'static str) -> Result<PathBuf, NodeError> {
        resolve_read(path, syscall, true)
    }

    /// Resolve a path that may not exist yet (canonicalise the deepest ancestor, refuse a symlink
    /// below it).
    pub fn resolve_create(&self, path: &Path, syscall: &'static str) -> Result<PathBuf, NodeError> {
        resolve_create(path, syscall)
    }

    /// Whether a request is allowed, without building the denial. Used where a denied item is
    /// filtered out rather than thrown (an environment variable in `process.env`).
    pub fn allows(&self, request: &Request<'_>) -> bool {
        !self.0.enforced || self.0.policy.check(request).is_ok()
    }

    /// Check one request. The denial is `ERR_ACCESS_DENIED`; the three payload properties land when
    /// the error model grows them (plan Phase 7).
    pub fn check(&self, request: &Request<'_>) -> Result<(), NodeError> {
        if !self.0.enforced {
            return Ok(());
        }
        self.0.policy.check(request).map_err(|denial| {
            let policy = denial.origin.to_string();
            if denial.resource == "*" {
                NodeError::access_denied_any(denial.capability.id(), policy)
            } else {
                NodeError::access_denied(denial.capability.id(), denial.resource, policy)
            }
        })
    }
}

impl Default for Permit {
    fn default() -> Self {
        Self::unconfined()
    }
}

impl std::fmt::Debug for Permit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Permit")
            .field("enforced", &self.0.enforced)
            .finish_non_exhaustive()
    }
}

impl Permit {
    /// Resolve the paths an op names and check it against the policy, returning the op rewritten
    /// to the resolved paths.
    ///
    /// The match is exhaustive and has no wildcard arm: a new [`Op`] fails to compile until it is
    /// classified here (ADR-0011 §5.5). `Ok(None)` means the op needs no rewritten path (fd ops and
    /// `dns.lookup`); `Err` is the denial or the resolution's Node-shaped error.
    ///
    /// This runs on the pool thread immediately before the syscall. The returned op is what the
    /// executor opens, so what was checked and what is opened are the same path; the open helpers
    /// add `O_NOFOLLOW` under enforcement.
    pub(crate) fn resolve_op(&self, op: &Op) -> Result<Option<Op>, NodeError> {
        if !self.0.enforced {
            return Ok(None);
        }
        let syscall = op.syscall();
        match op {
            Op::ReadFile { path } => {
                let resolved = resolve_read(path, syscall, true)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::ReadFile { path: resolved }))
            }
            Op::WriteFile {
                path,
                data,
                mode,
                flags,
            } => {
                let resolved = resolve_create(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::WriteFile {
                    path: resolved,
                    data: data.clone(),
                    mode: *mode,
                    flags: *flags,
                }))
            }
            Op::AppendFile {
                path,
                data,
                mode,
                flags,
            } => {
                let resolved = resolve_create(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::AppendFile {
                    path: resolved,
                    data: data.clone(),
                    mode: *mode,
                    flags: *flags,
                }))
            }
            Op::CopyFile { src, dst, flags } => {
                let src = resolve_read(src, syscall, true)?;
                let dst = resolve_create(dst, syscall)?;
                self.check_path(Capability::FsRead, &src)?;
                self.check_path(Capability::FsWrite, &dst)?;
                Ok(Some(Op::CopyFile {
                    src,
                    dst,
                    flags: *flags,
                }))
            }
            Op::Mkdir {
                path,
                mode,
                recursive,
            } => {
                let resolved = resolve_create(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Mkdir {
                    path: resolved,
                    mode: *mode,
                    recursive: *recursive,
                }))
            }
            Op::Mkdtemp { prefix } => {
                let resolved = resolve_create(prefix, syscall)?;
                // The created name is unknown at submit time; the authority is the directory the
                // prefix names (or its parent when the prefix ends in a name segment).
                let directory = if prefix
                    .as_os_str()
                    .to_string_lossy()
                    .ends_with(std::path::MAIN_SEPARATOR)
                {
                    resolved.clone()
                } else {
                    resolved
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| resolved.clone())
                };
                self.check_path(Capability::FsWrite, &directory)?;
                Ok(Some(Op::Mkdtemp { prefix: resolved }))
            }
            Op::Readdir { path, with_types } => {
                let resolved = resolve_read(path, syscall, true)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::Readdir {
                    path: resolved,
                    with_types: *with_types,
                }))
            }
            Op::Rm {
                path,
                recursive,
                force,
                max_retries,
                retry_delay_ms,
            } => {
                let resolved = resolve_link(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Rm {
                    path: resolved,
                    recursive: *recursive,
                    force: *force,
                    max_retries: *max_retries,
                    retry_delay_ms: *retry_delay_ms,
                }))
            }
            Op::Rmdir { path } => {
                let resolved = resolve_link(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Rmdir { path: resolved }))
            }
            Op::Unlink { path } => {
                let resolved = resolve_link(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Unlink { path: resolved }))
            }
            Op::Rename { from, to } => {
                let from = resolve_link(from, syscall)?;
                let to = resolve_create(to, syscall)?;
                self.check_path(Capability::FsWrite, &from)?;
                self.check_path(Capability::FsWrite, &to)?;
                Ok(Some(Op::Rename { from, to }))
            }
            Op::Stat { path, follow } => {
                let resolved = resolve_read(path, syscall, *follow)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::Stat {
                    path: resolved,
                    follow: *follow,
                }))
            }
            Op::Statfs { path } => {
                let resolved = resolve_read(path, syscall, true)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::Statfs { path: resolved }))
            }
            Op::Access { path, mode } => {
                let resolved = resolve_read(path, syscall, true)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::Access {
                    path: resolved,
                    mode: *mode,
                }))
            }
            Op::Chmod { path, mode, follow } => {
                let resolved = resolve_read(path, syscall, *follow)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Chmod {
                    path: resolved,
                    mode: *mode,
                    follow: *follow,
                }))
            }
            Op::Chown {
                path,
                uid,
                gid,
                follow,
            } => {
                let resolved = resolve_read(path, syscall, *follow)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Chown {
                    path: resolved,
                    uid: *uid,
                    gid: *gid,
                    follow: *follow,
                }))
            }
            Op::Truncate { path, len } => {
                let resolved = resolve_read(path, syscall, true)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Truncate {
                    path: resolved,
                    len: *len,
                }))
            }
            Op::Readlink { path } => {
                let resolved = resolve_link(path, syscall)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::Readlink { path: resolved }))
            }
            Op::Symlink { target, path } => {
                let resolved = resolve_create(path, syscall)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Symlink {
                    target: target.clone(),
                    path: resolved,
                }))
            }
            Op::Link { existing, new_path } => {
                let existing = resolve_link(existing, syscall)?;
                let new_path = resolve_create(new_path, syscall)?;
                self.check_path(Capability::FsWrite, &existing)?;
                self.check_path(Capability::FsWrite, &new_path)?;
                Ok(Some(Op::Link { existing, new_path }))
            }
            Op::Realpath { path } => {
                let resolved = resolve_read(path, syscall, true)?;
                self.check_path(Capability::FsRead, &resolved)?;
                Ok(Some(Op::Realpath { path: resolved }))
            }
            Op::Utimes {
                path,
                atime_ms,
                mtime_ms,
                follow,
            } => {
                let resolved = resolve_read(path, syscall, *follow)?;
                self.check_path(Capability::FsWrite, &resolved)?;
                Ok(Some(Op::Utimes {
                    path: resolved,
                    atime_ms: *atime_ms,
                    mtime_ms: *mtime_ms,
                    follow: *follow,
                }))
            }
            Op::Open { path, flags, mode } => {
                let write = flags & write_mask() != 0;
                let read = flags & libc::O_ACCMODE != libc::O_WRONLY;
                let create = flags & libc::O_CREAT != 0;
                let resolved = if create {
                    resolve_create(path, syscall)?
                } else {
                    resolve_read(path, syscall, true)?
                };
                if write {
                    self.check_path(Capability::FsWrite, &resolved)?;
                    // `O_CREAT` additionally checks the parent directory (ADR-0011 §5.5): a grant
                    // on the file alone does not confer the authority to create it.
                    if create {
                        if let Some(parent) = resolved.parent() {
                            self.check_path(Capability::FsWrite, parent)?;
                        }
                    }
                }
                if read {
                    self.check_path(Capability::FsRead, &resolved)?;
                }
                Ok(Some(Op::Open {
                    path: resolved,
                    flags: *flags,
                    mode: *mode,
                }))
            }
            Op::Fstat { fd } | Op::Fsync { fd } | Op::Fdatasync { fd } | Op::Close { fd } => {
                self.check_fd(*fd, FdNeed::Any)?;
                Ok(None)
            }
            Op::Read { fd, .. } => {
                self.check_fd(*fd, FdNeed::Read)?;
                Ok(None)
            }
            Op::Write { fd, .. } => {
                self.check_fd(*fd, FdNeed::Write)?;
                Ok(None)
            }
            Op::Ftruncate { fd, .. }
            | Op::Fchmod { fd, .. }
            | Op::Fchown { fd, .. }
            | Op::Futimes { fd, .. } => {
                self.check_fd(*fd, FdNeed::Write)?;
                Ok(None)
            }
            Op::Lookup { host, .. } => {
                // A literal address needs no grant: there is no name to resolve (ADR-0011 §5.3).
                if host.parse::<std::net::IpAddr>().is_err() {
                    self.check(&Request::Host { host })?;
                }
                Ok(None)
            }
        }
    }

    fn check_path(&self, capability: Capability, resolved: &Path) -> Result<(), NodeError> {
        self.check(&Request::Path {
            capability,
            resolved,
        })
    }
}

/// The write bits of `open`'s flags. This is a mask, not `O_ACCMODE`: `O_RDONLY | O_CREAT` creates
/// a file and therefore needs write authority (ADR-0011 §5.5).
fn write_mask() -> i32 {
    libc::O_WRONLY | libc::O_RDWR | libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND
}

/// Resolve an existing path for a check. `follow` chooses between `realpath` and resolving the
/// parent while keeping the final component (the link itself), which is what `lstat`/`chmod` with
/// `follow: false` act on.
pub(crate) fn resolve_read(
    path: &Path,
    syscall: &'static str,
    follow: bool,
) -> Result<PathBuf, NodeError> {
    if follow {
        fs::canonicalize(path).map_err(|error| io_error(error, syscall, path))
    } else {
        resolve_link(path, syscall)
    }
}

fn resolve_link(path: &Path, syscall: &'static str) -> Result<PathBuf, NodeError> {
    let Some(name) = path.file_name() else {
        return fs::canonicalize(path).map_err(|error| io_error(error, syscall, path));
    };
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let parent = fs::canonicalize(parent).map_err(|error| io_error(error, syscall, path))?;
    Ok(parent.join(name))
}

/// Resolve a path that may not exist yet: canonicalise the deepest existing ancestor and append the
/// rest, refusing a symlink among the appended components (ADR-0011 §4.7).
pub(crate) fn resolve_create(path: &Path, syscall: &'static str) -> Result<PathBuf, NodeError> {
    if let Ok(resolved) = fs::canonicalize(path) {
        return Ok(resolved);
    }
    let mut ancestor = path.to_path_buf();
    let mut rest: Vec<OsString> = Vec::new();
    let canonical = loop {
        match fs::canonicalize(&ancestor) {
            Ok(resolved) => break resolved,
            Err(error) => {
                let Some(name) = ancestor.file_name().map(OsString::from) else {
                    return Err(io_error(error, syscall, path));
                };
                let parent = match ancestor.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
                    _ => PathBuf::from("."),
                };
                if parent == ancestor {
                    return Err(io_error(error, syscall, path));
                }
                rest.push(name);
                ancestor = parent;
            }
        }
    };
    let mut resolved = canonical;
    for part in rest.iter().rev() {
        resolved.push(part);
        if let Ok(metadata) = fs::symlink_metadata(&resolved) {
            if metadata.file_type().is_symlink() {
                return Err(NodeError::access_denied(
                    "fs.write",
                    resolved.display().to_string(),
                    "a symlink sits below the granted path",
                ));
            }
        }
    }
    Ok(resolved)
}

/// Filter resolved TCP candidates against the policy. Denied candidates are skipped; when every
/// candidate is denied the run fails with a denial, not the last connection error (ADR-0011 §5.3).
#[cfg(feature = "net")]
pub(crate) fn allowed_endpoints(
    permit: &Permit,
    capability: Capability,
    host: Option<&str>,
    port: u16,
    addresses: Vec<std::net::SocketAddr>,
) -> Result<Vec<std::net::SocketAddr>, NodeError> {
    if !permit.enforced() {
        return Ok(addresses);
    }
    let mut allowed = Vec::new();
    let mut denial = None;
    for address in addresses {
        match permit.check(&Request::Endpoint {
            capability,
            host,
            port,
            address: Some(&address),
        }) {
            Ok(()) => allowed.push(address),
            Err(error) => denial = Some(error),
        }
    }
    if allowed.is_empty() {
        Err(denial.unwrap_or_else(|| {
            NodeError::new("ERR_ACCESS_DENIED", "no endpoint candidate is permitted")
        }))
    } else {
        Ok(allowed)
    }
}

fn io_error(error: io::Error, syscall: &'static str, path: &Path) -> NodeError {
    match error.raw_os_error() {
        Some(errno) => NodeError::from_errno(errno, syscall, Some(path)),
        None => NodeError::system(&error, syscall, path),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn an_unconfined_permit_allows_every_descriptor() {
        let permit = Permit::unconfined();
        assert!(permit.check_fd(99, FdNeed::Write).is_ok());
        assert!(permit.knows_fd(99));
    }

    #[test]
    fn a_confined_table_seeds_stdio_and_checks_the_mode() {
        let permit = Permit::new(Policy::deny_all());
        permit.seed_fd(0, FdMode::READ);
        permit.seed_fd(1, FdMode::WRITE);
        permit.seed_fd(2, FdMode::WRITE);

        assert!(permit.check_fd(1, FdNeed::Write).is_ok());
        assert!(permit.check_fd(1, FdNeed::Any).is_ok());
        assert!(permit.check_fd(1, FdNeed::Read).is_err());
        assert!(permit.check_fd(42, FdNeed::Any).is_err());
    }

    #[test]
    fn an_open_records_the_mode_and_close_forgets_it() {
        let permit = Permit::new(Policy::deny_all());
        let read_only = Permit::new(Policy::deny_all());
        read_only.note_open(3, libc::O_RDONLY);
        assert!(read_only.check_fd(3, FdNeed::Read).is_ok());
        assert!(read_only.check_fd(3, FdNeed::Write).is_err());

        // `O_RDONLY | O_CREAT` creates a file: write authority, even though the access mode is
        // read-only.
        permit.note_open(4, libc::O_RDONLY | libc::O_CREAT);
        assert!(permit.check_fd(4, FdNeed::Write).is_ok());
        assert!(permit.check_fd(4, FdNeed::Read).is_ok());

        permit.note_close(4);
        assert!(!permit.knows_fd(4));
        assert!(permit.check_fd(4, FdNeed::Any).is_err());
    }

    #[test]
    fn close_then_reuse_is_a_new_entry() {
        let permit = Permit::new(Policy::deny_all());
        permit.seed_fd(0, FdMode::READ);
        permit.note_close(0);
        assert!(permit.check_fd(0, FdNeed::Any).is_err());
        permit.note_open(0, libc::O_WRONLY);
        assert!(permit.check_fd(0, FdNeed::Write).is_ok());
        assert!(permit.check_fd(0, FdNeed::Read).is_err());
    }
}
