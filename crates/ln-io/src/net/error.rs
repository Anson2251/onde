//! Socket and resolver errno → `NodeError`, with Node's codes and message shape.
//!
//! [`ln_error`]'s errno table is filesystem-shaped: the socket codes (`ECONNREFUSED`,
//! `ECONNRESET`, `EADDRINUSE`, ...) and the `getaddrinfo` failures (`ENOTFOUND`, `EAI_AGAIN`,
//! `EAI_FAIL`) are not in it. They live here until they move down to `ln-error`, so that every
//! error this module reports already carries the code and `syscall` Node's JS layer exposes
//! (see the WP1 report: `ln-error`'s table should grow these entries).
//!
//! Nothing in this file allocates per byte or touches a JS value: it is the error half of the
//! handle protocol's line discipline.

use std::io;
use std::path::Path;

use ln_error::NodeError;

/// libuv's errno for `ENOTFOUND` (`UV_ENOTFOUND` in `uv.h`).
pub(crate) const ERRNO_ENOTFOUND: i32 = -3008;
/// libuv's errno for `EAI_AGAIN` (`UV_EAI_AGAIN`).
pub(crate) const ERRNO_EAI_AGAIN: i32 = -3004;
/// libuv's errno for `EAI_FAIL` (`UV_EAI_FAIL`).
pub(crate) const ERRNO_EAI_FAIL: i32 = -3005;

/// Node's code and libuv description for the socket errnos `ln-error` does not carry yet.
fn socket_errno(errno: i32) -> Option<(&'static str, &'static str)> {
    Some(match errno {
        libc::ECONNREFUSED => ("ECONNREFUSED", "connection refused"),
        libc::ECONNRESET => ("ECONNRESET", "connection reset by peer"),
        libc::ECONNABORTED => ("ECONNABORTED", "software caused connection abort"),
        libc::ETIMEDOUT => ("ETIMEDOUT", "connection timed out"),
        libc::EADDRINUSE => ("EADDRINUSE", "address already in use"),
        libc::EADDRNOTAVAIL => ("EADDRNOTAVAIL", "address not available"),
        libc::ENETUNREACH => ("ENETUNREACH", "network is unreachable"),
        libc::EHOSTUNREACH => ("EHOSTUNREACH", "no route to host"),
        libc::EAFNOSUPPORT => (
            "EAFNOSUPPORT",
            "address family not supported by protocol family",
        ),
        libc::ENOTCONN => ("ENOTCONN", "socket is not connected"),
        libc::EISCONN => ("EISCONN", "socket is already connected"),
        _ => return None,
    })
}

fn errno_of(error: &io::Error) -> i32 {
    error.raw_os_error().unwrap_or(libc::EIO)
}

/// A failed socket syscall with no path or extra detail (`accept`, `read`, `write`, `shutdown`).
pub(crate) fn from_io(error: &io::Error, syscall: &'static str) -> NodeError {
    from_errno(errno_of(error), syscall, None, None)
}

/// A failed socket syscall naming a filesystem path (`connect` to a Unix socket).
pub(crate) fn from_io_at(error: &io::Error, syscall: &'static str, path: &Path) -> NodeError {
    from_errno(errno_of(error), syscall, None, Some(path))
}

/// A failed socket syscall naming a network endpoint: `connect 127.0.0.1:1234`, like Node's
/// `connect ECONNREFUSED 127.0.0.1:1234` but in `ln-error`'s `CODE: description, syscall ...`
/// shape so the whole crate's messages stay consistent.
pub(crate) fn from_io_detail(error: &io::Error, syscall: &'static str, detail: &str) -> NodeError {
    from_errno(errno_of(error), syscall, Some(detail), None)
}

/// Build the error for a raw errno, preferring `ln-error`'s table when it knows the value.
pub(crate) fn from_errno(
    errno: i32,
    syscall: &'static str,
    detail: Option<&str>,
    path: Option<&Path>,
) -> NodeError {
    if ln_error::errno_code(errno) != "UNKNOWN" {
        // One source of truth for the codes `ln-error` already models (ENOENT, EMFILE, EPIPE...).
        let mut error = NodeError::from_errno(errno, syscall, path);
        if let Some(detail) = detail {
            error.message.push(' ');
            error.message.push_str(detail);
        }
        return error;
    }

    let Some((code, description)) = socket_errno(errno) else {
        // Neither table knows it: keep Node's `UNKNOWN` shape rather than inventing a code.
        return NodeError::from_errno(errno, syscall, path);
    };
    let mut message = format!("{code}: {description}, {syscall}");
    if let Some(path) = path {
        message.push_str(&format!(" '{}'", path.display()));
    }
    if let Some(detail) = detail {
        message.push(' ');
        message.push_str(detail);
    }
    NodeError {
        code,
        name: "Error",
        message,
        syscall: Some(syscall),
        path: path.map(Path::to_path_buf),
        errno: Some(errno),
        cause: None,
    }
}

