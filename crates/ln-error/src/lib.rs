//! The Node error model, shared by `ln-io`, `ln-crypto` and `ln-runtime`.
//!
//! One Rust type crosses every boundary. `ln-runtime` converts it into a JS `Error` with the
//! `code`, `errno`, `syscall` and `path` properties Node exposes, using [`NodeError::name`] for
//! the constructor (`TypeError`/`RangeError`/`Error`) and [`NodeError::message`] as the JS
//! message. System errors keep Node's shape: the message itself starts with the code
//! (`ENOENT: no such file or directory, open '/x'`); coded `TypeError`s do not (Node puts the
//! code in the stack header, which the renderer adds from `code`).
//!
//! This crate must stay dependency-free and engine-free: it is the lowest layer of the graph.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

/// A Node-shaped error, ready to be turned into a JS error on the isolate thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeError {
    /// `ENOENT`, `ERR_INVALID_ARG_TYPE`, `ABORT_ERR`, ...
    pub code: &'static str,
    /// The JS constructor: `"Error"`, `"TypeError"`, `"RangeError"`, `"AbortError"`.
    pub name: &'static str,
    /// The JS `message`, without a `CODE:` prefix for coded argument errors.
    pub message: String,
    pub syscall: Option<&'static str>,
    pub path: Option<PathBuf>,
    /// Raw OS errno when the error came from a syscall.
    pub errno: Option<i32>,
    pub cause: Option<Box<NodeError>>,
}

impl NodeError {
    /// A coded error with an explicit message (no syscall/path/errno).
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            name: "Error",
            message: message.into(),
            syscall: None,
            path: None,
            errno: None,
            cause: None,
        }
    }

    /// A system error from a failed syscall: code and message from `errno`, Node's
    /// `CODE: description, syscall 'path'` message, all properties set.
    pub fn system(err: &io::Error, syscall: &'static str, path: impl AsRef<Path>) -> Self {
        match err.raw_os_error() {
            Some(errno) => Self::from_errno(errno, syscall, Some(path.as_ref())),
            None => Self::from_parts(
                "UNKNOWN",
                "unknown error",
                syscall,
                Some(path.as_ref()),
                None,
            ),
        }
    }

    /// A system error from a raw errno (for `libc` calls that do not produce `io::Error`).
    pub fn from_errno(errno: i32, syscall: &'static str, path: Option<&Path>) -> Self {
        Self::from_parts(
            errno_code(errno),
            errno_message(errno),
            syscall,
            path,
            Some(errno),
        )
    }

    fn from_parts(
        code: &'static str,
        description: &'static str,
        syscall: &'static str,
        path: Option<&Path>,
        errno: Option<i32>,
    ) -> Self {
        // Node/libuv's shape: `ENOENT: no such file or directory, open '/x'`, and
        // `EBADF: bad file descriptor, close` when the syscall has no path.
        let mut message = format!("{code}: {description}, {syscall}");
        if let Some(path) = path {
            message.push_str(" '");
            message.push_str(&path.display().to_string());
            message.push('\'');
        }
        Self {
            code,
            name: "Error",
            message,
            syscall: Some(syscall),
            path: path.map(Path::to_path_buf),
            errno,
            cause: None,
        }
    }

    /// `ERR_INVALID_ARG_TYPE`, `name` is `TypeError`.
    ///
    /// `expected` follows Node's internal formatter: a type name or phrase (`"string"`,
    /// `"string or an instance of Buffer or URL"`, `"an instance of Buffer, TypedArray, or
    /// DataView"`), or an already-complete `must ...` clause. `actual` is the inspected value
    /// (Node's `determineSpecificType` output, e.g. `"type number (1)"`, `"null"`).
    pub fn invalid_arg_type(argument: &str, expected: &str, actual: &str) -> Self {
        let kind = if argument.contains('.') {
            "property"
        } else {
            "argument"
        };
        let clause = if expected.starts_with("must ") {
            expected.to_string()
        } else if expected.starts_with("an instance of ")
            || expected.starts_with("one of ")
            || expected.starts_with("an ")
        {
            format!("must be {expected}")
        } else if expected == "Object" {
            "must be an instance of Object".to_string()
        } else {
            format!("must be of type {expected}")
        };
        let message = if argument.ends_with(" argument") {
            // Node special-cases names like `first argument`: no quotes, no extra noun.
            format!("The {argument} {clause}. Received {actual}")
        } else {
            format!("The \"{argument}\" {kind} {clause}. Received {actual}")
        };
        Self::coded("ERR_INVALID_ARG_TYPE", "TypeError", message)
    }

    /// `ERR_INVALID_ARG_VALUE`, `name` is `TypeError`.
    ///
    /// `value` is the already-inspected value (`"'bogus'"`, `1`, `"{}"`); `reason` is Node's
    /// predicate (`"is invalid"`, `"is invalid encoding"`, ...).
    pub fn invalid_arg_value(argument: &str, value: &str, reason: &str) -> Self {
        let kind = if argument.contains('.') {
            "property"
        } else {
            "argument"
        };
        let inspected = if value.chars().count() > 128 {
            let truncated: String = value.chars().take(128).collect();
            format!("{truncated}...")
        } else {
            value.to_string()
        };
        Self::coded(
            "ERR_INVALID_ARG_VALUE",
            "TypeError",
            format!("The {kind} '{argument}' {reason}. Received {inspected}"),
        )
    }

    /// `ERR_OUT_OF_RANGE`, `name` is `RangeError`.
    ///
    /// `range` is Node's predicate (`">= 0 && <= 4294967295"`, `"an integer"`); `value` is the
    /// already-inspected value.
    pub fn out_of_range(argument: &str, range: &str, value: &str) -> Self {
        Self::coded(
            "ERR_OUT_OF_RANGE",
            "RangeError",
            format!(
                "The value of \"{argument}\" is out of range. It must be {range}. Received {value}"
            ),
        )
    }

    /// `ABORT_ERR`, name `AbortError`.
    pub fn aborted() -> Self {
        Self {
            code: "ABORT_ERR",
            name: "AbortError",
            message: "The operation was aborted".to_string(),
            syscall: None,
            path: None,
            errno: None,
            cause: None,
        }
    }

    fn coded(code: &'static str, name: &'static str, message: String) -> Self {
        Self {
            code,
            name,
            message,
            syscall: None,
            path: None,
            errno: None,
            cause: None,
        }
    }

    pub fn with_cause(mut self, cause: NodeError) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    pub fn is_aborted(&self) -> bool {
        self.code == "ABORT_ERR"
    }
}

