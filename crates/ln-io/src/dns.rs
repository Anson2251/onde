//! `dns.lookup`: the OS resolver as an op, not a handle.
//!
//! `dns.lookup` is bounded work with exactly one result, so it stays an [`Op`](crate::Op)
//! (m4-plan §2.6): `Op::Lookup` runs on the blocking pool, where a synchronous `getaddrinfo` is
//! correct, and settles one `OpValue::Addrs`. `dns.resolve*` (which needs a DNS client, not the OS
//! resolver) stays out of M4.
//!
//! This module is deliberately not under `net`: a `net`-less build still has `Op::Lookup`, so the
//! resolver and the two error helpers it uses live in always-compiled code.

use std::io;
use std::net::ToSocketAddrs;

use ln_error::NodeError;

use crate::addr::{family_matches, Addr, IpFamily};
use crate::OpValue;

/// libuv's errno for `ENOTFOUND` (`UV_ENOTFOUND` in `uv.h`).
pub(crate) const ERRNO_ENOTFOUND: i32 = -3008;
/// libuv's errno for `EAI_AGAIN` (`UV_EAI_AGAIN`).
pub(crate) const ERRNO_EAI_AGAIN: i32 = -3004;
/// libuv's errno for `EAI_FAIL` (`UV_EAI_FAIL`).
pub(crate) const ERRNO_EAI_FAIL: i32 = -3005;

/// Resolve `host` for `dns.lookup(host, { family, all })`.
///
/// `all: false` returns the first matching address, like Node's default single-result form. The
/// returned [`Addr::Ip`] values carry port `0`: `dns.lookup` reports addresses, not endpoints, and
/// the JS layer attaches the port when it builds a connection target.
pub(crate) fn lookup(host: &str, family: IpFamily, all: bool) -> Result<OpValue, NodeError> {
    if host.is_empty() {
        return Err(not_found(host));
    }
    let resolved = (host, 0u16)
        .to_socket_addrs()
        .map_err(|error| resolve_error(host, &error))?;

    let mut addresses: Vec<Addr> = Vec::new();
    for address in resolved {
        if !family_matches(address.ip(), family) {
            continue;
        }
        addresses.push(Addr::Ip(address));
        if !all {
            break;
        }
    }
    if addresses.is_empty() {
        // The host resolved to addresses, but none of the requested family; Node reports
        // ENOTFOUND for that too.
        return Err(not_found(host));
    }
    Ok(OpValue::Addrs(addresses))
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
        denial: None,
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
    fn an_empty_host_is_enotfound_without_calling_the_resolver() {
        let error = lookup("", IpFamily::Either, false).expect_err("empty host");
        assert_eq!(error.code, "ENOTFOUND");
        assert_eq!(error.syscall, Some("getaddrinfo"));
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