/// A `getaddrinfo` failure, in Node's `dns.lookup` shape: `code`, `errno`, `syscall:
/// "getaddrinfo"` and a message that starts with the code and names the host.
fn gai_error(host: &str, code: &'static str, errno: i32) -> NodeError {
    NodeError {
        code,
        name: "Error",
        message: format!("getaddrinfo {code} {host}"),
        syscall: Some("getaddrinfo"),
        path: None,
        errno: Some(errno),
        cause: None,
    }
}

/// `ENOTFOUND`: the host has no addresses, or none of the requested family.
pub(crate) fn not_found(host: &str) -> NodeError {
    gai_error(host, "ENOTFOUND", ERRNO_ENOTFOUND)
}

/// Classify a resolver failure.
///
/// `std`'s `ToSocketAddrs` collapses every `getaddrinfo` failure into one
/// `io::ErrorKind::Uncategorized` error whose message is `gai_strerror`'s text, so the EAI code
/// cannot be recovered exactly. The message is the only signal available: Node's `dns.lookup`
/// reports `ENOTFOUND` for "no such host" and `EAI_AGAIN` for a temporary resolver failure, and
/// anything else is `EAI_FAIL`. (`ln-io` deliberately does not reach for `libc::getaddrinfo`
/// here: the extra FFI and `addrinfo` walk would duplicate what `std` already does correctly.)
pub(crate) fn resolve_error(host: &str, error: &io::Error) -> NodeError {
    if error.kind() == io::ErrorKind::NotFound {
        return not_found(host);
    }
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("try again") || message.contains("temporary") {
        gai_error(host, "EAI_AGAIN", ERRNO_EAI_AGAIN)
    } else if message.contains("not known")
        || message.contains("no such host")
        || message.contains("does not resolve")
        || message.contains("nodename")
    {
        gai_error(host, "ENOTFOUND", ERRNO_ENOTFOUND)
    } else {
        gai_error(host, "EAI_FAIL", ERRNO_EAI_FAIL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_errnos_carry_node_codes() {
        let refused = from_errno(libc::ECONNREFUSED, "connect", Some("127.0.0.1:1"), None);
        assert_eq!(refused.code, "ECONNREFUSED");
        assert_eq!(refused.syscall, Some("connect"));
        assert_eq!(refused.errno, Some(libc::ECONNREFUSED));
        assert!(refused
            .message
            .starts_with("ECONNREFUSED: connection refused, connect"));
        assert!(refused.message.contains("127.0.0.1:1"));
        assert!(refused.path.is_none());

        assert_eq!(
            from_errno(libc::ECONNRESET, "read", None, None).code,
            "ECONNRESET"
        );
        assert_eq!(
            from_errno(libc::EADDRINUSE, "listen", None, None).code,
            "EADDRINUSE"
        );
    }

    #[test]
    fn errnos_ln_error_knows_keep_ln_errors_message() {
        // ENOENT is in `ln-error`'s table, so its exact `CODE: description, syscall 'path'`
        // message wins over this module's socket table.
        let error = from_errno(
            libc::ENOENT,
            "connect",
            None,
            Some(Path::new("/tmp/does-not-exist.sock")),
        );
        assert_eq!(error.code, "ENOENT");
        assert_eq!(
            error.message,
            "ENOENT: no such file or directory, connect '/tmp/does-not-exist.sock'"
        );
    }

    #[test]
    fn unknown_errnos_stay_unknown() {
        assert_eq!(from_errno(123_456, "read", None, None).code, "UNKNOWN");
    }

    #[test]
    fn resolver_failures_classify_to_node_codes() {
        let noname = io::Error::other("nodename nor servname provided, or not known");
        let error = resolve_error("no-such-host.invalid", &noname);
        assert_eq!(error.code, "ENOTFOUND");
        assert_eq!(error.syscall, Some("getaddrinfo"));
        assert_eq!(error.errno, Some(ERRNO_ENOTFOUND));
        assert_eq!(error.message, "getaddrinfo ENOTFOUND no-such-host.invalid");

        let again = io::Error::other("Temporary failure in name resolution");
        assert_eq!(resolve_error("x.invalid", &again).code, "EAI_AGAIN");

        let failed = io::Error::other("resolver exploded");
        assert_eq!(resolve_error("x.invalid", &failed).code, "EAI_FAIL");
    }
}