impl fmt::Display for NodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NodeError {}

/// The errno table used by macOS and Linux. Every entry exists in `libc` on both platforms;
/// the platform-only spellings (`EOPNOTSUPP` on macOS) are added by [`lookup`].
#[cfg(unix)]
const COMMON_ERRNOS: &[(i32, &str, &str)] = &[
    (libc::ENOENT, "ENOENT", "no such file or directory"),
    (libc::EACCES, "EACCES", "permission denied"),
    (libc::EPERM, "EPERM", "operation not permitted"),
    (libc::EEXIST, "EEXIST", "file already exists"),
    (libc::ENOTDIR, "ENOTDIR", "not a directory"),
    (libc::EISDIR, "EISDIR", "is a directory"),
    (libc::ENOTEMPTY, "ENOTEMPTY", "directory not empty"),
    (libc::ELOOP, "ELOOP", "too many symbolic links encountered"),
    (libc::ENAMETOOLONG, "ENAMETOOLONG", "file name too long"),
    (libc::EMFILE, "EMFILE", "too many open files"),
    (libc::ENFILE, "ENFILE", "too many open files in system"),
    (libc::ENOSPC, "ENOSPC", "no space left on device"),
    (libc::EROFS, "EROFS", "read-only file system"),
    (libc::EXDEV, "EXDEV", "cross-device link not permitted"),
    (libc::EBUSY, "EBUSY", "resource busy or locked"),
    (libc::ETXTBSY, "ETXTBSY", "text file busy"),
    (libc::EINVAL, "EINVAL", "invalid argument"),
    (libc::EIO, "EIO", "i/o error"),
    (libc::EFAULT, "EFAULT", "bad address"),
    (libc::ENODEV, "ENODEV", "no such device"),
    (libc::ENOBUFS, "ENOBUFS", "no buffer space available"),
    (libc::ENOMEM, "ENOMEM", "not enough memory"),
    (libc::EAGAIN, "EAGAIN", "resource temporarily unavailable"),
    (libc::EFBIG, "EFBIG", "file too large"),
    (libc::EPIPE, "EPIPE", "broken pipe"),
    (libc::ESPIPE, "ESPIPE", "invalid seek"),
    (libc::ENOSYS, "ENOSYS", "function not implemented"),
    (libc::ENOTSUP, "ENOTSUP", "operation not supported"),
    (libc::EBADF, "EBADF", "bad file descriptor"),
];

#[cfg(unix)]
fn lookup(errno: i32) -> Option<(&'static str, &'static str)> {
    if let Some((_, code, message)) = COMMON_ERRNOS.iter().find(|(value, _, _)| *value == errno) {
        return Some((code, message));
    }
    // macOS spells "operation not supported" a second way; on Linux the two constants are
    // equal, so the entry lives only here to avoid a duplicate in the table.
    #[cfg(target_os = "macos")]
    if errno == libc::EOPNOTSUPP {
        return Some(("ENOTSUP", "operation not supported"));
    }
    None
}

#[cfg(not(unix))]
fn lookup(_errno: i32) -> Option<(&'static str, &'static str)> {
    None
}

/// Map a raw errno to Node's code (`ENOENT`, `EACCES`, ...). Unmapped errnos become `"UNKNOWN"`.
pub fn errno_code(errno: i32) -> &'static str {
    lookup(errno).map_or("UNKNOWN", |(code, _)| code)
}

/// The lowercase description Node/libuv prints for an errno (`no such file or directory`).
pub fn errno_message(errno: i32) -> &'static str {
    lookup(errno).map_or("unknown error", |(_, message)| message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errno_maps_the_common_codes() {
        assert_eq!(errno_code(libc::ENOENT), "ENOENT");
        assert_eq!(errno_message(libc::ENOENT), "no such file or directory");
        assert_eq!(errno_code(libc::EACCES), "EACCES");
        assert_eq!(errno_message(libc::EACCES), "permission denied");
        assert_eq!(errno_code(libc::EPERM), "EPERM");
        assert_eq!(errno_message(libc::EPERM), "operation not permitted");
        assert_eq!(errno_code(libc::EEXIST), "EEXIST");
        assert_eq!(errno_message(libc::EEXIST), "file already exists");
        assert_eq!(errno_code(libc::EISDIR), "EISDIR");
        assert_eq!(errno_message(libc::EISDIR), "is a directory");
        assert_eq!(errno_code(libc::ELOOP), "ELOOP");
        assert_eq!(
            errno_message(libc::ELOOP),
            "too many symbolic links encountered"
        );
        assert_eq!(errno_code(libc::ENAMETOOLONG), "ENAMETOOLONG");
        assert_eq!(errno_message(libc::ENAMETOOLONG), "file name too long");
        assert_eq!(errno_code(libc::ENOTSUP), "ENOTSUP");
        assert_eq!(errno_message(libc::ENOTSUP), "operation not supported");
        assert_eq!(errno_code(libc::EBADF), "EBADF");
        assert_eq!(errno_message(libc::EBADF), "bad file descriptor");
        assert_eq!(errno_code(libc::ENOSPC), "ENOSPC");
        assert_eq!(errno_message(libc::ENOSPC), "no space left on device");
    }

    #[test]
    fn unknown_errno_is_unknown() {
        assert_eq!(errno_code(123_456), "UNKNOWN");
        assert_eq!(errno_message(123_456), "unknown error");
    }

    #[test]
    fn system_message_matches_node_shape() {
        let error = io::Error::from_raw_os_error(libc::ENOENT);
        let error = NodeError::system(&error, "open", "/x");
        assert_eq!(error.name, "Error");
        assert_eq!(error.code, "ENOENT");
        assert_eq!(error.errno, Some(libc::ENOENT));
        assert_eq!(error.syscall, Some("open"));
        assert_eq!(error.path.as_deref(), Some(Path::new("/x")));
        assert_eq!(
            error.message,
            "ENOENT: no such file or directory, open '/x'"
        );
    }

    #[test]
    fn system_message_without_path_is_node_shape() {
        let error = NodeError::from_errno(libc::EBADF, "close", None);
        assert_eq!(error.message, "EBADF: bad file descriptor, close");
        assert_eq!(error.path, None);
        assert_eq!(error.syscall, Some("close"));
    }

    #[test]
    fn argument_errors_match_node_text() {
        let error = NodeError::invalid_arg_type(
            "path",
            "string or an instance of Buffer or URL",
            "type number (1)",
        );
        assert_eq!(error.name, "TypeError");
        assert_eq!(error.code, "ERR_INVALID_ARG_TYPE");
        assert_eq!(
            error.message,
            "The \"path\" argument must be of type string or an instance of Buffer or URL. \
             Received type number (1)"
        );

        let error =
            NodeError::invalid_arg_type("options.recursive", "boolean", "type string ('yes')");
        assert_eq!(
            error.message,
            "The \"options.recursive\" property must be of type boolean. \
             Received type string ('yes')"
        );

        let error = NodeError::invalid_arg_value("encoding", "'bogus'", "is invalid encoding");
        assert_eq!(
            error.message,
            "The argument 'encoding' is invalid encoding. Received 'bogus'"
        );

        let error = NodeError::out_of_range("length", ">= 0", "-1");
        assert_eq!(error.name, "RangeError");
        assert_eq!(error.code, "ERR_OUT_OF_RANGE");
        assert_eq!(
            error.message,
            "The value of \"length\" is out of range. It must be >= 0. Received -1"
        );
    }

    #[test]
    fn aborted_has_the_node_abort_shape() {
        let error = NodeError::aborted();
        assert_eq!(error.code, "ABORT_ERR");
        assert_eq!(error.name, "AbortError");
        assert_eq!(error.message, "The operation was aborted");
        assert!(error.is_aborted());
    }

    #[test]
    fn cause_and_display() {
        let error = NodeError::new("ERR_TEST", "outer").with_cause(NodeError::aborted());
        assert_eq!(error.cause.as_deref().map(|e| e.code), Some("ABORT_ERR"));
        assert!(!error.is_aborted());
        assert_eq!(error.to_string(), "outer");
    }
}
